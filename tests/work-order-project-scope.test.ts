import { describe, expect, it } from "vitest";
import { renderCursorPrompt } from "../src/cursor/prompt-renderer.js";
import {
  buildCursorWorkOrder,
  validateWorkOrder,
} from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { loadObjectiveAuthority } from "../src/runtime/objective-authority.js";
import { DEFAULT_APPROVED_CURSOR_WORKER_MODEL } from "../src/runtime/cursor-worker-model.js";
import { loadProjectState } from "../src/state/store.js";
import type { DecisionEnvelope, OrchestratorDecision } from "../src/types.js";
import { readJsonFile, resolveRepoPath } from "../src/util/io.js";

const BELLHOP_MARKERS = [
  "bellhop",
  "stage 1.5",
  "flight retune",
  "node tests/run.js",
  "node build.js",
  "asteroid garden",
  "star beam",
  "stage 3",
];

const CYBER_ASSURANCE_MARKERS = [
  "cyber assurance",
  "wave 1",
  "wave 2",
  "failure controller",
  "npm test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "test:ux-wave1",
];

function baseEnvelope(
  state: ReturnType<typeof loadProjectState>["state"],
  fingerprint: string,
  decisionId: string,
): DecisionEnvelope {
  return {
    schemaVersion: "phase0-1.0",
    decisionId,
    projectId: state.project.id,
    workstreamId: state.activeWorkstream?.id ?? "unknown",
    transactionId: state.currentTransaction?.id ?? "unknown",
    stateRevision: state.stateRevision,
    requestFingerprint: fingerprint,
    model: "gpt-5.6-sol",
    mode: "fixture",
    generatedAt: new Date().toISOString(),
    cursorExecutionEnabled: false,
    notes: [],
  };
}

function evaluateUx028Launch() {
  const { state, fingerprint } = loadProjectState({
    projectId: "cyber-assurance",
    statePath: resolveRepoPath(
      "fixtures",
      "state",
      "cyber-assurance-ux028-dispatch-seed.json",
    ),
  });
  const decision = structuredClone(
    readJsonFile(
      resolveRepoPath(
        "fixtures",
        "decisions",
        "cyber-assurance-ux028-implementation-launch.json",
      ),
    ),
  ) as OrchestratorDecision;
  const policy = evaluatePolicy({
    decision,
    state,
    envelope: baseEnvelope(state, fingerprint, decision.decisionId),
    currentFingerprint: fingerprint,
  });
  expect(policy.result).toBe("ALLOW");
  const objectiveAuthority = loadObjectiveAuthority(
    resolveRepoPath(
      "fixtures",
      "phase3",
      "cyber-assurance-ux028-objective-authority.json",
    ),
  );
  const workOrder = buildCursorWorkOrder({
    state,
    decision,
    policy,
    objectiveAuthority,
    workerModel: DEFAULT_APPROVED_CURSOR_WORKER_MODEL,
  });
  return { state, decision, workOrder, prompt: renderCursorPrompt(workOrder) };
}

function evaluateBellhopLaunch() {
  const { state, fingerprint } = loadProjectState({
    projectId: "bellhop",
    statePath: resolveRepoPath("fixtures", "state", "bellhop-planning-seed.json"),
  });
  const decision = structuredClone(
    readJsonFile(
      resolveRepoPath("fixtures", "decisions", "bellhop-legal-launch-cursor.json"),
    ),
  ) as OrchestratorDecision;
  const policy = evaluatePolicy({
    decision,
    state,
    envelope: baseEnvelope(state, fingerprint, decision.decisionId),
    currentFingerprint: fingerprint,
  });
  expect(policy.result).toBe("ALLOW");
  const workOrder = buildCursorWorkOrder({ state, decision, policy });
  return { state, decision, workOrder, prompt: renderCursorPrompt(workOrder) };
}

function scopeBlob(workOrder: ReturnType<typeof buildCursorWorkOrder>): string {
  return JSON.stringify({
    inScope: workOrder.scope.inScope,
    outOfScope: workOrder.scope.outOfScope,
    protectedSemantics: workOrder.scope.protectedSemantics,
    requirements: workOrder.requirements,
    verification: workOrder.verification.requiredCommands,
    guardrails: workOrder.radioGuardrails,
  }).toLowerCase();
}

describe("project-specific work-order scope", () => {
  it("CYBER_ASSURANCE_WORK_ORDER_HAS_CYBER_ASSURANCE_SCOPE=true", () => {
    const { workOrder } = evaluateUx028Launch();
    const blob = scopeBlob(workOrder);
    expect(blob).toMatch(/cyber assurance/);
    expect(blob).toMatch(/wave 1/);
    expect(blob).toMatch(/verification-integrity/);
    expect(() => validateWorkOrder(workOrder)).not.toThrow();
  });

  it("CYBER_ASSURANCE_WORK_ORDER_HAS_BELLHOP_SCOPE=false", () => {
    const { workOrder, prompt } = evaluateUx028Launch();
    const blob = `${scopeBlob(workOrder)}\n${prompt.toLowerCase()}`;
    for (const marker of BELLHOP_MARKERS) {
      expect(blob).not.toContain(marker);
    }
  });

  it("CYBER_ASSURANCE_VERIFICATION_COMMANDS_CORRECT=true", () => {
    const { workOrder } = evaluateUx028Launch();
    expect(workOrder.verification.requiredCommands).toEqual([
      "npm test",
      "npm run typecheck",
      "npm run lint",
      "npm run build",
      "npm run test:ux-wave1",
      "git status --short",
    ]);
    for (const cmd of CYBER_ASSURANCE_MARKERS.filter((m) => m.startsWith("npm"))) {
      expect(
        workOrder.verification.requiredCommands.join(" ").toLowerCase(),
      ).toContain(cmd);
    }
    expect(workOrder.verification.requiredCommands).not.toContain("node tests/run.js");
    expect(workOrder.verification.requiredCommands).not.toContain("node build.js");
  });

  it("BELLHOP_WORK_ORDER_HAS_BELLHOP_SCOPE=true", () => {
    const { workOrder } = evaluateBellhopLaunch();
    const blob = scopeBlob(workOrder);
    expect(blob).toMatch(/bellhop/);
    expect(blob).toMatch(/node tests\/run\.js/);
    expect(blob).toMatch(/node build\.js/);
    expect(blob).toMatch(/stage 1\.5/);
  });

  it("BELLHOP_WORK_ORDER_HAS_CYBER_ASSURANCE_SCOPE=false", () => {
    const { workOrder, prompt } = evaluateBellhopLaunch();
    const blob = `${scopeBlob(workOrder)}\n${prompt.toLowerCase()}`;
    for (const marker of CYBER_ASSURANCE_MARKERS) {
      expect(blob).not.toContain(marker);
    }
  });

  it("BELLHOP_VERIFICATION_COMMANDS_UNCHANGED=true", () => {
    const { workOrder } = evaluateBellhopLaunch();
    expect(workOrder.verification.requiredCommands).toEqual([
      "node tests/run.js",
      "node build.js",
      "git status --short",
    ]);
  });

  it("UX028_RENDERED_WORK_ORDER_TEST: prompt uses Cyber Assurance scope and commands", () => {
    const { workOrder, prompt, decision } = evaluateUx028Launch();
    expect(workOrder.projectId).toBe("cyber-assurance");
    expect(workOrder.source.repository).toBe(
      "https://github.com/timcgha/Cyber-assurance-demo",
    );
    expect(workOrder.agentAction).toBe("FRESH_ORDINARY_AGENT_REQUIRED");
    expect(prompt).toContain(decision.cursorInstruction!.requestedWork);
    expect(prompt).toContain(decision.cursorInstruction!.verificationCriteria);
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("npm run test:ux-wave1");
    expect(prompt.toLowerCase()).not.toContain("asteroid garden");
    expect(prompt.toLowerCase()).not.toContain("flight retune");
    expect(prompt.toLowerCase()).not.toContain("node tests/run.js");
  });
});
