import { describe, expect, it } from "vitest";
import {
  isValidDecision,
  validateDecision,
} from "../src/orchestrator/decision-validator.js";
import { readJsonFile, resolveRepoPath } from "../src/util/io.js";

describe("decision validation", () => {
  it("valid fixture passes", () => {
    const fixture = readJsonFile(
      resolveRepoPath("fixtures", "decisions", "bellhop-legal-launch-cursor.json"),
    );
    expect(isValidDecision(fixture)).toBe(true);
    const decision = validateDecision(fixture);
    expect(decision.decision).toBe("LAUNCH_CURSOR");
    expect(decision.cursorInstruction?.agentAction).toBe(
      "FRESH_ORDINARY_AGENT_REQUIRED",
    );
  });

  it("malformed fixture fails", () => {
    expect(isValidDecision({ decision: "LAUNCH_CURSOR" })).toBe(false);
    expect(() => validateDecision({ not: "a decision" })).toThrow(
      /Decision schema validation failed/,
    );
  });
});
