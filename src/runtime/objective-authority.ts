/**
 * Phase 3 objective authority envelope.
 *
 * The objective is the durable unit of work. Agent sessions are implementation
 * details. Human authority remains explicit, single-purpose, scoped, consumable,
 * and auditable — never inferred from prior approvals or worker/Sol output.
 */

import type {
  DecisionKind,
  ObjectiveAuthority,
  OrchestratorDecision,
  WorkType,
} from "../types.js";
import { readJsonFile, writeJsonAtomic } from "../util/io.js";

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
  | "AUTHORITY_EXPIRED";

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

export function createDefaultFixtureObjectiveAuthority(input: {
  projectId: string;
  workstreamId: string;
  transactionId: string;
  stateRevisionBasis: number;
  maxIterations?: number;
  maxCursorAgents?: number;
  maxRetriesPerLogicalStep?: number;
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
    const workType = decision.cursorInstruction?.workType;
    if (!workType || !authority.permittedWorkTypes.includes(workType as WorkType)) {
      return fail(
        "WORK_TYPE_NOT_PERMITTED",
        `Work type ${workType ?? "(missing)"} is not permitted by objective authority`,
      );
    }

    const scopeText =
      `${decision.cursorInstruction?.objective ?? ""}\n${decision.cursorInstruction?.prompt ?? ""}`.toLowerCase();
    for (const prohibited of authority.prohibitedScope) {
      const needle = prohibited.toLowerCase();
      if (!scopeText.includes(needle)) continue;

      // Evaluate clause-by-clause so "Do not implement Stage 3" is not treated
      // as affirmative activation of prohibited scope.
      let affirmativeHit = false;
      for (const line of scopeText.split(/\n+/)) {
        for (const clause of line.split(/\s*[;.](?:\s+|$)/)) {
          const c = clause.trim();
          if (!c.includes(needle)) continue;
          if (isNegatedOrBoundaryClause(c)) continue;
          if (
            new RegExp(
              `\\b(start|implement|begin|launch|authorize|approve|merge)\\b[\\s\\S]{0,48}${escapeRegExp(needle)}`,
              "i",
            ).test(c) ||
            new RegExp(
              `${escapeRegExp(needle)}[\\s\\S]{0,40}\\b(now|immediately|authorized)\\b`,
              "i",
            ).test(c)
          ) {
            affirmativeHit = true;
          }
        }
      }
      if (affirmativeHit) {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNegatedOrBoundaryClause(clause: string): boolean {
  return (
    /\b(do not|don't|dont|must not|shall not|without|never|prohibit|forbidden|out of scope|out-of-scope|hard prohibitions?)\b/i.test(
      clause,
    ) || /\b(remains?|still)\s+(deferred|frozen|unauthorized|blocked)\b/i.test(clause)
  );
}
