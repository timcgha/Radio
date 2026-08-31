/**
 * Deterministic product-scope human gate for v2.
 *
 * Only flags when objective explicitly authorizes test-only scope
 * and changed files fall outside configured test path prefixes.
 */

import type { V2Objective, V2VerifiedFacts } from "./types.js";

export interface V2ScopeGateResult {
  requiresHuman: boolean;
  reason: string | null;
}

export function evaluateProductScopeGate(input: {
  objective: V2Objective;
  verifiedFacts: V2VerifiedFacts;
  workerClaimsProductBehaviorChanged: boolean | null;
}): V2ScopeGateResult {
  if (!input.objective.testOnlyScope) {
    return { requiresHuman: false, reason: null };
  }

  const prefixes = input.objective.testPathPrefixes ?? ["tests/"];
  const nonTestFiles = input.verifiedFacts.changedFiles.filter(
    (f) => !prefixes.some((p) => f.startsWith(p)),
  );

  if (nonTestFiles.length > 0) {
    return {
      requiresHuman: true,
      reason: `test-only objective but non-test files changed: ${nonTestFiles.join(", ")}`,
    };
  }

  if (input.workerClaimsProductBehaviorChanged === true) {
    return {
      requiresHuman: true,
      reason: "worker reports product behavior changed under test-only scope",
    };
  }

  return { requiresHuman: false, reason: null };
}
