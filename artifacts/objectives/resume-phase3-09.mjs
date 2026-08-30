import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const runDir = process.argv[2];
if (!runDir) {
  console.error("Usage: resume-phase3-09.mjs <runDir>");
  process.exit(2);
}

const { runPhase3Loop } = await import(
  pathToFileURL(path.resolve("src/runtime/phase3.ts")).href
);
const { STAGE2_PLAYTEST_APPROVAL_ID, loadObjectiveAuthority } = await import(
  pathToFileURL(path.resolve("src/runtime/objective-authority.ts")).href
);
const { defaultLedgerPath } = await import(
  pathToFileURL(path.resolve("src/state/ledger.ts")).href
);
const { resolveRepoPath } = await import(
  pathToFileURL(path.resolve("src/util/io.ts")).href
);

const authorityPath = path.join(runDir, "objective-authority.json");
const authority = loadObjectiveAuthority(authorityPath);
const statePath = resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json");
const ledgerPath = defaultLedgerPath("bellhop");

const result = await runPhase3Loop({
  projectId: "bellhop",
  workstreamId: authority.workstreamId,
  transactionId: authority.transactionId,
  model: process.env.RADIO_MODEL?.trim() || "gpt-5.6-sol",
  mode: "live",
  objectiveAuthorityPath: authorityPath,
  statePath,
  ledgerPath,
  runDir,
  resumeRunDir: runDir,
  foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
  externalCursorAllowed: true,
});

console.log(JSON.stringify({
  terminalVerdict: result.terminalVerdict,
  stopReason: result.stopReason,
  runtimeState: result.runtimeState,
  stateRevision: result.stateRevision,
  iterations: result.iterations,
  cursorExecutionCount: result.cursorExecutionCount,
  solDecisionCount: result.solDecisionCount,
  lastDecision: result.lastDecision?.decision ?? null,
  lastAgentId: result.state.activeAgent?.agentId ?? null,
}, null, 2));

fs.writeFileSync(
  path.join(runDir, "resume-result.json"),
  JSON.stringify(result, null, 2),
);
process.exitCode =
  result.terminalVerdict === "RADIO_PHASE3_WAITING_FOR_AGENT" ||
  result.terminalVerdict === "RADIO_PHASE3_READY_FOR_HUMAN" ||
  result.terminalVerdict === "RADIO_PHASE3_AUTONOMOUS_LOOP_READY" ||
  result.terminalVerdict === "RADIO_PHASE3_OBJECTIVE_COMPLETE"
    ? 0
    : 1;
