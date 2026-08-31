import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { resolveObjectiveCompletionRequirements } from "../src/runtime/completion-requirements.js";
import {
  loadObjectiveAuthority,
  validateObjectiveAuthorityForLiveEntry,
} from "../src/runtime/objective-authority.js";
import { prepareAcceptedBaselineForObjectiveStart } from "../src/runtime/phase3-objective-start.js";
import { resolveEffectiveRemediationBudget } from "../src/runtime/remediation-budget.js";
import { loadProjectState } from "../src/state/store.js";
import { getSchemaValidator, resolveRepoPath } from "../src/util/io.js";

const authorityPath = resolveRepoPath(
  "artifacts/retry-12/cyber-assurance-wave1-vi-narrow-remediation-12-objective-authority.json",
);
const statePath = resolveRepoPath("projects/cyber-assurance/PROJECT-STATE.json");
const authority = loadObjectiveAuthority(authorityPath);
const { state } = loadProjectState({ projectId: "cyber-assurance", statePath });
const liveEntry = validateObjectiveAuthorityForLiveEntry({ authority, state });
const prepared = prepareAcceptedBaselineForObjectiveStart({
  state,
  authority,
  statePath: statePath + ".dryrun",
});
const req = resolveObjectiveCompletionRequirements(authority);
const budget = resolveEffectiveRemediationBudget({
  permittedWorkTypes: authority.permittedWorkTypes,
  defaultRemediationBudgetPerTransaction:
    state.authority.defaultRemediationBudgetPerTransaction,
});
const decision = {
  schemaVersion: "1.0" as const,
  decisionId: "precheck",
  generatedAt: new Date().toISOString(),
  projectId: authority.projectId,
  workstreamId: authority.workstreamId,
  transactionId: authority.transactionId,
  decision: "LAUNCH_CURSOR" as const,
  reason: authority.summary,
  confidence: "HIGH" as const,
  authority: {
    classification: "AUTONOMOUS_ALLOWED" as const,
    withinAutonomousAuthority: true,
    humanApprovalRequired: false,
    reason: "precheck",
  },
  evidenceBasis: [],
  policyReferences: [],
  blockers: [],
  stateTransition: {
    from: "PLANNING" as const,
    to: "IMPLEMENTING" as const,
    reason: "precheck",
  },
  cursorInstruction: {
    agentAction: "FRESH_ORDINARY_AGENT_REQUIRED" as const,
    workType: "REMEDIATION" as const,
    objective: authority.summary,
    baseBranch: authority.baseBranch,
    expectedStartingSha: authority.expectedStartingSha,
    requestedWork: "precheck",
    verificationCriteria: "precheck",
    expectedTerminalVerdicts: ["UX_WAVE1_VERIFICATION_READY_FOR_REVIEW"],
    maxRemediationPasses: 1,
  },
  humanApproval: null,
  wait: null,
  terminal: null,
  proposedStateUpdates: {
    workstreamStatus: "IMPLEMENTING" as const,
    transactionStatus: "IMPLEMENTING" as const,
    terminalVerdict: null,
    pendingHumanDecisionType: null,
  },
};
const policy = evaluatePolicy({ state: prepared.state, decision, authority });
const workOrder = buildCursorWorkOrder({
  state: prepared.state,
  decision,
  policy,
  objectiveAuthority: authority,
});
const validateReport = getSchemaValidator("cursor-completion-report.schema.json");

console.log(
  JSON.stringify(
    {
      liveEntryOk: liveEntry.ok,
      remediationBudgetConfigured: budget === 1,
      remediationBudgetValue: budget,
      remediationBudgetExhaustedAtStart:
        prepared.state.currentTransaction?.remediationBudgetExhausted,
      remediationWorkTypeAuthorized:
        authority.permittedWorkTypes.includes("REMEDIATION"),
      completionRequirements: req,
      workOrderGit: workOrder.git,
      workOrderVerificationFreeze:
        workOrder.verification.executableFreezeRequired,
      workOrderEvidenceTip: workOrder.verification.evidenceTipRequired,
      schemaLoaded: Boolean(validateReport),
    },
    null,
    2,
  ),
);
