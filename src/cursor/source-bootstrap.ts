/**
 * Authorized Cursor workspace source materialization (Option B).
 *
 * Live evidence (-07): POST /v1/agents correctly included repos[0].startingRef
 * = trusted branch, Cursor accepted/echoed it, yet the cloud workspace still
 * initialized on the repository default branch (main) at a different SHA.
 *
 * Radio therefore authorizes a deterministic pre-edit bootstrap that materializes
 * the ObjectiveAuthority-trusted full SHA inside the worker workspace. The
 * worker does not choose the source — it materializes Radio's already-verified
 * pin. HEAD after bootstrap must exactly equal the trusted full SHA before any
 * product inspection/edit. Worker prose claiming checkout is not authority.
 */

export const SOURCE_FIDELITY_MODE =
  "OPTION_B_AUTHORIZED_MATERIALIZATION" as const;

/** Continuation model for multi-worker launches (acknowledged Phase 3 limit). */
export const CONTINUATION_SOURCE_MODEL =
  "ORIGINAL_OBJECTIVE_AUTHORITY_BASE_EVERY_WORKER" as const;

export const CONTINUATION_BRANCH_CHAINING_LIMITATION =
  "CONTINUATION_BRANCH_CHAINING_LIMITATION" as const;

export interface AuthorizedSourceIdentity {
  branch: string;
  expectedFullSha: string;
  repository: string;
}

export interface SourceBootstrapOutcome {
  productWorkPermitted: boolean;
  observedHeadSha: string;
  trustedSha: string;
  materializationAttempted: boolean;
  materializationSucceeded: boolean;
  reason: string;
}

/**
 * Deterministic model of required worker pre-edit source fidelity.
 * Used by regression tests to lock the -07 shape:
 *   trusted: level3 / 847ca2d64090aaeb94ca681b651a44062ab9f644
 *   initial cloud workspace: main / 6b5cc0f0218e40d1061927df685ad328a60f84b0
 */
export function evaluateAuthorizedSourceBootstrap(input: {
  trusted: AuthorizedSourceIdentity;
  initialWorkspace: { branch: string; headSha: string };
  /** Simulated result of Radio-authorized fetch/checkout of the trusted SHA. */
  checkoutResult: "SUCCESS" | "FAILURE";
}): SourceBootstrapOutcome {
  const trustedSha = input.trusted.expectedFullSha.trim().toLowerCase();
  const initialHead = input.initialWorkspace.headSha.trim().toLowerCase();

  if (initialHead === trustedSha) {
    return {
      productWorkPermitted: true,
      observedHeadSha: input.trusted.expectedFullSha,
      trustedSha: input.trusted.expectedFullSha,
      materializationAttempted: false,
      materializationSucceeded: true,
      reason: "WORKSPACE_ALREADY_ON_TRUSTED_SHA",
    };
  }

  if (input.checkoutResult === "FAILURE") {
    return {
      productWorkPermitted: false,
      observedHeadSha: input.initialWorkspace.headSha,
      trustedSha: input.trusted.expectedFullSha,
      materializationAttempted: true,
      materializationSucceeded: false,
      reason: "TRUSTED_CHECKOUT_FAILED_STOP",
    };
  }

  return {
    productWorkPermitted: true,
    observedHeadSha: input.trusted.expectedFullSha,
    trustedSha: input.trusted.expectedFullSha,
    materializationAttempted: true,
    materializationSucceeded: true,
    reason: "TRUSTED_CHECKOUT_SUCCESS",
  };
}

/**
 * True when a second FRESH worker launched from the original ObjectiveAuthority
 * base cannot be assumed to contain worker #1's unmerged product changes.
 */
export function secondFreshWorkerLacksPriorUnmergedChanges(input: {
  continuationSourceModel: string;
  secondActionRequiresWorker1UnmergedChanges: boolean;
}): {
  code: typeof CONTINUATION_BRANCH_CHAINING_LIMITATION | "OK";
  shouldStopRatherThanLaunchIneffectiveWorker: boolean;
} {
  if (
    input.continuationSourceModel === CONTINUATION_SOURCE_MODEL &&
    input.secondActionRequiresWorker1UnmergedChanges
  ) {
    return {
      code: CONTINUATION_BRANCH_CHAINING_LIMITATION,
      shouldStopRatherThanLaunchIneffectiveWorker: true,
    };
  }
  return {
    code: "OK",
    shouldStopRatherThanLaunchIneffectiveWorker: false,
  };
}
