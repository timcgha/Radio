import fs from "node:fs";
import { evaluatePolicy } from "../src/runtime/../policy/engine.js";
import { loadProjectState } from "../src/state/store.js";
import { resolveRepoPath } from "../src/util/io.js";

const runDir = resolveRepoPath(
  "artifacts/runs/run-91ff8309-c3b6-42e8-badb-a00d947f4245",
);
const checkpoint = JSON.parse(
  fs.readFileSync(`${runDir}/phase3-checkpoint.json`, "utf8"),
);
const { state, fingerprint } = loadProjectState({
  projectId: "cyber-assurance",
  statePath: resolveRepoPath("projects/cyber-assurance/PROJECT-STATE.json"),
});
const envelope = {
  schemaVersion: "phase0-1.0",
  decisionId: checkpoint.pendingDecision.decisionId,
  projectId: "cyber-assurance",
  workstreamId: checkpoint.pendingDecision.workstreamId,
  transactionId: checkpoint.pendingDecision.transactionId,
  stateRevision: state.stateRevision,
  requestFingerprint: fingerprint,
  model: "gpt-5.6-sol",
  mode: "live",
  generatedAt: new Date().toISOString(),
  cursorExecutionEnabled: true,
  notes: [],
};
const policy = evaluatePolicy({
  decision: checkpoint.pendingDecision,
  state,
  envelope,
  currentFingerprint: fingerprint,
});
console.log(
  JSON.stringify(
    {
      budget: state.currentTransaction?.remediationBudget,
      exhausted: state.currentTransaction?.remediationBudgetExhausted,
      workType: checkpoint.pendingDecision.cursorInstruction?.workType,
      maxRemediationPasses:
        checkpoint.pendingDecision.cursorInstruction?.maxRemediationPasses,
      policyResult: policy.result,
      policyCode: policy.primaryCode,
      fingerprint,
    },
    null,
    2,
  ),
);
