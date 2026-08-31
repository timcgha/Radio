/**
 * Remediation budget resolution — distinguish UNSPECIFIED from EXPLICIT ZERO.
 *
 * An unspecified objective remediation budget inherits the project's canonical
 * defaultRemediationBudgetPerTransaction when REMEDIATION is permitted.
 * An explicit zero remains zero.
 */

import type { ObjectiveAuthority, ProjectState } from "../types.js";

export type RemediationBudgetSource =
  | "EXPLICIT_OBJECTIVE"
  | "PROJECT_DEFAULT"
  | "NOT_APPLICABLE";

export interface ResolvedRemediationBudget {
  budget: number;
  source: RemediationBudgetSource;
  /** True when objective authority explicitly authorized remediationBudget=0. */
  explicitZero: boolean;
}

export function objectivePermitsRemediation(
  authority: ObjectiveAuthority,
): boolean {
  return authority.permittedWorkTypes.includes("REMEDIATION");
}

/**
 * Resolve transaction remediation budget for a new objective transaction.
 */
export function resolveRemediationBudget(input: {
  authority: ObjectiveAuthority;
  state: ProjectState;
}): ResolvedRemediationBudget {
  const { authority, state } = input;
  const explicit = authority.remediationBudget;

  if (explicit !== undefined && explicit !== null) {
    const budget = Math.max(0, Math.min(1, Math.floor(Number(explicit))));
    return {
      budget,
      source: "EXPLICIT_OBJECTIVE",
      explicitZero: budget === 0,
    };
  }

  if (!objectivePermitsRemediation(authority)) {
    return {
      budget: 0,
      source: "NOT_APPLICABLE",
      explicitZero: false,
    };
  }

  const projectDefault = Math.max(
    0,
    Math.min(
      1,
      Math.floor(
        Number(state.authority.defaultRemediationBudgetPerTransaction ?? 0),
      ),
    ),
  );

  return {
    budget: projectDefault,
    source: "PROJECT_DEFAULT",
    explicitZero: false,
  };
}

export function remediationBudgetExhausted(
  budget: number,
  used: number,
): boolean {
  return budget <= 0 || used >= budget;
}
