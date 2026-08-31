/**
 * Resume Retry-12 Phase 3 run after Radio policy remediation-budget fix.
 * Same runDir renews the ACTIVE git-remote objective lease.
 */
import {
  runPhase3Loop,
} from "../src/runtime/phase3.js";
import {
  resolveStrictLiveObjectiveLeaseStore,
} from "../src/runtime/phase3-strict-live-guard.js";
import { resolveRepoPath } from "../src/util/io.js";
import { defaultLedgerPath } from "../src/state/ledger.js";

const resumeRunDir = resolveRepoPath(
  "artifacts/runs/run-91ff8309-c3b6-42e8-badb-a00d947f4245",
);
const authorityPath = `${resumeRunDir}/objective-authority.json`;

async function main() {
  process.env.RADIO_OBJECTIVE_LEASE_BACKEND = "git-remote-ref";
  process.env.RADIO_CURSOR_WORKER_MODEL =
    process.env.RADIO_CURSOR_WORKER_MODEL?.trim() || "composer-2.5";
  process.env.CURSOR_EXECUTION_ENABLED = "true";

  const leaseStore = resolveStrictLiveObjectiveLeaseStore({
    env: process.env,
  });

  const result = await runPhase3Loop({
    projectId: "cyber-assurance",
    workstreamId: "cyber-assurance-wave1-vi-narrow-remediation-12",
    transactionId: "cyber-assurance-wave1-vi-narrow-remediation-tx-2026-08-31-12",
    model: process.env.RADIO_MODEL?.trim() || "gpt-5.6-sol",
    mode: "live",
    objectiveAuthorityPath: authorityPath,
    statePath: resolveRepoPath("projects/cyber-assurance/PROJECT-STATE.json"),
    ledgerPath: defaultLedgerPath("cyber-assurance"),
    resumeRunDir,
    objectiveLeaseStore: leaseStore,
    externalCursorAllowed: true,
  });

  console.log("");
  console.log("RADIO v0.1 — CYBER ASSURANCE PHASE 3 (RETRY-12 RESUME)");
  console.log("");
  console.log(`Mode: live`);
  console.log(`Iterations: ${result.iterations}`);
  console.log(`Cursor executions: ${result.cursorExecutionCount}`);
  console.log(`Sol decisions: ${result.solDecisionCount}`);
  console.log(`Runtime state: ${result.runtimeState}`);
  console.log(`Stop reason: ${result.stopReason}`);
  console.log("");
  console.log(result.terminalVerdict);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
