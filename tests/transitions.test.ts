import { describe, expect, it } from "vitest";
import {
  isLegalTransition,
  legalModelTransitionTargets,
  legalOutgoingTransitions,
} from "../src/policy/transitions.js";
import type { RuntimeState } from "../src/types.js";

describe("transition source of truth", () => {
  it("PLANNING legal direct targets match normative contract", () => {
    const targets = legalOutgoingTransitions("PLANNING");
    expect(targets).toEqual([
      "IMPLEMENTING",
      "READY_FOR_HUMAN",
      "BLOCKED",
    ]);
  });

  it("WAITING_FOR_AGENT is NOT a direct legal target from PLANNING", () => {
    expect(legalOutgoingTransitions("PLANNING")).not.toContain(
      "WAITING_FOR_AGENT",
    );
    expect(isLegalTransition("PLANNING", "WAITING_FOR_AGENT")).toBe(false);
  });

  it("IMPLEMENTING IS legal from PLANNING", () => {
    expect(legalOutgoingTransitions("PLANNING")).toContain("IMPLEMENTING");
    expect(isLegalTransition("PLANNING", "IMPLEMENTING")).toBe(true);
  });

  it("IMPLEMENTING legal direct targets are generic (not Bellhop-specific)", () => {
    const targets = legalOutgoingTransitions("IMPLEMENTING");
    expect(targets).toEqual(["WAITING_FOR_AGENT"]);
    expect(targets).not.toContain("PLANNING");
  });

  it("VERIFYING legal direct targets match Phase 0 accepted table (no READY_FOR_HUMAN)", () => {
    const targets = legalOutgoingTransitions("VERIFYING");
    expect(targets).toEqual([
      "REVIEWING",
      "REMEDIATING",
      "BLOCKED",
    ]);
    // Phase 1 does not use VERIFYING → READY_FOR_HUMAN.
    // If normative docs later require it, that is DEFERRED_PHASE2_CONTRACT_ISSUE.
    expect(isLegalTransition("VERIFYING", "READY_FOR_HUMAN")).toBe(false);
  });

  it("WAITING_FOR_AGENT legal direct targets are generic", () => {
    const targets = legalOutgoingTransitions("WAITING_FOR_AGENT");
    expect(targets).toEqual(["VERIFYING", "BLOCKED"]);
  });

  it("model targets include same-state no-op plus table edges", () => {
    const modelTargets = legalModelTransitionTargets("PLANNING");
    expect(modelTargets[0]).toBe("PLANNING");
    expect(modelTargets).toContain("IMPLEMENTING");
    expect(modelTargets).not.toContain("WAITING_FOR_AGENT");
  });

  it("REVIEWING legal direct targets include Phase 3 continue + contract accept", () => {
    const targets = legalOutgoingTransitions("REVIEWING");
    expect(targets).toEqual([
      "REMEDIATING",
      "READY_FOR_HUMAN",
      "ACCEPTED",
      "PLANNING",
      "BLOCKED",
    ]);
    expect(isLegalTransition("REVIEWING", "PLANNING")).toBe(true);
    expect(isLegalTransition("REVIEWING", "ACCEPTED")).toBe(true);
    expect(isLegalTransition("REVIEWING", "IMPLEMENTING")).toBe(false);
  });

  it("isLegalTransition allows same-state no-op", () => {
    const states: RuntimeState[] = [
      "IDLE",
      "PLANNING",
      "IMPLEMENTING",
      "WAITING_FOR_AGENT",
    ];
    for (const s of states) {
      expect(isLegalTransition(s, s)).toBe(true);
    }
  });
});
