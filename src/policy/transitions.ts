import type { RuntimeState } from "../types.js";

/**
 * Default v0.1 legal runtime transitions from POLICY-ENGINE-CONTRACT.md §6.
 *
 * Single source of truth for:
 * - policy validation (`isLegalTransition`)
 * - Sol model-facing schema narrowing (`legalOutgoingTransitions`)
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
  ["VERIFYING", "READY_FOR_HUMAN"],
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

/**
 * Direct outgoing targets from `from` according to the normative transition table.
 * Does not include same-state no-ops.
 */
export function legalOutgoingTransitions(from: RuntimeState): RuntimeState[] {
  return LEGAL_TRANSITIONS.filter(([edgeFrom]) => edgeFrom === from).map(
    ([, to]) => to,
  );
}

/**
 * Targets Sol may propose from `from` in a Structured Output schema.
 * Includes same-state no-ops (allowed by `isLegalTransition` for non-mutating decisions)
 * plus every direct table edge.
 */
export function legalModelTransitionTargets(from: RuntimeState): RuntimeState[] {
  const outgoing = legalOutgoingTransitions(from);
  if (outgoing.includes(from)) {
    return outgoing;
  }
  return [from, ...outgoing];
}

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
