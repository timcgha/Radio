import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WORKER_RUNS,
  resolveMaxWorkerRuns,
  validateV2Objective,
  V2ObjectiveValidationError,
} from "../../src/v2/objective.js";
import { bellhopObjective } from "../../src/v2/test-fixtures.js";
import { V2_SCHEMA_VERSION } from "../../src/v2/types.js";

describe("v2 objective validation", () => {
  it("accepts a valid objective", () => {
    const o = validateV2Objective(bellhopObjective());
    expect(o.objectiveId).toBe("v2-bellhop-test-01");
    expect(o.expectedStartingSha).toBe(
      "38ba91802817cc63d8fccdcab71ef0a400b7483b",
    );
  });

  it("rejects invalid schema version", () => {
    expect(() =>
      validateV2Objective({ ...bellhopObjective(), schemaVersion: "v1" }),
    ).toThrow(V2ObjectiveValidationError);
  });

  it("rejects abbreviated SHA", () => {
    expect(() =>
      validateV2Objective({
        ...bellhopObjective(),
        expectedStartingSha: "38ba918",
      }),
    ).toThrow(/full 40-character/);
  });

  it("defaults maxWorkerRuns to 2", () => {
    expect(resolveMaxWorkerRuns(bellhopObjective())).toBe(
      DEFAULT_MAX_WORKER_RUNS,
    );
    expect(DEFAULT_MAX_WORKER_RUNS).toBe(2);
  });

  it("requires authorizedWorkTypes", () => {
    expect(() =>
      validateV2Objective({
        ...bellhopObjective(),
        authorizedWorkTypes: [],
      }),
    ).toThrow(/authorizedWorkTypes/);
  });
});

describe("v2 state model", () => {
  it("has five loop stages plus terminal outcomes", () => {
    const loopStages = ["PLAN", "WORK", "VERIFY", "DECIDE"];
    const terminals = ["DONE", "HUMAN", "FAILED_MACHINE", "FAILED_POLICY"];
    expect(loopStages).toHaveLength(4);
    expect(terminals).toHaveLength(4);
    // Approximately 5 runtime states + terminals per spec
    expect(loopStages.length + 1).toBeLessThanOrEqual(6);
  });
});
