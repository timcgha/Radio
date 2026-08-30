import { describe, expect, it } from "vitest";
import { renderCursorPrompt } from "../src/cursor/prompt-renderer.js";
import {
  buildCursorWorkOrder,
  validateWorkOrder,
} from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { loadProjectState } from "../src/state/store.js";
import type { DecisionEnvelope, OrchestratorDecision } from "../src/types.js";
import { readJsonFile, resolveRepoPath } from "../src/util/io.js";

function setup() {
  const { state, fingerprint } = loadProjectState({ projectId: "bellhop", statePath: resolveRepoPath("fixtures", "state", "bellhop-planning-seed.json") });
  const decision = structuredClone(
    readJsonFile(
      resolveRepoPath("fixtures", "decisions", "bellhop-legal-launch-cursor.json"),
    ),
  ) as OrchestratorDecision;
  const envelope: DecisionEnvelope = {
    schemaVersion: "phase0-1.0",
    decisionId: decision.decisionId,
    projectId: "bellhop",
    workstreamId: "radio-pilot-01",
    transactionId: "bellhop-radio-pilot-01-stage2-verification",
    stateRevision: state.stateRevision,
    requestFingerprint: fingerprint,
    model: "gpt-5.6-sol",
    mode: "fixture",
    generatedAt: new Date().toISOString(),
    cursorExecutionEnabled: false,
    notes: [],
  };
  const policy = evaluatePolicy({
    decision,
    state,
    envelope,
    currentFingerprint: fingerprint,
  });
  const workOrder = buildCursorWorkOrder({ state, decision, policy });
  return { workOrder, prompt: renderCursorPrompt(workOrder) };
}

describe("work order", () => {
  it("validates against canonical schema and contains expected pins", () => {
    const { workOrder } = setup();
    expect(() => validateWorkOrder(workOrder)).not.toThrow();
    expect(workOrder.source.repository).toBe(
      "https://github.com/timcgha/Bellhop",
    );
    expect(workOrder.source.canonicalMainBranch).toBe("level3");
    expect(workOrder.source.canonicalMainSha).toBe("d1e7f10");
    expect(workOrder.source.baseBranch).toBe(
      "cursor/level4-stage2-asteroid-garden-9dce",
    );
    expect(workOrder.source.expectedBaseTipSha).toBe(
      "aa512d6ef721f855be33ddc36da490f9de66dc23",
    );
    expect(workOrder.scope.allowedProductChanges).toEqual([]);
    expect(workOrder.pr.creationAllowed).toBe(false);
    expect(workOrder.pr.mergeAllowed).toBe(false);
    expect(workOrder.budgets.maxRemediationPasses).toBe(0);
    expect(workOrder.budgets.maxAgents).toBe(1);
  });
});

describe("prompt", () => {
  it("renders structurally separated requested work, verification criteria, and Radio guardrails", () => {
    const { prompt, workOrder } = setup();
    expect(workOrder.requestedWork.length).toBeGreaterThan(0);
    expect(workOrder.verificationCriteria.length).toBeGreaterThan(0);
    expect(workOrder.radioGuardrails.length).toBeGreaterThan(0);
    const reqIdx = prompt.indexOf("REQUESTED WORK");
    const verIdx = prompt.indexOf("ACCEPTANCE / VERIFICATION CRITERIA");
    const gIdx = prompt.indexOf("RADIO ENFORCED GUARDRAILS");
    expect(reqIdx).toBeGreaterThan(-1);
    expect(verIdx).toBeGreaterThan(reqIdx);
    expect(gIdx).toBeGreaterThan(verIdx);
    expect(prompt).toContain(workOrder.requestedWork);
    expect(prompt).toContain(workOrder.verificationCriteria);
  });

  it("states agent requirement near the top and includes hard boundaries", () => {
    const { prompt } = setup();
    const head = prompt.slice(0, 200);
    expect(head).toMatch(/AGENT REQUIREMENT:\s*FRESH ORDINARY AGENT REQUIRED/);
    expect(prompt.toLowerCase()).toMatch(/gameplay/);
    expect(prompt).toMatch(/Do NOT merge/i);
    expect(prompt).toMatch(/Do NOT deploy/i);
    expect(prompt).toMatch(/Do NOT start Stage 3/i);
    expect(prompt).toMatch(/Do NOT retune flight/i);
    expect(prompt).toMatch(
      /exactly one fenced `text` code block/i,
    );
    expect(prompt).toMatch(/Nothing before it/);
    expect(prompt).toMatch(/Nothing after it/);
  });

  it("requires exact full HEAD SHA with authorized materialization on mismatch", () => {
    const { prompt, workOrder } = setup();
    const FULL = "aa512d6ef721f855be33ddc36da490f9de66dc23";
    expect(workOrder.source.expectedBaseTipSha).toBe(FULL);
    expect(prompt).toContain("REPOSITORY INTEGRITY — MANDATORY FIRST CHECK");
    expect(prompt).toContain(`Required exact value (Radio-authorized trusted SHA): ${FULL}`);
    expect(prompt).toMatch(new RegExp(`HEAD must exactly equal ${FULL}`));
    expect(prompt).toMatch(/AUTHORIZED and REQUIRED to materialize/);
    expect(prompt).toMatch(/STOP immediately/);
    expect(prompt).not.toMatch(/Do NOT attempt git reset\/checkout/);
    expect(prompt.indexOf("git rev-parse HEAD")).toBeLessThan(
      prompt.indexOf("node tests/run.js"),
    );
  });
});
