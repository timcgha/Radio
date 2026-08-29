import { describe, expect, it } from "vitest";
import { computeStateFingerprint } from "../src/state/fingerprint.js";
import { loadProjectState } from "../src/state/store.js";
import type { ProjectState } from "../src/types.js";
import { getSchemaValidator, resolveRepoPath } from "../src/util/io.js";

describe("state", () => {
  it("loads and validates canonical Bellhop PROJECT-STATE.json (VERIFYING after Phase 1)", () => {
    const { state, fingerprint, path } = loadProjectState({ projectId: "bellhop" });
    expect(path).toBe(resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"));
    expect(state.project.id).toBe("bellhop");
    expect(state.stateRevision).toBe(6);
    expect(state.radioRuntime.state).toBe("VERIFYING");
    expect(state.activeAgent?.status).toBe("COMPLETED");
    expect(state.currentTransaction?.id).toBe(
      "bellhop-radio-pilot-01-stage2-verification",
    );
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads immutable PLANNING seed for Phase 0/1 regression", () => {
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: resolveRepoPath("fixtures", "state", "bellhop-planning-seed.json"),
    });
    expect(state.stateRevision).toBe(1);
    expect(state.radioRuntime.state).toBe("PLANNING");
    expect(state.activeAgent).toBeNull();
  });

  it("rejects invalid state", () => {
    const validate = getSchemaValidator("project-state.schema.json");
    const bad = { schemaVersion: 1 };
    expect(validate(bad)).toBe(false);
  });

  it("same material state produces the same fingerprint", () => {
    const { state } = loadProjectState({ projectId: "bellhop" });
    const a = computeStateFingerprint(state);
    const b = computeStateFingerprint(structuredClone(state));
    expect(a).toBe(b);
  });

  it("material state change produces a different fingerprint", () => {
    const { state } = loadProjectState({ projectId: "bellhop" });
    const modified: ProjectState = structuredClone(state);
    modified.currentTransaction!.branchTipSha = "deadbeef";
    expect(computeStateFingerprint(modified)).not.toBe(
      computeStateFingerprint(state),
    );

    const withAgent: ProjectState = structuredClone(state);
    withAgent.activeAgent = { agentId: "agent-1", status: "RUNNING" };
    expect(computeStateFingerprint(withAgent)).not.toBe(
      computeStateFingerprint(state),
    );

    const withBudget: ProjectState = structuredClone(state);
    withBudget.currentTransaction!.remediationBudget = 1;
    expect(computeStateFingerprint(withBudget)).not.toBe(
      computeStateFingerprint(state),
    );
  });
});
