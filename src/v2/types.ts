/**
 * Radio v2 — thin zero-relay orchestrator types.
 *
 * Worker narrative is evidence, not Radio state.
 * startingSha and implementationTipSha are distinct identities.
 */

export const V2_SCHEMA_VERSION = "radio-v2-1.0" as const;

/** Core loop stages — no v1 orchestration states ported. */
export type V2Stage = "PLAN" | "WORK" | "VERIFY" | "DECIDE";

/** Terminal outcomes after DECIDE. */
export type V2TerminalOutcome =
  | "DONE"
  | "HUMAN"
  | "FAILED_MACHINE"
  | "FAILED_POLICY";

export type V2WorkType =
  | "IMPLEMENTATION"
  | "VERIFICATION"
  | "DESIGN"
  | "REVIEW";

/** Sol next-action vocabulary for v2. */
export type SolV2Action =
  | "ACCEPT"
  | "CONTINUE_WORK"
  | "VERIFY_MORE"
  | "ASK_HUMAN"
  | "FAIL"
  | "WORK";

/**
 * Minimal v2 objective — every field has direct operational purpose.
 */
export interface V2Objective {
  schemaVersion: typeof V2_SCHEMA_VERSION;
  objectiveId: string;
  projectId: string;
  repository: string;
  baseBranch: string;
  /** Trusted starting source pin (full 40-char SHA). */
  expectedStartingSha: string;
  humanInstruction: string;
  authorizedWorkTypes: V2WorkType[];
  publicationRequired: boolean;
  /** Actions requiring genuine human judgment/authority. */
  humanApprovalBoundaries: string[];
  /**
   * Bounded worker-run allowance. Default 2 when omitted.
   * Same-agent follow-up via createAgentRun counts as one run.
   */
  maxWorkerRuns?: number;
  /**
   * When true, changed files outside test paths trigger a human gate.
   * Requires project-specific path rules via testPathPrefixes.
   */
  testOnlyScope?: boolean;
  /** Paths considered test-only (e.g. ["tests/"]). */
  testPathPrefixes?: string[];
}

export interface V2Plan {
  objectiveId: string;
  startingSha: string;
  repository: string;
  baseBranch: string;
  authorizedWorkTypes: V2WorkType[];
  publicationRequired: boolean;
  maxWorkerRuns: number;
  plannedAt: string;
}

/** Radio-derived deterministic facts — never overwritten by worker prose. */
export interface V2VerifiedFacts {
  repository: string;
  baseBranch: string;
  /** Starting source identity — pinned before work. */
  startingSha: string;
  /** Remote base branch tip at source resolution (should match startingSha). */
  resolvedBaseSha: string;
  /** Implementation branch published by worker. */
  implementationBranch: string | null;
  /** Implementation tip identity — distinct from startingSha. */
  implementationTipSha: string | null;
  remoteBranchExists: boolean;
  implementationTipRemoteExists: boolean;
  freshCommit: boolean;
  startingShaEqualsImplementationTip: boolean;
  isAncestorStartingToImplementation: boolean;
  changedFiles: string[];
  publicationAvailable: boolean;
  repositoryBindingOk: boolean;
  contradictions: string[];
  verifiedAt: string;
}

/** Worker-reported claims — narrative and optional structured hints. */
export interface V2WorkerReportedFacts {
  narrative: string;
  testsPassed: boolean | null;
  buildPassed: boolean | null;
  productBehaviorChanged: boolean | null;
  claimedBranch: string | null;
  claimedCommit: string | null;
}

export interface V2WorkerIdentity {
  agentId: string;
  runId: string;
}

export interface V2SolDecision {
  action: SolV2Action;
  rationale: string;
  decidedAt: string;
}

export interface V2DecisionPacket {
  objective: V2Objective;
  startingSourceIdentity: {
    repository: string;
    baseBranch: string;
    startingSha: string;
  };
  authorizedScope: {
    workTypes: V2WorkType[];
    publicationRequired: boolean;
    humanApprovalBoundaries: string[];
  };
  verifiedFacts: V2VerifiedFacts;
  workerNarrative: string;
  workerReported: V2WorkerReportedFacts;
  changedFiles: string[];
  contradictions: string[];
  hardRuleStatus: {
    allHardRulesPass: boolean;
    failures: string[];
  };
  iteration: number;
  workerRunsUsed: number;
  maxWorkerRuns: number;
}

export interface V2HardGateResult {
  pass: boolean;
  failures: string[];
}

export interface V2IterationArtifacts {
  iteration: number;
  workerRequestPath: string;
  workerResultPath: string;
  verifiedFactsPath: string;
  decisionPath: string;
}

export interface V2RunState {
  schemaVersion: typeof V2_SCHEMA_VERSION;
  objective: V2Objective;
  stage: V2Stage | V2TerminalOutcome;
  iteration: number;
  workerRunsUsed: number;
  startingSha: string;
  lastImplementationTipSha: string | null;
  lastImplementationBranch: string | null;
  lastVerifiedFacts: V2VerifiedFacts | null;
  lastSolDecision: V2SolDecision | null;
  activeWorker: V2WorkerIdentity | null;
  terminalOutcome: V2TerminalOutcome | null;
  terminalReason: string | null;
  updatedAt: string;
}

export interface V2RunSummary {
  objectiveId: string;
  finalStage: V2Stage | V2TerminalOutcome;
  terminalOutcome: V2TerminalOutcome | null;
  iterations: number;
  workerRunsUsed: number;
  humanMessagesAfterLaunch: number;
  implementationWorkersCreated: number;
  structuredWorkerReportRequired: false;
  reportRepairAttempts: number;
  startingShaEqualsImplementationTip: boolean;
  startingShaAncestorOfImplementationTip: boolean;
  completedAt: string | null;
}

export interface V2RunResult {
  state: V2RunState;
  summary: V2RunSummary;
  runDir: string;
}
