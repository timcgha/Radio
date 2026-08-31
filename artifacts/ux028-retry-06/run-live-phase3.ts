/**
 * UX-028 retry-06 live Phase 3 orchestration entry (Cyber Assurance).
 * Runtime artifact — does not modify Radio source.
 */
import fs from "node:fs";
import path from "node:path";
import { runPhase3Loop } from "../../src/runtime/phase3.js";
import { ensureLedgerFile } from "../../src/runtime/transmitter.js";
import { newId, resolveRepoPath } from "../../src/util/io.js";

const ARTIFACT_ROOT = resolveRepoPath("artifacts", "ux028-retry-06");
const runId = newId("run");
const runDir = path.join(ARTIFACT_ROOT, "runs", runId);
fs.mkdirSync(runDir, { recursive: true });

const authorityPath = path.join(ARTIFACT_ROOT, "objective-authority.json");
const authorityWorkingPath = path.join(runDir, "objective-authority.json");
fs.copyFileSync(authorityPath, authorityWorkingPath);

const statePath = path.join(ARTIFACT_ROOT, "PROJECT-STATE.working.json");
const ledgerPath = path.join(runDir, "RUN-LEDGER.jsonl");
ensureLedgerFile(ledgerPath);

console.log("RADIO UX-028 RETRY-06 LIVE PHASE 3 START");
console.log(`runDir=${runDir}`);
console.log(`RADIO_MAIN=${process.env.RADIO_MAIN_SHA ?? "(check git rev-parse HEAD)"}`);

const result = await runPhase3Loop({
  projectId: "cyber-assurance",
  workstreamId: "cyber-assurance-wave1-vi-false-pass-recovery-06",
  transactionId: "cyber-assurance-wave1-vi-false-pass-recovery-tx-2026-08-31-06",
  model: "gpt-5.6-sol",
  mode: "live",
  objectiveAuthorityPath: authorityWorkingPath,
  statePath,
  ledgerPath,
  runDir,
  externalCursorAllowed: true,
  env: {
    ...process.env,
    RADIO_OBJECTIVE_LEASE_BACKEND: "git-remote-ref",
    RADIO_CURSOR_WORKER_MODEL: "composer-2.5",
  },
});

const summaryPath = path.join(runDir, "orchestration-result.json");
fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      runId: result.runId,
      terminalVerdict: result.terminalVerdict,
      runtimeState: result.runtimeState,
      stopReason: result.stopReason,
      iterations: result.iterations,
      cursorExecutionCount: result.cursorExecutionCount,
      solDecisionCount: result.solDecisionCount,
      status: result.status,
      artifactPaths: result.artifactPaths,
    },
    null,
    2,
  ),
);

console.log("");
console.log("=== ORCHESTRATION COMPLETE ===");
console.log(`terminalVerdict=${result.terminalVerdict}`);
console.log(`stopReason=${result.stopReason}`);
console.log(`cursorExecutionCount=${result.cursorExecutionCount}`);
console.log(`solDecisionCount=${result.solDecisionCount}`);
console.log(`summaryPath=${summaryPath}`);

if (
  result.terminalVerdict !== "RADIO_PHASE3_READY_FOR_HUMAN" &&
  result.terminalVerdict !== "RADIO_PHASE3_AUTONOMOUS_LOOP_READY"
) {
  process.exitCode = 1;
}
