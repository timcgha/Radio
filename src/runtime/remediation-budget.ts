/**
 * Transaction remediation budget alignment with ObjectiveAuthority.
 *
 * When REMEDIATION is a permitted work type, the transaction remediation budget
 * derives from project-state authority.defaultRemediationBudgetPerTransaction
 * (schema: integer 0–1). Objectives without REMEDIATION retain budget 0.
 */

import type { ObjectiveAuthority, ProjectState, WorkType } from "../types.js";

export function remediationBudgetAuthorizedByObjective(
  permittedWorkTypes: WorkType[] | readonly WorkType[],
): boolean {
  return permittedWorkTypes.includes("REMEDIATION");
}

/**
 * Smallest legal non-zero remediation budget for one remediation dispatch.
 * Schema caps defaultRemediationBudgetPerTransaction at 1.
 */
export function resolveEffectiveRemediationBudget(input: {
  permittedWorkTypes: WorkType[] | readonly WorkType[];
  defaultRemediationBudgetPerTransaction: number;
}): number {
  if (!remediationBudgetAuthorizedByObjective(input.permittedWorkTypes)) {
    return 0;
  }
  const configured = Math.floor(
    Number(input.defaultRemediationBudgetPerTransaction),
  );
  if (!Number.isFinite(configured) || configured < 1) {
    return 0;
  }
  return Math.min(1, configured);
}

export function isRemediationBudgetExhausted(input: {
  remediationBudget: number;
  remediationsUsed: number;
}): boolean {
  return (
    input.remediationBudget <= 0 ||
    input.remediationsUsed >= input.remediationBudget
  );
}

/**
 * Align currentTransaction remediation budget when objective permits REMEDIATION.
 * Never expands beyond project authority.defaultRemediationBudgetPerTransaction.
 */
export function alignRemediationBudgetWithObjectiveAuthority(
  state: ProjectState,
  authority: ObjectiveAuthority,
): ProjectState {
  const txn = state.currentTransaction;
  if (!txn) return state;

  const budget = resolveEffectiveRemediationBudget({
    permittedWorkTypes: authority.permittedWorkTypes,
    defaultRemediationBudgetPerTransaction:
      state.authority.defaultRemediationBudgetPerTransaction,
  });
  const exhausted = isRemediationBudgetExhausted({
    remediationBudget: budget,
    remediationsUsed: txn.remediationsUsed,
  });

  if (txn.remediationBudget === budget && txn.remediationBudgetExhausted === exhausted) {
    return state;
  }

  return {
    ...state,
    currentTransaction: {
      ...txn,
      remediationBudget: budget,
      remediationBudgetExhausted: exhausted,
    },
  };
}
