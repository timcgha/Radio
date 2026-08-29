import type { RuntimeState } from "../types.js";

/**
 * Default v0.1 legal runtime transitions from POLICY-ENGINE-CONTRACT.md §6.
 */
export const LEGAL_TRANSITIONS: ReadonlyArray<readonly [RuntimeState, RuntimeState]> = [
  ["IDLE", "PLANNING"],
  ["PLANNING", "IMPLEMENTING"],
  ["PLANNING", "READY_FOR_HUMAN"],
  ["PLANNING", "BLOCKED"],
  ["IMPLEMENTING", "WAITING_FOR_AGENT"],
  ["WAITING_FOR_AGENT", "VERIFYING"],
  ["WAITING_FOR_AGENT", "BLOCKED"],
  ["VERIFYING", "REVIEWING"],
  ["VERIFYING", "REMEDIATING"],
  ["VERIFYING", "BLOCKED"],
  ["REVIEWING", "REMEDIATING"],
  ["REVIEWING", "READY_FOR_HUMAN"],
  ["REVIEWING", "BLOCKED"],
  ["REMEDIATING", "WAITING_FOR_AGENT"],
  ["REMEDIATING", "VERIFYING"],
  ["REMEDIATING", "BLOCKED"],
  ["READY_FOR_HUMAN", "WAITING_FOR_HUMAN"],
  ["WAITING_FOR_HUMAN", "ACCEPTED"],
  ["WAITING_FOR_HUMAN", "BLOCKED"],
  ["WAITING_FOR_HUMAN", "PLANNING"],
  ["ACCEPTED", "IDLE"],
  ["BLOCKED", "IDLE"],
] as const;

const transitionSet = new Set(
  LEGAL_TRANSITIONS.map(([from, to]) => `${from}->${to}`),
);

export function isLegalTransition(from: RuntimeState, to: RuntimeState): boolean {
  if (from === to) {
    // Same-state is allowed only as a no-op style transition for non-mutating decisions.
    return true;
  }
  return transitionSet.has(`${from}->${to}`);
}

export const TERMINAL_RUNTIME_STATES: ReadonlySet<RuntimeState> = new Set([
  "ACCEPTED",
  "BLOCKED",
]);
