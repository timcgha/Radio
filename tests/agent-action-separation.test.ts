import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCreateAgentRequest,
  generatePlannedAgentId,
} from "../src/cursor/adapter.js";
import {
  resolveImplementationWorkerAgentAction,
  resolveTransactionSupervisoryAgentAction,
} from "../src/cursor/implementation-agent-action.js";
import { renderCursorPrompt } from "../src/cursor/prompt-renderer.js";
import {
  buildCursorWorkOrder,
  validateWorkOrder,
} from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import { DEFAULT_APPROVED_CURSOR_WORKER_MODEL } from "../src/runtime/cursor-worker-model.js";
import { ensureLedgerFile, transmitCursorWorkOrder } from "../src/runtime/transmitter.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  DecisionEnvelope,
  ObjectiveAuthority,
  OrchestratorDecision,
  ProjectState,
} from "../src/types.js";
import { readJsonFile, resolveRepoPath } from "../src/util/io.js";

function baseEnvelope(
  state: ProjectState,
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

function evaluateUx028Launch(input: {
  statePath?: string;
  decisionPath?: string;
  objectiveAuthority?: ObjectiveAuthority | null;
  workerModel?: string;
}) {
  const statePath =
    input.statePath ??
    resolveRepoPath(
      "fixtures",
      "state",
      "cyber-assurance-ux028-dispatch-seed.json",
    );
  const decisionPath =
    input.decisionPath ??
    resolveRepoPath(
      "fixtures",
      "decisions",
      "cyber-assurance-ux028-implementation-launch.json",
    );
  const { state, fingerprint } = loadProjectState({
    projectId: "cyber-assurance",
    statePath,
  });
  const decision = structuredClone(
    readJsonFile(decisionPath),
  ) as OrchestratorDecision;
  const policy = evaluatePolicy({
    decision,
    state,
    envelope: baseEnvelope(state, fingerprint, decision.decisionId),
    currentFingerprint: fingerprint,
  });
  expect(policy.result).toBe("ALLOW");
  const workOrder = buildCursorWorkOrder({
    state,
    decision,
    policy,
    objectiveAuthority: input.objectiveAuthority ?? null,
    workerModel: input.workerModel ?? DEFAULT_APPROVED_CURSOR_WORKER_MODEL,
  });
  return { state, decision, policy, workOrder, fingerprint };
}

describe("agent action separation — transaction supervisory vs implementation worker", () => {
  it("resolves UX-028 supervisory Parent/Auto separately from ordinary implementation worker", () => {
    const { state, decision, workOrder } = evaluateUx028Launch({});

    const supervisory = resolveTransactionSupervisoryAgentAction(
      state,
      decision.cursorInstruction!,
    );
    expect(supervisory).toBe("FRESH_API_CREATED_PARENT_AUTO_REQUIRED");

    const implementation = resolveImplementationWorkerAgentAction(
      decision.cursorInstruction!.agentAction,
      supervisory,
    );
    expect(implementation).toBe("FRESH_ORDINARY_AGENT_REQUIRED");

    expect(decision.cursorInstruction!.agentAction).toBe(
      "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
    );
    expect(workOrder.agentAction).toBe("FRESH_ORDINARY_AGENT_REQUIRED");
    expect(workOrder.agentPlan.transactionSupervisoryAgentAction).toBe(
      "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
    );
    expect(workOrder.agentPlan.workerModel).toBe("composer-2.5");
    expect(workOrder.budgets.maxSpecialistReviewCycles).toBe(2);
    expect(() => validateWorkOrder(workOrder)).not.toThrow();
  });

  it("buildCreateAgentRequest accepts ordinary implementation worker for UX-028", () => {
    const { workOrder } = evaluateUx028Launch({});
    const prompt = renderCursorPrompt(workOrder);
    const request = buildCreateAgentRequest({
      workOrder,
      prompt,
      plannedAgentId: generatePlannedAgentId(),
      modelId: workOrder.agentPlan.workerModel!,
    });
    expect(request.model?.id).toBe("composer-2.5");
    expect(workOrder.agentAction).toBe("FRESH_ORDINARY_AGENT_REQUIRED");
    expect(prompt).toMatch(/AGENT REQUIREMENT:\s*FRESH ORDINARY AGENT REQUIRED/);
    expect(prompt).not.toMatch(
      /AGENT REQUIREMENT:\s*FRESH API CREATED PARENT AUTO REQUIRED/,
    );
  });

  it("regression: Phase 1 transmitter does not receive Parent/Auto for ordinary Composer worker", async () => {
    const { workOrder, state, fingerprint } = evaluateUx028Launch({});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radio-ux028-dispatch-"));
    const statePath = path.join(dir, "PROJECT-STATE.json");
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    const runDir = path.join(dir, "run");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    ensureLedgerFile(ledgerPath);

    const passRaw = fs.readFileSync(
      resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
      "utf8",
    );
    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw }]);
    const prompt = renderCursorPrompt(workOrder);

    expect(workOrder.agentAction).not.toBe(
      "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
    );

    const transmit = await transmitCursorWorkOrder({
      runId: "ux028-dispatch-regression",
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt,
      client,
      forceFixtureTransmit: true,
      externalCursorAllowed: false,
      pollIntervalMs: 1,
      pollMaxAttempts: 3,
    });

    expect(transmit.cursorApiCalled).toBe(true);
    expect(transmit.terminalVerdict).toBe("RADIO_PHASE1_RAW_RESULT_READY");
    expect(workOrder.agentAction).toBe("FRESH_ORDINARY_AGENT_REQUIRED");
    expect(transmit.summaryNotes.join(" ")).not.toMatch(
      /only supports FRESH_ORDINARY_AGENT_REQUIRED \(got FRESH_API_CREATED_PARENT_AUTO_REQUIRED\)/,
    );
    expect(fingerprint).toBeTruthy();
  });

  it("preserves specialist Parent requirement for post-implementation Sol + Opus gate", () => {
    const { state, decision, workOrder } = evaluateUx028Launch({});
    const nextTxn = state.nextTransaction as {
      requiredAgentAction?: string;
    };

    expect(nextTxn.requiredAgentAction).toBe(
      "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
    );
    expect(decision.cursorInstruction!.agentAction).toBe(
      "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
    );
    expect(workOrder.agentPlan.transactionSupervisoryAgentAction).toBe(
      "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
    );
    expect(workOrder.budgets.maxSpecialistReviewCycles).toBeGreaterThan(0);
    expect(
      (state.verificationPolicy as { finalDualReviewRequiredForComplexWork?: boolean })
        .finalDualReviewRequiredForComplexWork,
    ).toBe(true);
    expect(state.budgets.maxSpecialistCallsPerTransaction).toBeGreaterThan(0);
    expect(state.agentPolicy).toMatchObject({
      specialists: {
        sol: "gpt-5.6-sol-high",
        opus: "claude-opus-5-thinking-high",
      },
    });
  });

  it("leaves Bellhop ordinary implementation dispatch unchanged", () => {
    const { state, fingerprint } = loadProjectState({
      projectId: "bellhop",
      statePath: resolveRepoPath(
        "fixtures",
        "state",
        "bellhop-planning-seed.json",
      ),
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
    expect(workOrder.agentAction).toBe("FRESH_ORDINARY_AGENT_REQUIRED");
    expect(workOrder.agentPlan.transactionSupervisoryAgentAction).toBeNull();
    expect(workOrder.agentPlan.workerModel).toBe("composer-2.5");
    expect(workOrder.budgets.maxSpecialistReviewCycles).toBe(0);

    const request = buildCreateAgentRequest({
      workOrder,
      prompt: renderCursorPrompt(workOrder),
      plannedAgentId: generatePlannedAgentId(),
      modelId: workOrder.agentPlan.workerModel!,
    });
    expect(request.model?.id).toBe("composer-2.5");
  });
});
