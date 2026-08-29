/**
 * Shared Phase 0 types. Canonical schemas remain authoritative;
 * these TypeScript types mirror the contracts for compile-time safety.
 */

export type RuntimeState =
  | "IDLE"
  | "PLANNING"
  | "IMPLEMENTING"
  | "WAITING_FOR_AGENT"
  | "VERIFYING"
  | "REVIEWING"
  | "REMEDIATING"
  | "READY_FOR_HUMAN"
  | "WAITING_FOR_HUMAN"
  | "ACCEPTED"
  | "BLOCKED";

export type DecisionKind =
  | "NO_ACTION"
  | "WAIT"
  | "LAUNCH_CURSOR"
  | "REUSE_CURSOR"
  | "REQUEST_HUMAN_APPROVAL"
  | "ACCEPT_WORKSTREAM"
  | "BLOCK_WORKSTREAM";

export type AgentAction =
  | "REUSE_CURRENT_AGENT"
  | "FRESH_ORDINARY_AGENT_REQUIRED"
  | "FRESH_API_CREATED_PARENT_AUTO_REQUIRED";

export type WorkType =
  | "PRECHECK"
  | "DESIGN"
  | "IMPLEMENTATION"
  | "VERIFICATION"
  | "REVIEW"
  | "REMEDIATION"
  | "RECOVERY"
  | "CLOSEOUT"
  | "REPORT_REPAIR";

export type PolicyResult = "ALLOW" | "REJECT" | "REQUIRE_HUMAN" | "NOOP";

export type Phase0TerminalVerdict =
  | "RADIO_PHASE0_DRY_RUN_COMPLETE"
  | "RADIO_PHASE0_POLICY_REJECTED"
  | "RADIO_PHASE0_HUMAN_REQUIRED"
  | "RADIO_PHASE0_BLOCKED";

export interface ProjectState {
  schemaVersion: number;
  radioVersion: string;
  stateRevision: number;
  stateUpdatedAt: string;
  project: {
    id: string;
    name: string;
    repository: string;
    projectContextPath: string;
    decisionLogPath: string;
    deferredBacklogPath: string;
  };
  canonicalState: {
    mainSha: string | null;
    mainBranch: string;
    lastKnownLiveDeployment: unknown;
  };
  historicalAcceptance: Record<string, unknown>;
  activeWorkstream: {
    id: string;
    name: string;
    status: string;
    terminalVerdict: string | null;
    priority: string;
    scopeGuard: string;
  } | null;
  currentTransaction: {
    id: string;
    type: string;
    status: string;
    branch: string | null;
    branchTipSha: string | null;
    sourceBaseBranch: string | null;
    sourceBaseTipSha: string | null;
    finalExecutableSha: string | null;
    evidenceTipSha: string | null;
    remediationBudget: number;
    remediationsUsed: number;
    remediationBudgetExhausted: boolean;
    recoverySequence: number;
    pr: Record<string, unknown>;
    review: Record<string, unknown>;
  } | null;
  nextTransaction: unknown;
  activeAgent: {
    agentId: string;
    status?: string;
    [key: string]: unknown;
  } | null;
  pendingHumanDecision: unknown;
  currentBlockers: unknown[];
  resolvedInCurrentRecovery: unknown[];
  deferredItems: Array<{
    id: string;
    name: string;
    status: string;
    resumeCondition: string;
  }>;
  authority: {
    humanApprovalRequiredFor: string[];
    autonomousActionsAllowed: string[];
    defaultRemediationBudgetPerTransaction: number;
    maxEquivalentActiveAgents: number;
  };
  agentPolicy: Record<string, unknown>;
  verificationPolicy: Record<string, unknown>;
  budgets: {
    maxRecoveriesPerWorkstream: number;
    maxCursorAgentsPerTransaction: number;
    maxSpecialistCallsPerTransaction: number;
    maxEstimatedUsdPerTransaction: number | null;
  };
  radioRuntime: {
    state: RuntimeState;
    lastEvent: string | null;
    lastError: string | null;
    activeWorkOrderId: string | null;
    activeTransactionId: string | null;
  };
  notes: string[];
}

export interface CursorInstruction {
  agentAction: AgentAction;
  workType: WorkType;
  objective: string;
  baseBranch: string | null;
  expectedStartingSha: string | null;
  prompt: string;
  expectedTerminalVerdicts: string[];
  maxRemediationPasses: number;
}

export interface OrchestratorDecision {
  schemaVersion: "1.0";
  decisionId: string;
  generatedAt: string;
  projectId: string;
  workstreamId: string | null;
  transactionId: string | null;
  decision: DecisionKind;
  reason: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  authority: {
    classification:
      | "AUTONOMOUS_ALLOWED"
      | "HUMAN_APPROVAL_REQUIRED"
      | "NO_ACTION_REQUIRED"
      | "BLOCKED_BY_POLICY";
    withinAutonomousAuthority: boolean;
    humanApprovalRequired: boolean;
    reason: string;
  };
  evidenceBasis: Array<{
    kind: string;
    ref: string;
    summary: string;
  }>;
  policyReferences: string[];
  blockers: Array<{
    id: string;
    severity: string;
    class: string;
    summary: string;
    requiresHumanJudgment: boolean;
  }>;
  stateTransition: {
    from: RuntimeState;
    to: RuntimeState;
    reason: string;
  };
  cursorInstruction: CursorInstruction | null;
  humanApproval: {
    approvalType: string;
    summary: string;
    requestedAction: string;
    risk: string;
    allowedChoices: string[];
  } | null;
  wait: {
    resumeOn: string;
    reason: string;
    activeAgentId: string | null;
    condition: string | null;
  } | null;
  terminal: {
    class: string;
    verdict: string;
    summary: string;
  } | null;
  proposedStateUpdates: {
    workstreamStatus: string | null;
    transactionStatus: string | null;
    terminalVerdict: string | null;
    pendingHumanDecisionType: string | null;
  };
}

export interface DecisionEnvelope {
  schemaVersion: "phase0-1.0";
  decisionId: string;
  projectId: string;
  workstreamId: string;
  transactionId: string;
  stateRevision: number;
  requestFingerprint: string;
  model: string;
  mode: "live" | "fixture";
  generatedAt: string;
  cursorExecutionEnabled: boolean;
  notes: string[];
}

export interface PolicyEvaluation {
  schemaVersion: "1.0";
  evaluationId: string;
  decisionId: string;
  evaluatedAt: string;
  result: PolicyResult;
  primaryCode: string;
  summary: string;
  triggeredRules: Array<{
    ruleId: string;
    outcome: "PASS" | "FAIL" | "INFO";
    message: string;
  }>;
  currentRuntimeState: RuntimeState;
  proposedRuntimeState: RuntimeState | null;
  executionPermitted: boolean;
  solShouldChooseAgain: boolean;
  humanInputRequired: boolean;
  requiredApprovalType: string | null;
  idempotencyKey: string | null;
  stateFingerprint: string;
}

export interface CursorWorkOrder {
  schemaVersion: "1.0";
  workOrderId: string;
  revision: number;
  createdAt: string;
  projectId: string;
  workstreamId: string;
  transactionId: string;
  decisionId: string;
  idempotencyKey: string;
  agentAction: AgentAction;
  workType: WorkType;
  objective: string;
  source: {
    repository: string;
    canonicalMainBranch: string;
    canonicalMainSha: string | null;
    baseBranch: string;
    expectedBaseTipSha: string | null;
    expectedExecutableAncestorSha: string | null;
    workingBranch: string | null;
    createWorkingBranch: boolean;
  };
  scope: {
    inScope: string[];
    outOfScope: string[];
    allowedProductChanges: string[];
    protectedSemantics: string[];
  };
  requirements: Array<{
    id: string;
    class: string;
    priority: string;
    statement: string;
    acceptanceMethod: string;
  }>;
  agentPlan: {
    bootstrapRequired: boolean;
    reuseAgentId: string | null;
    parent: null | Record<string, unknown>;
    specialists: unknown[];
    forbiddenAgentTypes: string[];
  };
  budgets: {
    maxRemediationPasses: number;
    maxSpecialistReviewCycles: number;
    maxAgents: number;
    maxEstimatedUsd: number | null;
  };
  verification: {
    requiredCommands: string[];
    historicalProvenanceRequired: boolean;
    browser: {
      required: boolean;
      method: string | null;
      criticalJourneysClickBound: boolean;
      assertPathnameAndSearch: boolean;
      viewports: unknown[];
      criteria: unknown[];
    };
    executableFreezeRequired: boolean;
    postExecutableDiffMustBeEmpty: boolean;
  };
  git: {
    protectedBranches: string[];
    pushRequired: boolean;
    forcePushAllowed: boolean;
    commitRequired: boolean;
  };
  pr: {
    creationAllowed: boolean;
    creationRequired: boolean;
    humanApprovalBeforeCreate: boolean;
    mergeAllowed: boolean;
  };
  completion: {
    allowedTerminalVerdicts: string[];
    requiredReportFields: string[];
    finalReportFormat: "EXACTLY_ONE_FENCED_TEXT_BLOCK_NOTHING_BEFORE_OR_AFTER";
  };
  stopConditions: Array<{
    id: string;
    condition: string;
    requiredOutcome: string;
  }>;
  rendering: {
    agentActionMustAppearNearTop: boolean;
    includeStructuredIdentity: boolean;
    includeSourcePins: boolean;
    includeScope: boolean;
    includeBudgets: boolean;
    includeStopConditions: boolean;
    includeCompletionContract: boolean;
  };
}

export interface Phase0Config {
  projectId: string;
  workstreamId: string;
  transactionId: string;
  model: string;
  cursorExecutionEnabled: boolean;
  mode: "live" | "fixture";
  fixturePath?: string;
  projectRoot: string;
}

export interface LoadedProjectBrain {
  state: ProjectState;
  fingerprint: string;
  projectContext: string;
  decisionLog: string;
  deferredBacklog: string;
  pilotPlan: string;
  pilotAcceptance: string;
}

export interface SolContext {
  system: string;
  user: string;
  vocabulary: string[];
  fingerprint: string;
  stateRevision: number;
}

export interface RunSummary {
  runId: string;
  projectId: string;
  stateRevision: number;
  stateFingerprint: string;
  model: string;
  mode: "live" | "fixture";
  decision: DecisionKind | null;
  policyOutcome: PolicyResult | null;
  agentAction: AgentAction | null;
  workType: WorkType | null;
  cursorExecutionEnabled: boolean;
  artifactPaths: Record<string, string>;
  terminalVerdict: Phase0TerminalVerdict;
}
