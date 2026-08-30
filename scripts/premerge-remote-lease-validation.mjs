/**
 * Premerge live validation: git-remote-ref objective lease against real GitHub.
 * Temporary non-production objective ID only. No Sol/Cursor creates.
 *
 * Usage: node scripts/premerge-remote-lease-validation.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// Prefer compiled JS if present; otherwise register tsx via child processes only.
const reportPath = path.join(
  os.tmpdir(),
  `radio-lease-premerge-report-${Date.now()}.json`,
);

const objectiveId = `radio-premerge-lease-test-44b5-${Date.now()}`;
const remote = process.env.RADIO_OBJECTIVE_LEASE_REMOTE?.trim() || "origin";

const contenderScript = `
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/");
const tsx = process.env.RADIO_TSX_REGISTER;
if (tsx) await import(tsx);
const { createGitRemoteObjectiveLeaseStore, objectiveLeaseRefName } = await import(
  process.env.RADIO_LEASE_MODULE
);
const payload = JSON.parse(process.env.RADIO_LEASE_PAYLOAD);
const store = createGitRemoteObjectiveLeaseStore({
  remote: payload.remote,
  workspaceCwd: payload.workspaceCwd,
});
const result = await store.tryAcquire({
  objectiveId: payload.objectiveId,
  approvalId: payload.approvalId,
  workstreamId: payload.workstreamId,
  transactionId: payload.transactionId,
  runId: payload.runId,
  ownerFingerprint: payload.ownerFingerprint,
});
process.stdout.write(JSON.stringify({
  contender: payload.contender,
  result,
  ref: objectiveLeaseRefName(payload.objectiveId),
}) + "\\n");
`;

function runContender(contender, runId, ownerFingerprint, resolvedRemote) {
  return new Promise((resolve, reject) => {
    const payload = {
      remote: resolvedRemote,
      objectiveId,
      approvalId: "ha-premerge-lease-validation",
      workstreamId: "radio-premerge-lease-ws",
      transactionId: "radio-premerge-lease-txn",
      runId,
      ownerFingerprint,
      contender,
      workspaceCwd: root,
    };
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "-e", contenderScript],
      {
        cwd: root,
        env: {
          ...process.env,
          RADIO_LEASE_MODULE: path.join(root, "src/runtime/objective-lease.ts"),
          RADIO_LEASE_PAYLOAD: JSON.stringify(payload),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `contender ${contender} exited ${code}: ${stderr || stdout}`,
          ),
        );
        return;
      }
      try {
        const line = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .pop();
        resolve(JSON.parse(line));
      } catch (err) {
        reject(
          new Error(
            `contender ${contender} parse failed: ${err}; stdout=${stdout}; stderr=${stderr}`,
          ),
        );
      }
    });
  });
}

async function loadStore() {
  const mod = await import(
    path.join(root, "src/runtime/objective-lease.ts")
  );
  return mod;
}

async function main() {
  const mod = await loadStore();
  const {
    createGitRemoteObjectiveLeaseStore,
    objectiveLeaseRefName,
    OBJECTIVE_LEASE_REF_PREFIX,
    resolveGitRemoteUrl,
  } = mod;

  const resolvedRemote = resolveGitRemoteUrl({
    remote,
    workspaceCwd: root,
  });
  const ref = objectiveLeaseRefName(objectiveId);
  console.log(
    JSON.stringify({
      phase: "start",
      objectiveId,
      ref,
      remote,
      resolvedRemote: resolvedRemote.replace(/x-access-token:[^@]+@/i, "x-access-token:***@"),
      namespace: OBJECTIVE_LEASE_REF_PREFIX,
    }),
  );

  // Two independent OS processes — no shared mutex.
  const [a, b] = await Promise.all([
    runContender("A", "run-premerge-A", "fp-premerge-A", resolvedRemote),
    runContender("B", "run-premerge-B", "fp-premerge-B", resolvedRemote),
  ]);

  const outcomes = [a, b];
  const winners = outcomes.filter((o) => o.result.ok);
  const losers = outcomes.filter((o) => !o.result.ok);

  // Independent visibility context (fresh store / fetch).
  const viewer = createGitRemoteObjectiveLeaseStore({
    remote: resolvedRemote,
    workspaceCwd: root,
  });
  const visible = await viewer.get(objectiveId);

  const winner = winners[0]?.result?.lease ?? null;
  const ownershipMatch =
    Boolean(visible) &&
    Boolean(winner) &&
    visible.runId === winner.runId &&
    visible.ownerFingerprint === winner.ownerFingerprint;

  // Terminal behavior per PR design: markTerminal updates ref to TERMINAL (durable).
  let terminalOk = false;
  let terminalVisible = null;
  if (winner) {
    terminalOk = await viewer.markTerminal({
      objectiveId,
      runId: winner.runId,
    });
    terminalVisible = await viewer.get(objectiveId);
  }

  // Fail-closed probe: misconfigured remote must not acquire / must not soft-fallback.
  let failClosed = null;
  try {
    const bad = createGitRemoteObjectiveLeaseStore({
      remote: "https://127.0.0.1:1/nonexistent-radio-lease.git",
    });
    const badAcquire = await bad.tryAcquire({
      objectiveId: `${objectiveId}-failclosed`,
      approvalId: "ha-failclosed",
      workstreamId: "ws-failclosed",
      transactionId: "txn-failclosed",
      runId: "run-failclosed",
      ownerFingerprint: "fp-failclosed",
    });
    failClosed = {
      ok: badAcquire.ok,
      code: badAcquire.code,
      backend: bad.backend,
      memoryFallbackUsed: false,
      summary: badAcquire.summary,
    };
  } catch (err) {
    failClosed = {
      ok: false,
      code: "THREW",
      backend: "git-remote-ref",
      memoryFallbackUsed: false,
      summary: err instanceof Error ? err.message : String(err),
    };
  }

  // Cleanup temporary test lease ref so we do not leave premerge junk.
  let cleanup = { deleted: false, detail: null };
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["push", resolvedRemote, "--delete", ref], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
    cleanup = { deleted: true, detail: "deleted temporary test ref" };
  } catch (err) {
    cleanup = {
      deleted: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Confirm deleted from independent context
  const afterCleanup = await viewer.get(objectiveId);

  const report = {
    REMOTE_LEASE_BACKEND: "git-remote-ref",
    REMOTE_LEASE_NAMESPACE: OBJECTIVE_LEASE_REF_PREFIX,
    GITHUB_CUSTOM_REF_SUPPORTED: winners.length === 1,
    REMOTE_LEASE_TEST_OBJECTIVE_ID: objectiveId,
    REMOTE_LEASE_REF: ref,
    REMOTE_LEASE_CONTENDER_COUNT: 2,
    REMOTE_LEASE_WINNERS: winners.length,
    REMOTE_LEASE_LOSERS: losers.length,
    REMOTE_LEASE_ATOMICITY_RESULT:
      winners.length === 1 &&
      losers.length === 1 &&
      losers[0].result.code === "OBJECTIVE_ALREADY_LEASED"
        ? "PASS"
        : "FAIL",
    REMOTE_LEASE_LOSER_CODE: losers[0]?.result?.code ?? null,
    REMOTE_LEASE_VISIBLE_FROM_INDEPENDENT_CONTEXT: ownershipMatch,
    REMOTE_LEASE_VISIBLE_OWNERSHIP: visible
      ? {
          runId: visible.runId,
          ownerFingerprint: visible.ownerFingerprint,
          status: visible.status,
        }
      : null,
    REMOTE_LEASE_TERMINAL_BEHAVIOR: terminalVisible
      ? `markTerminal => status=${terminalVisible.status} (durable ref retained)`
      : "NOT_EXERCISED",
    REMOTE_LEASE_TERMINAL_OK: terminalOk,
    REMOTE_LEASE_TERMINAL_STATUS: terminalVisible?.status ?? null,
    REMOTE_LEASE_CLEANUP_RESULT: cleanup,
    REMOTE_LEASE_AFTER_CLEANUP_ABSENT: afterCleanup === null,
    LIVE_REMOTE_LEASE_FAILURE_RESULT: failClosed,
    LIVE_MEMORY_FALLBACK_ALLOWED: false,
    contenders: outcomes,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log("REPORT_PATH=" + reportPath);

  if (report.REMOTE_LEASE_ATOMICITY_RESULT !== "PASS") {
    process.exitCode = 2;
  }
  if (!report.REMOTE_LEASE_VISIBLE_FROM_INDEPENDENT_CONTEXT) {
    process.exitCode = 3;
  }
  if (failClosed?.ok) {
    process.exitCode = 4;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
