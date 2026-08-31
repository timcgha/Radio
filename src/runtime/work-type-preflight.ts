/**
 * Deterministic pre-dispatch work-type / budget compatibility gate.
 * Fails BEFORE external Cursor worker creation when Sol selects an
 * unauthorized work type for the current transaction budget.
 */

import type {
  ObjectiveAuthority,
  OrchestratorDecision,
  ProjectState,
  WorkType,
} from "../types.js";
import { objectivePermitsRemediation } from "./remediation-budget.js";

export type WorkTypePreflightCode =
  | "PREFLIGHT_OK"
  | "WORK_TYPE_NOT_PERMITTED"
  | "REMEDIATION_BUDGET_EXHAUSTED_AT_START"
  | "REMEDIATION_BUDGET_ZERO_EXPLICIT"
  | "MISSING_CURSOR_INSTRUCTION";

export interface WorkTypePreflightResult {
  ok: boolean;
  code: WorkTypePreflightCode;
  summary: string;
  workType: WorkType | null;
  remediationBudget: number;
  remediationsUsed: number;
}

const EXECUTION_DECISIONS = new Set(["LAUNCH_CURSOR", "REUSE_CURSOR"]);

/**
 * Confirm Sol-selected work type is legally dispatchable under current
 * objective authority and transaction remediation budget.
 */
export function preflightWorkTypeDispatch(input: {
  decision: OrchestratorDecision;
  state: ProjectState;
  authority: ObjectiveAuthority;
}): WorkTypePreflightResult {
  const { decision, state, authority } = input;

  if (!EXECUTION_DECISIONS.has(decision.decision)) {
    return ok(null, state);
  }

  const cursor = decision.cursorInstruction;
  if (!cursor) {
    return fail(
      "MISSING_CURSOR_INSTRUCTION",
      "LAUNCH_CURSOR requires cursorInstruction for work-type preflight",
      null,
      state,
    );
  }

  const workType = cursor.workType;
  if (!authority.permittedWorkTypes.includes(workType)) {
    return fail(
      "WORK_TYPE_NOT_PERMITTED",
      `Work type ${workType} is not permitted by objective authority`,
      workType,
      state,
    );
  }

  const remediationBudget = state.currentTransaction?.remediationBudget ?? 0;
  const remediationsUsed = state.currentTransaction?.remediationsUsed ?? 0;

  if (workType === "REMEDIATION") {
    if (authority.remediationBudget === 0) {
      return fail(
        "REMEDIATION_BUDGET_ZERO_EXPLICIT",
        "Objective explicitly authorized remediationBudget=0; REMEDIATION dispatch rejected before external worker creation",
        workType,
        state,
      );
    }

    if (remediationBudget <= 0) {
      return fail(
        "REMEDIATION_BUDGET_EXHAUSTED_AT_START",
        `REMEDIATION dispatch rejected: transaction remediationBudget=${remediationBudget}`,
        workType,
        state,
      );
    }

    if (remediationsUsed >= remediationBudget) {
      return fail(
        "REMEDIATION_BUDGET_EXHAUSTED_AT_START",
        `REMEDIATION dispatch rejected: remediationsUsed ${remediationsUsed} >= budget ${remediationBudget}`,
        workType,
        state,
      );
    }
  }

  if (
    cursor.maxRemediationPasses > 0 &&
    remediationBudget <= 0 &&
    objectivePermitsRemediation(authority)
  ) {
    return fail(
      "REMEDIATION_BUDGET_EXHAUSTED_AT_START",
      `maxRemediationPasses=${cursor.maxRemediationPasses} but transaction remediationBudget=${remediationBudget}`,
      workType,
      state,
    );
  }

  return ok(workType, state);
}

function ok(
  workType: WorkType | null,
  state: ProjectState,
): WorkTypePreflightResult {
  return {
    ok: true,
    code: "PREFLIGHT_OK",
    summary: "Work type and budget preflight passed",
    workType,
    remediationBudget: state.currentTransaction?.remediationBudget ?? 0,
    remediationsUsed: state.currentTransaction?.remediationsUsed ?? 0,
  };
}

function fail(
  code: WorkTypePreflightCode,
  summary: string,
  workType: WorkType | null,
  state: ProjectState,
): WorkTypePreflightResult {
  return {
    ok: false,
    code,
    summary,
    workType,
    remediationBudget: state.currentTransaction?.remediationBudget ?? 0,
    remediationsUsed: state.currentTransaction?.remediationsUsed ?? 0,
  };
}
