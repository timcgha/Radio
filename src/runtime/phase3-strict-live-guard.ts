/**
 * Strict live Phase 3 entry guards — fail closed before Sol/Cursor work.
 *
 * Used by project-specific strict live entrypoints (Cyber Assurance).
 * Does not alter global fixture/test memory lease behavior.
 */

import type { Phase3LoopConfig } from "./phase3.js";
import {
  resolveObjectiveLeaseStore,
  type ObjectiveLeaseStore,
} from "./objective-lease.js";

export const LIVE_CYBER_PHASE3_MEMORY_LEASE_ALLOWED = false;
export const LIVE_INITIAL_DECISION_INJECTION_ALLOWED = false;

export type StrictPhase3LiveStage =
  | "SOURCE_VERIFIED"
  | "LEASE_ACQUIRED"
  | "SOL_INITIAL"
  | "CURSOR_CREATE";

/**
 * Resolve the production git-remote-ref lease store for strict live entry.
 * Rejects memory and any non-git-remote-ref backend.
 */
export function resolveStrictLiveObjectiveLeaseStore(input?: {
  env?: NodeJS.ProcessEnv;
  /** Test injection — must still report backend git-remote-ref. */
  store?: ObjectiveLeaseStore;
}): ObjectiveLeaseStore {
  if (input?.store) {
    assertStrictLiveLeaseBackend(input.store);
    return input.store;
  }
  const env = input?.env ?? process.env;
  const strictEnv: NodeJS.ProcessEnv = {
    ...env,
    RADIO_OBJECTIVE_LEASE_BACKEND: "git-remote-ref",
  };
  const store = resolveObjectiveLeaseStore({ env: strictEnv });
  assertStrictLiveLeaseBackend(store);
  return store;
}

export function assertStrictLiveLeaseBackend(store: ObjectiveLeaseStore): void {
  if (store.backend !== "git-remote-ref") {
    throw new Error(
      `STRICT_LIVE_LEASE_BACKEND_REQUIRED: git-remote-ref mandatory for strict live Phase 3; got ${store.backend}`,
    );
  }
}

/**
 * Strict live entrypoints must obtain the initial decision via callSol,
 * not via config.initialDecision injection.
 */
export function assertStrictLiveNoInitialDecisionInjection(
  config: Pick<Phase3LoopConfig, "mode" | "initialDecision">,
): void {
  if (
    config.mode === "live" &&
    config.initialDecision &&
    !LIVE_INITIAL_DECISION_INJECTION_ALLOWED
  ) {
    throw new Error(
      "LIVE_INITIAL_DECISION_INJECTION_REJECTED: strict live Phase 3 requires callSol initial decision",
    );
  }
}

export function assertStrictLiveOrdering(stages: StrictPhase3LiveStage[]): void {
  const expected: StrictPhase3LiveStage[] = [
    "SOURCE_VERIFIED",
    "LEASE_ACQUIRED",
    "SOL_INITIAL",
    "CURSOR_CREATE",
  ];
  let cursor = 0;
  for (const stage of stages) {
    const idx = expected.indexOf(stage, cursor);
    if (idx < cursor) {
      throw new Error(
        `STRICT_PHASE3_ORDER_VIOLATION: ${stage} out of order; observed ${stages.join(" → ")}`,
      );
    }
    cursor = idx + 1;
  }
}
