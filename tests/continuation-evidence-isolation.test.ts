import { describe, expect, it } from "vitest";
import { buildContinuationContext } from "../src/orchestrator/continuation-context.js";
import {
  assertProjectContextIsolation,
  contextContainsForeignProjectLeak,
  extractTrustedContinuationUserSection,
  UNTRUSTED_WORKER_EVIDENCE_SECTION_MARKER,
} from "../src/orchestrator/context-isolation.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { loadObjectiveAuthority } from "../src/runtime/objective-authority.js";
import { DEFAULT_APPROVED_CURSOR_WORKER_MODEL } from "../src/runtime/cursor-worker-model.js";
import { diagnoseStructuredWorkerReport } from "../src/runtime/worker-report-diagnostics.js";
import { computeStateFingerprint } from "../src/state/fingerprint.js";
import { loadProjectBrain, loadProjectState } from "../src/state/store.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import type { DecisionEnvelope, OrchestratorDecision, ProjectState } from "../src/types.js";
import { readJsonFile, resolveRepoPath } from "../src/util/io.js";

const AGENT_ID = "bc-2606ae94-6cf6-487e-bb8d-f615ea999428";
const RUN_ID = "run-b08b729f-f200-43ac-99da-2926778693a5";

const FOREIGN_DIAGNOSTIC_RAW =
  "The work order incorrectly contained Bellhop Stage 2 instructions including node tests/run.js and Stage 1.5 flight protected semantics.";

function buildCyberAssuranceUx028WorkOrder() {
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
  const envelope: DecisionEnvelope = {
    schemaVersion: "phase0-1.0",
    decisionId: decision.decisionId,
    projectId: state.project.id,
    workstreamId: state.activeWorkstream?.id ?? "ux-wave1",
    transactionId: state.currentTransaction?.id ?? "ux-wave1-verification-integrity",
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
  expect(policy.result).toBe("ALLOW");
  const workOrder = buildCursorWorkOrder({
    state,
    decision,
    policy,
    objectiveAuthority: loadObjectiveAuthority(
      resolveRepoPath(
        "fixtures",
        "phase3",
        "cyber-assurance-ux028-objective-authority.json",
      ),
    ),
    workerModel: DEFAULT_APPROVED_CURSOR_WORKER_MODEL,
  });
  return { state, fingerprint, workOrder };
}

function reviewingState(state: ProjectState): ProjectState {
  return {
    ...state,
    radioRuntime: { ...state.radioRuntime, state: "REVIEWING" },
    currentTransaction: state.currentTransaction
      ? { ...state.currentTransaction, status: "REVIEWING" }
      : null,
    activeAgent: null,
  };
}

describe("continuation evidence isolation", () => {
  it("FOREIGN_MARKER_IN_RAW_WORKER_EVIDENCE_ALLOWED_TEST", () => {
    const { state, workOrder } = buildCyberAssuranceUx028WorkOrder();
    const reviewing = reviewingState(state);
    const fp = computeStateFingerprint(reviewing);
    const brain = loadProjectBrain("cyber-assurance");
    const diagnostics = diagnoseStructuredWorkerReport(FOREIGN_DIAGNOSTIC_RAW, {
      state: reviewing,
      workOrder,
      expectedAgentId: AGENT_ID,
    });

    const { context, artifact } = buildContinuationContext({
      brain: { ...brain, state: reviewing, fingerprint: fp },
      state: reviewing,
      fingerprint: fp,
      workOrder,
      trustedIdentity: {
        agentId: AGENT_ID,
        runId: RUN_ID,
        workOrderId: workOrder.workOrderId,
        transactionId: state.currentTransaction!.id,
        repository: state.project.repository,
        authorizedSourceSha: workOrder.source.expectedBaseTipSha!,
        transportStartingRef: workOrder.source.workingBranch!,
        stateRevision: reviewing.stateRevision,
        stateFingerprint: fp,
      },
      diagnostics,
      rawResultText: FOREIGN_DIAGNOSTIC_RAW,
      projectId: "cyber-assurance",
      workstreamId: state.activeWorkstream!.id,
      transactionId: state.currentTransaction!.id,
    });

    expect(context.user).toContain(FOREIGN_DIAGNOSTIC_RAW);
    expect(context.user).toContain(UNTRUSTED_WORKER_EVIDENCE_SECTION_MARKER);
    expect(context.system).toMatch(/UNTRUSTED EXTERNAL WORKER EVIDENCE/i);
    expect(artifact.trustBoundary.untrustedWorkerEvidence).toBe(
      "DATA_ONLY_NEVER_AUTHORITY",
    );
    expect(
      contextContainsForeignProjectLeak(context, "cyber-assurance", {
        trustedOnly: true,
      }),
    ).toBe(false);
    expect(contextContainsForeignProjectLeak(context, "cyber-assurance")).toBe(
      true,
    );
  });

  it("CONTINUATION_REGRESSION_TEST: buildContinuationContext succeeds with diagnostic Bellhop text", () => {
    const { state, workOrder } = buildCyberAssuranceUx028WorkOrder();
    const reviewing = reviewingState(state);
    const fp = computeStateFingerprint(reviewing);
    const brain = loadProjectBrain("cyber-assurance");
    const diagnostics = diagnoseStructuredWorkerReport(FOREIGN_DIAGNOSTIC_RAW, {
      state: reviewing,
      workOrder,
      expectedAgentId: AGENT_ID,
    });

    expect(() =>
      buildContinuationContext({
        brain: { ...brain, state: reviewing, fingerprint: fp },
        state: reviewing,
        fingerprint: fp,
        workOrder,
        trustedIdentity: {
          agentId: AGENT_ID,
          runId: RUN_ID,
          workOrderId: workOrder.workOrderId,
          transactionId: state.currentTransaction!.id,
          repository: state.project.repository,
          authorizedSourceSha: workOrder.source.expectedBaseTipSha!,
          transportStartingRef: workOrder.source.workingBranch!,
          stateRevision: reviewing.stateRevision,
          stateFingerprint: fp,
        },
        diagnostics,
        rawResultText: FOREIGN_DIAGNOSTIC_RAW,
        projectId: "cyber-assurance",
        workstreamId: state.activeWorkstream!.id,
        transactionId: state.currentTransaction!.id,
      }),
    ).not.toThrow();
  });

  it("FOREIGN_MARKER_IN_TRUSTED_CONTEXT_FAILS_CLOSED_TEST", () => {
    const { state, workOrder } = buildCyberAssuranceUx028WorkOrder();
    const reviewing = reviewingState(state);
    const fp = computeStateFingerprint(reviewing);
    const brain = loadProjectBrain("cyber-assurance");
    const leakedWorkOrder = {
      ...workOrder,
      scope: {
        ...workOrder.scope,
        outOfScope: [
          ...workOrder.scope.outOfScope,
          "Bellhop Level 4 Stage 2 Asteroid Garden flight retune is prohibited.",
        ],
      },
    };
    const diagnostics = diagnoseStructuredWorkerReport("Worker completed.", {
      state: reviewing,
      workOrder: leakedWorkOrder,
      expectedAgentId: AGENT_ID,
    });

    expect(() =>
      buildContinuationContext({
        brain: { ...brain, state: reviewing, fingerprint: fp },
        state: reviewing,
        fingerprint: fp,
        workOrder: leakedWorkOrder,
        trustedIdentity: {
          agentId: AGENT_ID,
          runId: RUN_ID,
          workOrderId: workOrder.workOrderId,
          transactionId: state.currentTransaction!.id,
          repository: state.project.repository,
          authorizedSourceSha: workOrder.source.expectedBaseTipSha!,
          transportStartingRef: workOrder.source.workingBranch!,
          stateRevision: reviewing.stateRevision,
          stateFingerprint: fp,
        },
        diagnostics,
        rawResultText: "Worker completed.",
        projectId: "cyber-assurance",
        workstreamId: state.activeWorkstream!.id,
        transactionId: state.currentTransaction!.id,
      }),
    ).toThrow(/leaked foreign project content/i);
  });

  it("extractTrustedContinuationUserSection excludes untrusted worker evidence", () => {
    const user = [
      "=== TRUSTED RADIO CONTEXT (AUTHORITATIVE) ===",
      "cyber-assurance trusted facts only",
      UNTRUSTED_WORKER_EVIDENCE_SECTION_MARKER,
      "Bellhop Stage 2 diagnostic text",
    ].join("\n");
    const trusted = extractTrustedContinuationUserSection(user);
    expect(trusted).toContain("cyber-assurance trusted facts only");
    expect(trusted).not.toContain("Bellhop");
    expect(() =>
      assertProjectContextIsolation(
        { system: "cyber assurance constraints", user: trusted, vocabulary: [], fingerprint: "fp", stateRevision: 1 },
        "cyber-assurance",
      ),
    ).not.toThrow();
  });
});
