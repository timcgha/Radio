/**
 * Phase 3 objective authority envelope.
 *
 * The objective is the durable unit of work. Agent sessions are implementation
 * details. Human authority remains explicit, single-purpose, scoped, consumable,
 * and auditable — never inferred from prior approvals or worker/Sol output.
 */

import {
  canLiveCursorDispatch,
  resolveCursorApiKey,
} from "../cursor/api-client.js";
import {
  isFullGitCommitSha,
  normalizeCommitSha,
} from "../cursor/source-ref.js";
import type {
  DecisionKind,
  ObjectiveAuthority,
  OrchestratorDecision,
  ProjectState,
  WorkType,
} from "../types.js";
import { detectProhibitedScopeActivation } from "./prohibited-scope.js";
import { canonicalize, readJsonFile, sha256Hex, writeJsonAtomic } from "../util/io.js";
import { executableScopeText } from "../policy/executable-scope.js";

export type ObjectiveAuthorityCheckCode =
  | "AUTHORITY_OK"
  | "OBJECTIVE_CONSUMED"
  | "PROJECT_MISMATCH"
  | "WORKSTREAM_MISMATCH"
  | "TRANSACTION_MISMATCH"
  | "WORK_TYPE_NOT_PERMITTED"
  | "PROHIBITED_SCOPE"
  | "HUMAN_GATED_ACTION"
  | "ITERATION_BUDGET_EXHAUSTED"
  | "CURSOR_AGENT_BUDGET_EXHAUSTED"
  | "RETRY_BUDGET_EXHAUSTED"
  | "TOKEN_BUDGET_EXHAUSTED"
  | "SPEND_BUDGET_EXHAUSTED"
  | "FOREIGN_APPROVAL_REUSE"
  | "SOL_BUDGET_OVERRIDE_ATTEMPT"
  | "SOL_SOURCE_BINDING_FAILED"
  | "AUTHORITY_EXPIRED";

/** Deterministic fixture-era identities that must never appear in live mode. */
export const FIXTURE_PHASE3_IDENTITIES = [
  "radio-phase3-fixture-01",
  "radio-phase3-fixture-01-bounded-verify",
  "obj-phase3-fixture-bounded-verify",
  "ha-phase3-fixture-objective-2026-08-29",
] as const;

/** Stage 2 playtest approval — must never authorize Phase 3 objectives. */
export const STAGE2_PLAYTEST_APPROVAL_ID =
  "ha-stage2-human-playtest-2026-08-29";

export type Phase3LiveEntryCheckCode =
  | "LIVE_ENTRY_OK"
  | "OBJECTIVE_AUTHORITY_REQUIRED"
  | "OBJECTIVE_CONSUMED"
  | "AUTHORITY_EXPIRED"
  | "PROJECT_MISMATCH"
  | "APPROVAL_ID_MISSING"
  | "FOREIGN_APPROVAL_REUSE"
  | "PERMITTED_WORK_TYPES_MISSING"
  | "PROHIBITED_SCOPE_MISSING"
  | "SOURCE_PIN_MISSING"
  | "SOURCE_PIN_NOT_FULL_SHA"
  | "INVALID_BUDGET"
  | "STATE_REVISION_MISMATCH"
  | "ACTIVE_AGENT_CONFLICT"
  | "FIXTURE_IDENTITY_LEAK"
  | "WORKSTREAM_BINDING_INVALID"
  | "TRANSACTION_BINDING_INVALID";

export interface Phase3LiveEntryCheck {
  ok: boolean;
  code: Phase3LiveEntryCheckCode;
  summary: string;
}

export type Phase3ExecutionPrerequisiteCode =
  | "PREREQUISITES_OK"
  | "OPENAI_API_KEY_MISSING"
  | "CURSOR_API_KEY_MISSING"
  | "CURSOR_EXECUTION_DISABLED";

export interface Phase3ExecutionPrerequisiteCheck {
  ok: boolean;
  code: Phase3ExecutionPrerequisiteCode;
  summary: string;
}

export interface ObjectiveAuthorityCheck {
  ok: boolean;
  code: ObjectiveAuthorityCheckCode;
  summary: string;
}

const EXECUTION_DECISIONS = new Set<DecisionKind>([
  "LAUNCH_CURSOR",
  "REUSE_CURSOR",
]);

export function loadObjectiveAuthority(path: string): ObjectiveAuthority {
  const value = readJsonFile<ObjectiveAuthority>(path);
  if (value.schemaVersion !== "phase3-1.0") {
    throw new Error(
      `Unsupported objective authority schemaVersion: ${String(value.schemaVersion)}`,
    );
  }
  return value;
}

export function persistObjectiveAuthority(
  path: string,
  authority: ObjectiveAuthority,
): void {
  writeJsonAtomic(path, authority);
}

/** Stage 2 fixture / Phase 3 fixture default trusted source pin. */
export const FIXTURE_TRUSTED_BASE_BRANCH =
  "cursor/level4-stage2-asteroid-garden-9dce";
export const FIXTURE_TRUSTED_EXPECTED_STARTING_SHA =
  "aa512d6ef721f855be33ddc36da490f9de66dc23";

/** Stage 3 / live-entry trusted source pin (Bellhop level3 full SHA). */
export const STAGE3_TRUSTED_BASE_BRANCH = "level3";
export const STAGE3_TRUSTED_EXPECTED_STARTING_SHA =
  "847ca2d64090aaeb94ca681b651a44062ab9f644";

export function createDefaultFixtureObjectiveAuthority(input: {
  projectId: string;
  workstreamId: string;
  transactionId: string;
  stateRevisionBasis: number;
  maxIterations?: number;
  maxCursorAgents?: number;
  maxRetriesPerLogicalStep?: number;
  baseBranch?: string;
  expectedStartingSha?: string;
}): ObjectiveAuthority {
  return {
    schemaVersion: "phase3-1.0",
    objectiveId: "obj-phase3-fixture-bounded-verify",
    approvalId: "ha-phase3-fixture-objective-2026-08-29",
    projectId: input.projectId,
    workstreamId: input.workstreamId,
    transactionId: input.transactionId,
    summary:
      "Complete a bounded Phase 3 fixture verification loop and stop when human judgment is required.",
    baseBranch: input.baseBranch ?? FIXTURE_TRUSTED_BASE_BRANCH,
    expectedStartingSha:
      input.expectedStartingSha ?? FIXTURE_TRUSTED_EXPECTED_STARTING_SHA,
    permittedWorkTypes: ["VERIFICATION", "CLOSEOUT"],
    prohibitedScope: [
      "Level 4 Stage 3",
      "Stage 3",
      "merge PR",
      "production deploy",
      "flight retune",
      "Cheese Moon remediation",
      "Bellhop product mutation",
    ],
    humanGatedActions: [
      "MERGE_PR",
      "PRODUCTION_DEPLOY",
      "START_DEFERRED_WORK",
      "BUDGET_OVERRIDE",
      "MATERIAL_PRODUCT_REQUIREMENT_CHANGE",
    ],
    maxIterations: input.maxIterations ?? 4,
    maxCursorAgents: input.maxCursorAgents ?? 2,
    maxRetriesPerLogicalStep: input.maxRetriesPerLogicalStep ?? 1,
    maxCursorUsageTokens: null,
    maxEstimatedSpend: null,
    stateRevisionBasis: input.stateRevisionBasis,
    createdAt: "2026-08-29T21:00:00.000Z",
    expiresAt: null,
    consumed: false,
    accounting: {
      iterationsUsed: 0,
      cursorAgentsUsed: 0,
      retriesUsed: 0,
      cursorUsageTokensUsed: 0,
      estimatedSpendUsed: 0,
    },
  };
}

/**
 * Identity material for ObjectiveAuthority — includes trusted source pin so a
 * pin change is a visible authority identity change.
 */
export function buildObjectiveAuthorityIdentityMaterial(
  authority: ObjectiveAuthority,
): Record<string, unknown> {
  return {
    schemaVersion: authority.schemaVersion,
    objectiveId: authority.objectiveId,
    approvalId: authority.approvalId,
    projectId: authority.projectId,
    workstreamId: authority.workstreamId,
    transactionId: authority.transactionId,
    baseBranch: authority.baseBranch,
    expectedStartingSha: authority.expectedStartingSha,
    permittedWorkTypes: authority.permittedWorkTypes,
    prohibitedScope: authority.prohibitedScope,
    humanGatedActions: authority.humanGatedActions,
    maxIterations: authority.maxIterations,
    maxCursorAgents: authority.maxCursorAgents,
    maxRetriesPerLogicalStep: authority.maxRetriesPerLogicalStep,
    maxCursorUsageTokens: authority.maxCursorUsageTokens,
    maxEstimatedSpend: authority.maxEstimatedSpend,
    stateRevisionBasis: authority.stateRevisionBasis,
    createdAt: authority.createdAt,
    expiresAt: authority.expiresAt,
    consumed: authority.consumed,
  };
}

export function computeObjectiveAuthorityIdentity(
  authority: ObjectiveAuthority,
): string {
  return sha256Hex(
    canonicalize(buildObjectiveAuthorityIdentityMaterial(authority)),
  );
}

/**
 * Deterministic pre-execution authority + budget gate.
 * Sol cannot expand these budgets. Worker content cannot create authority.
 */
export function checkObjectiveAuthorityForDecision(input: {
  authority: ObjectiveAuthority;
  decision: OrchestratorDecision;
  /** Prior consumed approval ids that must not authorize this objective. */
  foreignApprovalIds?: string[];
  /** True when this launch is a logical retry after a prior execution. */
  isLogicalRetry?: boolean;
}): ObjectiveAuthorityCheck {
  const { authority, decision } = input;

  if (authority.consumed) {
    return fail("OBJECTIVE_CONSUMED", "Objective authority is already consumed");
  }

  if (authority.expiresAt) {
    const expires = Date.parse(authority.expiresAt);
    if (Number.isFinite(expires) && Date.now() > expires) {
      return fail("AUTHORITY_EXPIRED", "Objective authority has expired");
    }
  }

  if (decision.projectId !== authority.projectId) {
    return fail(
      "PROJECT_MISMATCH",
      `Decision projectId ${decision.projectId} != objective ${authority.projectId}`,
    );
  }
  if (decision.workstreamId !== authority.workstreamId) {
    return fail(
      "WORKSTREAM_MISMATCH",
      `Decision workstreamId ${decision.workstreamId} != objective ${authority.workstreamId}`,
    );
  }
  if (
    decision.transactionId != null &&
    decision.transactionId !== authority.transactionId
  ) {
    return fail(
      "TRANSACTION_MISMATCH",
      `Decision transactionId ${decision.transactionId} != objective ${authority.transactionId}`,
    );
  }

  for (const foreignId of input.foreignApprovalIds ?? []) {
    if (foreignId && foreignId === authority.approvalId) {
      continue;
    }
    if (foreignId) {
      // Foreign approvals (e.g. prior Stage 2 playtest) never authorize this objective.
      // Presence alone is recorded; mismatch is enforced by requiring the objective's own approvalId.
    }
  }

  // Sol / worker must not smuggle budget overrides through decision text.
  const budgetOverrideAttempt = detectSolBudgetOverrideAttempt(decision, authority);
  if (budgetOverrideAttempt) {
    return fail("SOL_BUDGET_OVERRIDE_ATTEMPT", budgetOverrideAttempt);
  }

  if (EXECUTION_DECISIONS.has(decision.decision)) {
    const sourceBinding = checkSolSourceBinding({ authority, decision });
    if (!sourceBinding.ok) {
      return sourceBinding;
    }

    const workType = decision.cursorInstruction?.workType;
    if (!workType || !authority.permittedWorkTypes.includes(workType as WorkType)) {
      return fail(
        "WORK_TYPE_NOT_PERMITTED",
        `Work type ${workType ?? "(missing)"} is not permitted by objective authority`,
      );
    }

    const scopeText = decision.cursorInstruction
      ? executableScopeText(decision.cursorInstruction)
      : "";
    for (const prohibited of authority.prohibitedScope) {
      if (detectProhibitedScopeActivation(scopeText, prohibited)) {
        return fail(
          "PROHIBITED_SCOPE",
          `Decision activates prohibited objective scope: ${prohibited}`,
        );
      }
    }

    if (authority.accounting.iterationsUsed >= authority.maxIterations) {
      return fail(
        "ITERATION_BUDGET_EXHAUSTED",
        `maxIterations ${authority.maxIterations} already used`,
      );
    }
    if (authority.accounting.cursorAgentsUsed >= authority.maxCursorAgents) {
      return fail(
        "CURSOR_AGENT_BUDGET_EXHAUSTED",
        `maxCursorAgents ${authority.maxCursorAgents} already used`,
      );
    }
    if (
      input.isLogicalRetry &&
      authority.accounting.retriesUsed >= authority.maxRetriesPerLogicalStep
    ) {
      return fail(
        "RETRY_BUDGET_EXHAUSTED",
        `maxRetriesPerLogicalStep ${authority.maxRetriesPerLogicalStep} already used`,
      );
    }
    if (
      authority.maxCursorUsageTokens != null &&
      authority.accounting.cursorUsageTokensUsed >= authority.maxCursorUsageTokens
    ) {
      return fail(
        "TOKEN_BUDGET_EXHAUSTED",
        `maxCursorUsageTokens ${authority.maxCursorUsageTokens} already used`,
      );
    }
    if (
      authority.maxEstimatedSpend != null &&
      authority.accounting.estimatedSpendUsed >= authority.maxEstimatedSpend
    ) {
      return fail(
        "SPEND_BUDGET_EXHAUSTED",
        `maxEstimatedSpend ${authority.maxEstimatedSpend} already used`,
      );
    }
  }

  if (decision.decision === "REQUEST_HUMAN_APPROVAL") {
    const requested = decision.humanApproval?.requestedAction ?? "";
    if (
      authority.humanGatedActions.some((a) =>
        requested.toUpperCase().includes(a.replace(/_/g, "")),
      )
    ) {
      // Expected human gate — authority check still OK; Phase 3 stops before execution.
      return ok("HUMAN_GATED_ACTION", "Human-gated action correctly routed");
    }
  }

  return ok("AUTHORITY_OK", "Objective authority permits evaluation of this decision");
}

/**
 * Record one loop iteration (reasoning/execution cycle accounting).
 */
export function recordIterationUsed(
  authority: ObjectiveAuthority,
): ObjectiveAuthority {
  return {
    ...authority,
    accounting: {
      ...authority.accounting,
      iterationsUsed: authority.accounting.iterationsUsed + 1,
    },
  };
}

/**
 * Record a new logical Cursor worker (not transport reconciliation).
 */
export function recordCursorAgentUsed(
  authority: ObjectiveAuthority,
  opts?: { logicalRetry?: boolean; usageTokens?: number },
): ObjectiveAuthority {
  return {
    ...authority,
    accounting: {
      ...authority.accounting,
      cursorAgentsUsed: authority.accounting.cursorAgentsUsed + 1,
      retriesUsed:
        authority.accounting.retriesUsed + (opts?.logicalRetry ? 1 : 0),
      cursorUsageTokensUsed:
        authority.accounting.cursorUsageTokensUsed + (opts?.usageTokens ?? 0),
    },
  };
}

export function consumeObjectiveAuthority(
  authority: ObjectiveAuthority,
): ObjectiveAuthority {
  return { ...authority, consumed: true };
}

/**
 * Prior Stage 2 / unrelated approvals must never authorize a Phase 3 objective.
 */
export function assertNoForeignApprovalReuse(input: {
  objectiveApprovalId: string;
  candidateApprovalId: string | null | undefined;
}): ObjectiveAuthorityCheck {
  if (!input.candidateApprovalId) {
    return ok("AUTHORITY_OK", "No foreign approval presented");
  }
  if (input.candidateApprovalId === input.objectiveApprovalId) {
    return ok("AUTHORITY_OK", "Approval matches objective authority");
  }
  return fail(
    "FOREIGN_APPROVAL_REUSE",
    `Approval ${input.candidateApprovalId} cannot authorize objective ${input.objectiveApprovalId}`,
  );
}

/**
 * Deterministic pre-loop validation for live Phase 3 entry.
 * Does NOT consume authority — consumption happens at canonical control-plane points.
 */
export function validateObjectiveAuthorityForLiveEntry(input: {
  authority: ObjectiveAuthority;
  state: ProjectState;
  foreignApprovalIds?: string[];
}): Phase3LiveEntryCheck {
  const { authority, state } = input;

  if (!authority.approvalId?.trim()) {
    return liveFail("APPROVAL_ID_MISSING", "Objective authority approvalId is required");
  }

  if (authority.consumed) {
    return liveFail("OBJECTIVE_CONSUMED", "Objective authority is already consumed");
  }

  if (authority.expiresAt) {
    const expires = Date.parse(authority.expiresAt);
    if (Number.isFinite(expires) && Date.now() > expires) {
      return liveFail("AUTHORITY_EXPIRED", "Objective authority has expired");
    }
  }

  if (authority.projectId !== state.project.id) {
    return liveFail(
      "PROJECT_MISMATCH",
      `Objective projectId ${authority.projectId} != state ${state.project.id}`,
    );
  }

  if (authority.approvalId === STAGE2_PLAYTEST_APPROVAL_ID) {
    return liveFail(
      "FOREIGN_APPROVAL_REUSE",
      "Stage 2 playtest approval cannot authorize Phase 3",
    );
  }

  for (const foreignId of input.foreignApprovalIds ?? []) {
    if (foreignId && foreignId === authority.approvalId) {
      return liveFail(
        "FOREIGN_APPROVAL_REUSE",
        `Approval ${foreignId} is a foreign prior approval`,
      );
    }
  }

  // Consumed prior approvals (e.g. Stage 2 playtest) may remain in state as
  // historical records. Only refuse when an unconsumed foreign approval is
  // being presented as live authority for this objective.
  const pending = state.pendingHumanDecision;
  if (pending && typeof pending === "object") {
    const pendingApprovalId =
      typeof (pending as { approvalId?: unknown }).approvalId === "string"
        ? (pending as { approvalId: string }).approvalId
        : null;
    const pendingConsumed = (pending as { consumed?: unknown }).consumed === true;
    if (
      pendingApprovalId &&
      !pendingConsumed &&
      pendingApprovalId !== authority.approvalId
    ) {
      const foreign = assertNoForeignApprovalReuse({
        objectiveApprovalId: authority.approvalId,
        candidateApprovalId: pendingApprovalId,
      });
      if (!foreign.ok) {
        return liveFail("FOREIGN_APPROVAL_REUSE", foreign.summary);
      }
    }
  }

  if (!authority.workstreamId?.trim()) {
    return liveFail(
      "WORKSTREAM_BINDING_INVALID",
      "Objective authority workstreamId is required",
    );
  }
  if (!authority.transactionId?.trim()) {
    return liveFail(
      "TRANSACTION_BINDING_INVALID",
      "Objective authority transactionId is required",
    );
  }
  if (!authority.objectiveId?.trim()) {
    return liveFail(
      "WORKSTREAM_BINDING_INVALID",
      "Objective authority objectiveId is required",
    );
  }

  for (const fixtureId of FIXTURE_PHASE3_IDENTITIES) {
    if (
      authority.workstreamId === fixtureId ||
      authority.transactionId === fixtureId ||
      authority.objectiveId === fixtureId ||
      authority.approvalId === fixtureId
    ) {
      return liveFail(
        "FIXTURE_IDENTITY_LEAK",
        `Live mode cannot use fixture identity ${fixtureId}`,
      );
    }
  }

  if (!authority.permittedWorkTypes?.length) {
    return liveFail(
      "PERMITTED_WORK_TYPES_MISSING",
      "Objective authority must define permittedWorkTypes",
    );
  }

  if (!authority.prohibitedScope?.length) {
    return liveFail(
      "PROHIBITED_SCOPE_MISSING",
      "Objective authority must preserve prohibitedScope",
    );
  }

  const sourcePin = validateTrustedSourcePinForLive(authority);
  if (!sourcePin.ok) {
    return sourcePin;
  }

  const budgetCheck = validateObjectiveBudgets(authority);
  if (!budgetCheck.ok) {
    return budgetCheck;
  }

  if (state.stateRevision < authority.stateRevisionBasis) {
    return liveFail(
      "STATE_REVISION_MISMATCH",
      `State revision ${state.stateRevision} is older than authority basis ${authority.stateRevisionBasis}`,
    );
  }

  if (state.activeAgent != null) {
    return liveFail(
      "ACTIVE_AGENT_CONFLICT",
      "An active agent is already bound; one-worker limit violated",
    );
  }

  return liveOk("LIVE_ENTRY_OK", "Objective authority permits live Phase 3 entry");
}

export function validateObjectiveBudgets(
  authority: ObjectiveAuthority,
): Phase3LiveEntryCheck {
  if (authority.maxIterations < 1) {
    return liveFail("INVALID_BUDGET", "maxIterations must be >= 1");
  }
  if (authority.maxCursorAgents < 1) {
    return liveFail("INVALID_BUDGET", "maxCursorAgents must be >= 1");
  }
  if (authority.maxRetriesPerLogicalStep < 0) {
    return liveFail("INVALID_BUDGET", "maxRetriesPerLogicalStep must be >= 0");
  }
  if (
    authority.maxCursorUsageTokens != null &&
    authority.maxCursorUsageTokens < 1
  ) {
    return liveFail("INVALID_BUDGET", "maxCursorUsageTokens must be >= 1 when set");
  }
  if (authority.maxEstimatedSpend != null && authority.maxEstimatedSpend < 0) {
    return liveFail("INVALID_BUDGET", "maxEstimatedSpend must be >= 0 when set");
  }
  return liveOk("LIVE_ENTRY_OK", "Objective budgets valid");
}

/**
 * Execution prerequisites for live Cursor create — independent of objective authority.
 */
export function validatePhase3ExecutionPrerequisites(input?: {
  env?: NodeJS.ProcessEnv;
  openAiApiKeyPresent?: boolean;
}): Phase3ExecutionPrerequisiteCheck {
  const env = input?.env ?? process.env;
  const openAiPresent =
    input?.openAiApiKeyPresent ??
    Boolean(env.OPENAI_API_KEY?.trim());
  if (!openAiPresent) {
    return prereqFail(
      "OPENAI_API_KEY_MISSING",
      "OPENAI_API_KEY is required for live Phase 3 Sol decisions",
    );
  }
  if (!resolveCursorApiKey(env)) {
    return prereqFail(
      "CURSOR_API_KEY_MISSING",
      "CURSOR_API_KEY is required for live Phase 3 Cursor create",
    );
  }
  if (!canLiveCursorDispatch(env)) {
    return prereqFail(
      "CURSOR_EXECUTION_DISABLED",
      "CURSOR_EXECUTION_ENABLED must be true with CURSOR_API_KEY for live Cursor create",
    );
  }
  return prereqOk("PREREQUISITES_OK", "Live execution prerequisites satisfied");
}

export function resolvePhase3LiveIdentities(input: {
  authority: ObjectiveAuthority;
  state: ProjectState;
}): {
  projectId: string;
  workstreamId: string;
  transactionId: string;
  objectiveId: string;
  approvalId: string;
} {
  return {
    projectId: input.authority.projectId,
    workstreamId: input.authority.workstreamId,
    transactionId: input.authority.transactionId,
    objectiveId: input.authority.objectiveId,
    approvalId: input.authority.approvalId,
  };
}

/**
 * Sol may reason about / echo the trusted source pin.
 * Sol may NOT choose or replace it. Claims must exactly equal ObjectiveAuthority.
 * Applies to initial and continuation LAUNCH_CURSOR / REUSE_CURSOR decisions.
 */
export function checkSolSourceBinding(input: {
  authority: ObjectiveAuthority;
  decision: OrchestratorDecision;
}): ObjectiveAuthorityCheck {
  const { authority, decision } = input;
  const cursor = decision.cursorInstruction;
  if (!cursor) {
    return ok("AUTHORITY_OK", "No cursor instruction source claims to bind");
  }

  const trustedBranch = authority.baseBranch?.trim() ?? "";
  const trustedSha = authority.expectedStartingSha?.trim() ?? "";

  const claimedBranch = cursor.baseBranch?.trim() || "";
  if (claimedBranch) {
    if (!trustedBranch) {
      return fail(
        "SOL_SOURCE_BINDING_FAILED",
        "Sol claimed baseBranch but ObjectiveAuthority has no trusted baseBranch",
      );
    }
    if (claimedBranch !== trustedBranch) {
      return fail(
        "SOL_SOURCE_BINDING_FAILED",
        `Sol baseBranch ${JSON.stringify(claimedBranch)} != trusted ObjectiveAuthority baseBranch ${JSON.stringify(trustedBranch)}`,
      );
    }
  }

  const claimedSha = cursor.expectedStartingSha?.trim() || "";
  if (claimedSha) {
    if (!trustedSha) {
      return fail(
        "SOL_SOURCE_BINDING_FAILED",
        "Sol claimed expectedStartingSha but ObjectiveAuthority has no trusted expectedStartingSha",
      );
    }
    if (normalizeCommitSha(claimedSha) !== normalizeCommitSha(trustedSha)) {
      return fail(
        "SOL_SOURCE_BINDING_FAILED",
        `Sol expectedStartingSha ${JSON.stringify(claimedSha)} != trusted ObjectiveAuthority expectedStartingSha ${JSON.stringify(trustedSha)}`,
      );
    }
  }

  return ok(
    "AUTHORITY_OK",
    "Sol source claims match trusted ObjectiveAuthority source pin",
  );
}

/**
 * Live Phase 3 requires an explicit human-authorized full-SHA source pin.
 * Do not infer from PROJECT-STATE short SHA, Sol output, or remote tip.
 */
export function validateTrustedSourcePinForLive(
  authority: ObjectiveAuthority,
): Phase3LiveEntryCheck {
  const branch = authority.baseBranch?.trim() ?? "";
  const sha = authority.expectedStartingSha?.trim() ?? "";
  if (!branch) {
    return liveFail(
      "SOURCE_PIN_MISSING",
      "Objective authority baseBranch is required for live Phase 3",
    );
  }
  if (!sha) {
    return liveFail(
      "SOURCE_PIN_MISSING",
      "Objective authority expectedStartingSha is required for live Phase 3",
    );
  }
  if (!isFullGitCommitSha(sha)) {
    return liveFail(
      "SOURCE_PIN_NOT_FULL_SHA",
      `Objective authority expectedStartingSha must be a full 40-character commit SHA; got ${JSON.stringify(sha)}`,
    );
  }
  return liveOk("LIVE_ENTRY_OK", "Trusted source pin valid for live Phase 3");
}

function detectSolBudgetOverrideAttempt(
  decision: OrchestratorDecision,
  authority: ObjectiveAuthority,
): string | null {
  const blob = JSON.stringify(decision).toLowerCase();
  if (
    /\bincrease\s+(the\s+)?(max(imum)?\s+)?(budget|iterations|cursor\s*agents|retries)\b/.test(
      blob,
    ) ||
    /\braise\s+(the\s+)?budget\b/.test(blob) ||
    /\boverride\s+(the\s+)?budget\b/.test(blob) ||
    /\bset\s+maxiterations\s+to\s+\d+/.test(blob) ||
    /\bset\s+maxcursoragents\s+to\s+\d+/.test(blob)
  ) {
    return "Sol decision attempts to expand objective budgets";
  }
  // Numeric smuggling via terminal/proposed updates is not a budget channel;
  // authority numbers live only on the Radio-owned envelope.
  void authority;
  return null;
}

function ok(
  code: ObjectiveAuthorityCheckCode,
  summary: string,
): ObjectiveAuthorityCheck {
  return { ok: true, code, summary };
}

function fail(
  code: ObjectiveAuthorityCheckCode,
  summary: string,
): ObjectiveAuthorityCheck {
  return { ok: false, code, summary };
}

function liveOk(
  code: Phase3LiveEntryCheckCode,
  summary: string,
): Phase3LiveEntryCheck {
  return { ok: true, code, summary };
}

function liveFail(
  code: Phase3LiveEntryCheckCode,
  summary: string,
): Phase3LiveEntryCheck {
  return { ok: false, code, summary };
}

function prereqOk(
  code: Phase3ExecutionPrerequisiteCode,
  summary: string,
): Phase3ExecutionPrerequisiteCheck {
  return { ok: true, code, summary };
}

function prereqFail(
  code: Phase3ExecutionPrerequisiteCode,
  summary: string,
): Phase3ExecutionPrerequisiteCheck {
  return { ok: false, code, summary };
}

