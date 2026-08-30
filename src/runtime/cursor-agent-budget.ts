/**
 * Transaction Cursor-agent budget alignment with ObjectiveAuthority.
 *
 * ObjectiveAuthority.maxCursorAgents is the human-authorized upper bound.
 * Radio must never exceed it. For the Phase 3 pilot, when no separately
 * human-authorized stricter transaction cap exists, the transaction
 * allowance derives from the objective max — not a stale Stage-2 default of 1.
 */

import type { ObjectiveAuthority, ProjectState } from "../types.js";

export function resolveEffectiveMaxCursorAgentsPerTransaction(input: {
  objectiveMaxCursorAgents: number;
  /**
   * Optional separately human-authorized stricter transaction cap.
   * When null/undefined, the objective max is used as the effective max.
   */
  explicitStricterTransactionCap?: number | null;
}): number {
  const objMax = Math.max(0, Math.floor(Number(input.objectiveMaxCursorAgents)));
  if (objMax < 1) return 0;
  const stricter = input.explicitStricterTransactionCap;
  if (
    stricter != null &&
    Number.isFinite(stricter) &&
    Math.floor(Number(stricter)) >= 1
  ) {
    return Math.min(objMax, Math.floor(Number(stricter)));
  }
  return objMax;
}

/**
 * Align project-state transaction Cursor-agent budget to the active objective.
 * Never expands beyond ObjectiveAuthority.maxCursorAgents.
 */
export function alignStateBudgetsWithObjectiveAuthority(
  state: ProjectState,
  authority: ObjectiveAuthority,
  options?: { explicitStricterTransactionCap?: number | null },
): ProjectState {
  const effective = resolveEffectiveMaxCursorAgentsPerTransaction({
    objectiveMaxCursorAgents: authority.maxCursorAgents,
    explicitStricterTransactionCap: options?.explicitStricterTransactionCap,
  });
  if (state.budgets.maxCursorAgentsPerTransaction === effective) {
    return state;
  }
  return {
    ...state,
    budgets: {
      ...state.budgets,
      maxCursorAgentsPerTransaction: effective,
    },
  };
}

/**
 * Work-order maxAgents when an objective is active:
 * use the objective max (never expand past it). Stale Stage-2 state caps
 * (e.g. 1) must not silently throttle an authorized objective max of 3.
 * Without an objective, fall back to project-state transaction cap.
 */
export function resolveWorkOrderMaxAgents(input: {
  stateMaxCursorAgentsPerTransaction: number;
  objectiveMaxCursorAgents?: number | null;
}): number {
  const stateCap = Math.max(
    0,
    Math.floor(Number(input.stateMaxCursorAgentsPerTransaction)),
  );
  const objMax = input.objectiveMaxCursorAgents;
  if (objMax != null && Number.isFinite(objMax) && objMax >= 1) {
    const obj = Math.floor(Number(objMax));
    // Defense: never exceed objective even if state is inflated.
    if (stateCap > obj) return obj;
    return obj;
  }
  return Math.max(1, stateCap);
}
