import type { CursorInstruction } from "../types.js";

/**
 * Structured executable semantics for Radio authority checks.
 *
 * Sol may author requestedWork + verificationCriteria separately.
 * Radio generates guardrails separately when rendering the worker prompt.
 *
 * Objective authority and P4 human-gated detection MUST evaluate only this
 * executable view — never verificationCriteria, never Radio guardrails, and
 * never the final rendered Cursor prompt.
 */
export function executableScopeText(
  instruction: Pick<CursorInstruction, "objective" | "requestedWork">,
): string {
  return `${instruction.objective}\n${instruction.requestedWork}`;
}

/**
 * Live / schema path: requestedWork is mandatory on LAUNCH/REUSE decisions.
 * Fail closed — do not fall back to legacy combined prompt prose.
 */
export function requireRequestedWork(
  instruction: CursorInstruction | null | undefined,
): string {
  const work = instruction?.requestedWork?.trim() ?? "";
  if (!work) {
    throw new Error(
      "LIVE_STRUCTURE_REQUIRED: cursorInstruction.requestedWork is required before Cursor external write; legacy combined prompt fallback is not allowed",
    );
  }
  return work;
}
