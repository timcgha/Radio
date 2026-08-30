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

export type Phase1TerminalVerdict =
  | "RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN"
  | "RADIO_PHASE1_DISPATCH_COMPLETE"
  | "RADIO_PHASE1_DISPATCH_WAITING"
  | "RADIO_PHASE1_RAW_RESULT_READY"
  | "RADIO_PHASE1_POLICY_REJECTED"
  | "RADIO_PHASE1_HUMAN_REQUIRED"
  | "RADIO_PHASE1_BLOCKED";

export type Phase2TerminalVerdict =
  | "RADIO_PHASE2_NEXT_ACTION_READY"
  | "RADIO_PHASE2_REPORT_INVALID"
  | "RADIO_PHASE2_RECONCILIATION_BLOCKED"
  | "RADIO_PHASE2_BLOCKED";

export type Phase3TerminalVerdict =
  | "RADIO_PHASE3_AUTONOMOUS_LOOP_READY"
  | "RADIO_PHASE3_READY_FOR_HUMAN"
  | "RADIO_PHASE3_WAITING_FOR_HUMAN"
  | "RADIO_PHASE3_WAITING_FOR_AGENT"
  | "RADIO_PHASE3_OBJECTIVE_COMPLETE"
  | "RADIO_PHASE3_BLOCKED"
  | "RADIO_PHASE3_BUDGET_EXHAUSTED"
  | "RADIO_PHASE3_ITERATION_LIMIT_REACHED"
  | "RADIO_PHASE3_POLICY_REJECTED"
  | "RADIO_PHASE3_INFRASTRUCTURE_BLOCKED"
  | "RADIO_PHASE3_INVALID_SOL_DECISION"
  | "RADIO_PHASE3_IMPLEMENTED_LIVE_NOT_RUN"
  | "RADIO_PHASE3_OBJECTIVE_ALREADY_LEASED";

/** Sol Phase 2 assessment — model interpretation of untrusted worker evidence. */
export type SolPhase2ResultClass = "PASS" | "FAIL" | "BLOCKED" | "UNKNOWN";
export type SolPhase2Confidence = "HIGH" | "MEDIUM" | "LOW";
export type StructuredWorkerReportStatusLabel =
  | "VALID"
  | "UNAVAILABLE_OR_INVALID"
  | "SCHEMA_INVALID"
  | "PROSE"
  | "JSON_PARSE_FAILED";

export interface SolPhase2Assessment {
  resultClass: SolPhase2ResultClass;
  confidence: SolPhase2Confidence;
  summary: string;
  materialFindings: string[];
  sourceIntegrityAssessment: string;
  requiresHumanJudgment: boolean;
  structuredWorkerReportStatus: StructuredWorkerReportStatusLabel;
}

export interface SolPhase2Continuation {
  assessment: SolPhase2Assessment;
  decision: OrchestratorDecision;
}

export type RecoveryTerminalVerdict =
  | "RADIO_INVALID_REPORT_RECOVERY_APPLIED"
  | "RADIO_INVALID_REPORT_RECOVERY_DENIED";

export type RadioTerminalVerdict =
  | Phase0TerminalVerdict
  | Phase1TerminalVerdict
  | Phase2TerminalVerdict
  | Phase3TerminalVerdict
  | RecoveryTerminalVerdict;

/** Human-authorized Phase 3 objective envelope (authority + hard budgets). */
export interface ObjectiveAuthority {
  schemaVersion: "phase3-1.0";
  objectiveId: string;
  approvalId: string;
  projectId: string;
  workstreamId: string;
  transactionId: string;
  summary: string;
  /**
   * Human-authorized dispatch base branch (trusted source pin).
   * Sol may echo this; Sol may not choose it.
   */
  baseBranch: string;
  /**
   * Human-authorized starting commit (trusted source pin).
   * Live Phase 3 requires a full 40-character Git SHA.
   * Sol may echo this; Sol may not choose it.
   */
  expectedStartingSha: string;
  permittedWorkTypes: WorkType[];
  prohibitedScope: string[];
  humanGatedActions: string[];
  maxIterations: number;
  maxCursorAgents: number;
  maxRetriesPerLogicalStep: number;
  maxCursorUsageTokens: number | null;
  /** Optional estimated spend ceiling; null = not enforced. */
  maxEstimatedSpend: number | null;
  stateRevisionBasis: number;
  createdAt: string;
  expiresAt: string | null;
  /** Set when the objective itself is closed/consumed. */
  consumed: boolean;
  accounting: {
    iterationsUsed: number;
    cursorAgentsUsed: number;
    retriesUsed: number;
    cursorUsageTokensUsed: number;
    estimatedSpendUsed: number;
  };
}

/** Machine-readable Phase 3 status for future mobile/web UX. */
export interface Phase3StatusSummary {
  schemaVersion: "phase3-status-1.0";
  objectiveId: string | null;
  objectiveSummary: string | null;
  /** Coarse UX status. */
  status:
    | "Working"
    | "Testing"
    | "Reviewing"
    | "Needs your decision"
    | "Completed"
    | "Blocked"
    | "Budget exhausted";
  currentPhase: "PHASE0" | "PHASE1" | "PHASE2" | "PHASE3";
  runtimeState: RuntimeState;
  workstreamId: string | null;
  transactionId: string | null;
  activeAgentId: string | null;
  activeRunId: string | null;
  iterationCount: number;
  maxIterations: number | null;
  cursorAgentsUsed: number;
  maxCursorAgents: number | null;
  retriesUsed: number;
  maxRetriesPerLogicalStep: number | null;
  budgetRemaining: {
    iterations: number | null;
    cursorAgents: number | null;
    retries: number | null;
  };
  lastMeaningfulEvent: string | null;
  humanActionRequired: boolean;
  humanQuestion: string | null;
  previewOrResultLink: string | null;
  terminalReason: Phase3TerminalVerdict | null;
}

export interface Phase3Config {
  projectId: string;
  workstreamId: string;
  transactionId: string;
  model: string;
  mode: "live" | "fixture";
  /** Fixture path: structural mocks only; never live APIs. */
  phase3Fixture: boolean;
  /** Real entrypoint present but must not auto-infer Stage 3 authority. */
  phase3Live: boolean;
  objectiveAuthorityPath: string;
  initialDecisionFixturePath?: string;
  /** Ordered Sol continuation fixtures for each completed execution (fixture mode). */
  continuationDecisionFixturePaths?: string[];
  /** Ordered raw Cursor results for each launch (fixture mode). */
  cursorRawResultSequence?: string[];
  statePath?: string;
  ledgerPath?: string;
  projectRoot: string;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  /** Optional injected Cursor client (tests / fixture). */
  cursorClient?: unknown;
  /** Resume from an existing Phase 3 working directory. */
  resumeRunDir?: string;
}

export type RunLedgerEventType =
  | "PROJECT_STATE_CREATED"
  | "PROJECT_STATE_UPDATED"
  | "WORKSTREAM_CREATED"
  | "WORKSTREAM_STATUS_CHANGED"
  | "TRANSACTION_CREATED"
  | "TRANSACTION_STATUS_CHANGED"
  | "SOL_DECISION_REQUESTED"
  | "SOL_DECISION_RECEIVED"
  | "SOL_DECISION_SCHEMA_REJECTED"
  | "POLICY_EVALUATION_STARTED"
  | "POLICY_EVALUATION_COMPLETED"
  | "POLICY_REJECTED_SOL_DECISION"
  | "WORK_ORDER_CREATED"
  | "WORK_ORDER_REVISED"
  | "CURSOR_AGENT_CREATE_REQUESTED"
  | "CURSOR_AGENT_CREATED"
  | "CURSOR_AGENT_CREATE_FAILED"
  | "CURSOR_AGENT_STATUS_CHANGED"
  | "CURSOR_AGENT_COMPLETED"
  | "CURSOR_REPORT_RECEIVED"
  | "CURSOR_REPORT_SCHEMA_REJECTED"
  | "CURSOR_REPORT_VALIDATED"
  | "REMEDIATION_AUTHORIZED"
  | "REMEDIATION_USED"
  | "REMEDIATION_BUDGET_EXHAUSTED"
  | "RECOVERY_TRANSACTION_PROPOSED"
  | "RECOVERY_TRANSACTION_STARTED"
  | "FINAL_EXECUTABLE_FROZEN"
  | "EVIDENCE_TIP_RECORDED"
  | "BROWSER_EVIDENCE_RECORDED"
  | "SPECIALIST_REVIEW_RECORDED"
  | "HUMAN_APPROVAL_REQUESTED"
  | "HUMAN_APPROVAL_GRANTED"
  | "HUMAN_APPROVAL_REJECTED"
  | "HUMAN_APPROVAL_REVISED"
  | "HUMAN_APPROVAL_CONSUMED"
  | "PR_OPENED"
  | "PR_OPEN_FAILED"
  | "PR_MERGED"
  | "PR_MERGE_REJECTED"
  | "POSTMERGE_VERIFICATION_STARTED"
  | "POSTMERGE_VERIFICATION_COMPLETED"
  | "WORKSTREAM_ACCEPTED"
  | "WORKSTREAM_BLOCKED"
  | "TRANSACTION_ACCEPTED"
  | "TRANSACTION_BLOCKED"
  | "EXTERNAL_ACTION_NOOP"
  | "IDEMPOTENCY_RECONCILED"
  | "STALE_DECISION_REJECTED"
  | "BUDGET_THRESHOLD_REACHED"
  | "RADIO_ERROR"
  | "RADIO_RECOVERED"
  | "RADIO_STARTED"
  | "RADIO_STOPPED"
  | "OTHER";

export interface RunLedgerEvent {
  schemaVersion: "1.0";
  sequence: number;
  eventId: string;
  eventType: RunLedgerEventType;
  occurredAt: string;
  recordedAt: string;
  projectId: string;
  workstreamId: string | null;
  transactionId: string | null;
  workOrderId: string | null;
  decisionId: string | null;
  agentId: string | null;
  approvalId: string | null;
  stateRevisionBefore: number | null;
  stateRevisionAfter: number | null;
  stateFingerprint: string | null;
  idempotencyKey: string | null;
  severity: "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL";
  summary: string;
  payload: Record<string, unknown>;
}

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
  /** Executable work only — authority/P4 input. */
  requestedWork: string;
  /** Acceptance criteria — not executable authority input. */
  verificationCriteria: string;
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
  requestedWork: string;
  verificationCriteria: string;
  radioGuardrails: string[];
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
    /**
     * Explicit Cursor worker model id (POST /v1/agents model.id).
     * Required for live external execution; never omit for cost-controlled runs.
     */
    workerModel: string | null;
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
  cursorApiKeyPresent: boolean;
  /**
   * True only for live transport:
   * explicit --transmit AND CURSOR_EXECUTION_ENABLED=true AND CURSOR_API_KEY
   * AND NOT fixture mode.
   */
  liveCursorDispatchAuthorized: boolean;
  /** CLI parsed --transmit (live transmitter mode). Never true in fixture mode. */
  explicitTransmitMode: boolean;
  /**
   * Structural gate: fixture paths always false.
   * When false, HTTP Cursor clients must not be used.
   */
  externalCursorAllowed: boolean;
  /** Deterministic Phase 1 transmitter path using a mock Cursor client. */
  phase1FixtureTransmit: boolean;
  /** Deterministic Phase 2 fixture path (no OpenAI, no Cursor create). */
  phase2Fixture: boolean;
  /** Live/read-only Phase 2 continuation (no Cursor create). */
  phase2Live: boolean;
  /** Deterministic Phase 3 autonomous loop fixture (no live APIs). */
  phase3Fixture: boolean;
  /** Real Phase 3 entrypoint (requires explicit objective authority; not auto-run). */
  phase3Live: boolean;
  /** Path to objective authority envelope for Phase 3. */
  objectiveAuthorityPath: string | null;
  /** Explicit-human invalid-report recovery operation. */
  recoverInvalidReport: boolean;
  /** Isolated fixture recovery (no canonical PROJECT-STATE mutation). */
  recoverInvalidReportFixture: boolean;
  /** Explicit --human-authorized flag for recovery. */
  humanAuthorized: boolean;
  /** --expected-revision for recovery revision match. */
  expectedRevision: number | null;
  /** Phase 2 validation artifact path for recovery. */
  validationArtifactPath: string | null;
  mode: "live" | "fixture";
  fixturePath?: string;
  projectRoot: string;
  /** Optional override path for mutable project state (tests). */
  statePath?: string;
  /** Optional override path for run ledger (tests). */
  ledgerPath?: string;
  /** Polling controls for live/fixture transmit. */
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
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
  cursorApiCalled: boolean;
  liveCursorDispatchAuthorized: boolean;
  cursorAgentId: string | null;
  artifactPaths: Record<string, string>;
  terminalVerdict: RadioTerminalVerdict;
}
