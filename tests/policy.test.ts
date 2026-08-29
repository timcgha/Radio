import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/policy/engine.js";
import { computeStateFingerprint } from "../src/state/fingerprint.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  DecisionEnvelope,
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
}

function legalLaunch(): OrchestratorDecision {
  return structuredClone(
    readJsonFile(
      resolveRepoPath(
        "fixtures",
        "decisions",
        "bellhop-legal-launch-cursor.json",
      ),
    ),
  ) as OrchestratorDecision;
}

describe("policy", () => {
  it("allows legal fresh ordinary verification launch", () => {
    const { state, fingerprint } = loadProjectState({ projectId: "bellhop" });
    const decision = legalLaunch();
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("ALLOW");
    expect(policy.primaryCode).toBe("OK");
    expect(policy.executionPermitted).toBe(true);
  });

  it("rejects activeAgent plus equivalent new launch", () => {
    const { state } = loadProjectState({ projectId: "bellhop" });
    const withAgent = structuredClone(state);
    withAgent.activeAgent = { agentId: "existing-agent", status: "RUNNING" };
    const currentFp = computeStateFingerprint(withAgent);
    const decision = legalLaunch();
    const policy = evaluatePolicy({
      decision,
      state: withAgent,
      envelope: baseEnvelope(withAgent, currentFp, decision.decisionId),
      currentFingerprint: currentFp,
    });
    expect(policy.result).toBe("REJECT");
    expect(policy.primaryCode).toBe("ACTIVE_AGENT_CONFLICT");
  });

  it("does not autonomously allow merge without human authority", () => {
    const { state, fingerprint } = loadProjectState({ projectId: "bellhop" });
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      objective: "Merge PR #39 into level3 after verification",
      prompt: "Please merge PR #39 now.",
      workType: "CLOSEOUT",
    };
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("REQUIRE_HUMAN");
    expect(policy.requiredApprovalType).toBe("MERGE_PR");
  });

  it("does not autonomously allow deployment", () => {
    const { state, fingerprint } = loadProjectState({ projectId: "bellhop" });
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      objective: "Production deploy Stage 2 to live",
      prompt: "Perform production deploy of Stage 2.",
      workType: "CLOSEOUT",
    };
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("REQUIRE_HUMAN");
    expect(policy.requiredApprovalType).toBe("PRODUCTION_DEPLOY");
  });

  it("rejects Stage 3 / deferred work without human approval", () => {
    const { state, fingerprint } = loadProjectState({ projectId: "bellhop" });
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      objective: "Begin Stage 3 and implement Star Beam",
      prompt: "Start Stage 3 now and implement Star Beam.",
      workType: "IMPLEMENTATION",
    };
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(["REQUIRE_HUMAN", "REJECT"]).toContain(policy.result);
    expect([
      "DEFERRED_SCOPE",
      "FROZEN_SCOPE",
      "HUMAN_APPROVAL_REQUIRED",
    ]).toContain(policy.primaryCode);
  });

  it("rejects remediation because Pilot 01 remediation budget is 0", () => {
    const { state, fingerprint } = loadProjectState({ projectId: "bellhop" });
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      workType: "REMEDIATION",
      maxRemediationPasses: 1,
      objective: "Remediate failing Stage 2 tests",
      prompt: "Fix the failing tests with one remediation pass.",
    };
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("REJECT");
    expect(policy.primaryCode).toBe("REMEDIATION_BUDGET_EXHAUSTED");
  });

  it("rejects specialist / API Parent workflow because specialist budget is 0", () => {
    const { state, fingerprint } = loadProjectState({ projectId: "bellhop" });
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      agentAction: "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
      workType: "IMPLEMENTATION",
      objective: "Implement with Sol/Opus specialists via API Parent",
      prompt: "Create API Parent and specialists.",
    };
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("REJECT");
    expect(policy.primaryCode).toBe("AGENT_BUDGET_EXHAUSTED");
  });

  it("rejects stale fingerprint", () => {
    const { state, fingerprint } = loadProjectState({ projectId: "bellhop" });
    const decision = legalLaunch();
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, "0".repeat(64), decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("REJECT");
    expect(policy.primaryCode).toBe("STALE_DECISION");
  });

  it("does not reject legal LAUNCH_CURSOR merely because Cursor execution is disabled", () => {
    const { state, fingerprint } = loadProjectState({ projectId: "bellhop" });
    const decision = legalLaunch();
    const envelope = baseEnvelope(state, fingerprint, decision.decisionId);
    envelope.cursorExecutionEnabled = false;
    const policy = evaluatePolicy({
      decision,
      state,
      envelope,
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("ALLOW");
  });
});
