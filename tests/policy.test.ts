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

/** Phase 0/1 policy tests seed from immutable PLANNING snapshot. */
function loadPlanningState() {
  return loadProjectState({
    projectId: "bellhop",
    statePath: resolveRepoPath("fixtures", "state", "bellhop-planning-seed.json"),
  });
}

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
    const { state, fingerprint } = loadPlanningState();
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
    const { state } = loadPlanningState();
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
    const { state, fingerprint } = loadPlanningState();
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      objective: "Merge PR #39 into level3 after verification",
      requestedWork: "Please merge PR #39 now.",
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
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
    const { state, fingerprint } = loadPlanningState();
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      objective: "Production deploy Stage 2 to live",
      requestedWork: "Perform production deploy of Stage 2.",
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
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
    const { state, fingerprint } = loadPlanningState();
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      objective: "Begin Stage 3 and implement Star Beam",
      requestedWork: "Start Stage 3 now and implement Star Beam.",
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
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

  it("does not treat bullet-prefixed Stage 3 prohibitions as deferred activation", () => {
    const { state, fingerprint } = loadPlanningState();
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      objective:
        "Independently verify Stage 2 is ready for the required human playtest.",
      requestedWork: [
        "AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED",
        "- Do not implement Stage 3, Star Beam, or deferred landmarks.",
        "- Do not retune flight or change controls.",
        "- Do not merge, deploy, or create a PR.",
        "Run node tests/run.js and return one fenced text report.",
      ].join("\n"),
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
    };
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("ALLOW");
    expect(policy.primaryCode).toBe("OK");
  });

  it("allows live Stage 2 verification semantics when Stage 3 appears only as prohibition", () => {
    // Regression for live Sol LAUNCH_CURSOR / VERIFICATION / PLANNING→IMPLEMENTING
    // that was false-positived by P5_DEFERRED_SCOPE on out-of-scope Stage 3 text.
    const { state, fingerprint } = loadPlanningState();
    const decision = legalLaunch();
    expect(decision.decision).toBe("LAUNCH_CURSOR");
    expect(decision.cursorInstruction!.agentAction).toBe(
      "FRESH_ORDINARY_AGENT_REQUIRED",
    );
    expect(decision.cursorInstruction!.workType).toBe("VERIFICATION");
    expect(decision.stateTransition).toEqual(
      expect.objectContaining({ from: "PLANNING", to: "IMPLEMENTING" }),
    );
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      objective:
        "Verify existing Stage 2 Asteroid Garden is technically ready for human playtest.",
      requestedWork: [
        "AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED",
        "",
        "Verify Stage 2 only; do not start Stage 3.",
        "Out of scope:",
        "- Starting Stage 3.",
        "- Implementing Stage 3.",
        "- Merging or deploying.",
        "Hard prohibitions:",
        "- Do not implement Stage 3.",
        "- Stage 3 remains deferred pending human approval.",
        "Run node tests/run.js and return one fenced text report.",
      ].join("\n"),
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
    };
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("ALLOW");
    expect(policy.primaryCode).toBe("OK");
    expect(
      policy.triggeredRules.find((r) => r.ruleId === "P5_DEFERRED_SCOPE")
        ?.outcome,
    ).toBe("PASS");
  });

  describe("P5 deferred-scope negation vs affirmative matrix", () => {
    function policyForPrompt(objective: string, requestedWork: string) {
      const { state, fingerprint } = loadPlanningState();
      const decision = legalLaunch();
      decision.cursorInstruction = {
        ...decision.cursorInstruction!,
        objective,
        requestedWork,
        verificationCriteria:
          "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
      };
      return evaluatePolicy({
        decision,
        state,
        envelope: baseEnvelope(state, fingerprint, decision.decisionId),
        currentFingerprint: fingerprint,
      });
    }

    const noActivation = [
      ["A", "Do not start Stage 3."],
      ["B", "Do not implement Stage 3."],
      ["C", "Verify Stage 2 only; do not start Stage 3."],
      ["D", "Do not merge, deploy, start Stage 3, or retune flight."],
      ["E", "Stage 3 is out of scope."],
      ["F", "Stage 3 remains deferred pending human approval."],
    ] as const;

    for (const [label, phrase] of noActivation) {
      it(`${label}: prohibition/boundary "${phrase}" does not trigger DEFERRED_SCOPE`, () => {
        const policy = policyForPrompt(
          "Verify existing Stage 2 only.",
          `AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED\n${phrase}\nRun verification.`,
        );
        expect(policy.result).toBe("ALLOW");
        expect(policy.primaryCode).toBe("OK");
      });
    }

    it("bullet-prefixed Stage 3 prohibition remains non-activating", () => {
      const policy = policyForPrompt(
        "Verify existing Stage 2 only.",
        "AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED\n* Do not start Stage 3.\nRun verification.",
      );
      expect(policy.result).toBe("ALLOW");
      expect(policy.primaryCode).toBe("OK");
    });

    const mustGate = [
      ["G", "Start Stage 3."],
      ["H", "Implement Stage 3."],
      ["I", "Proceed to Stage 3."],
      ["J", "Begin Stage 3 after this verification."],
    ] as const;

    for (const [label, phrase] of mustGate) {
      it(`${label}: affirmative "${phrase}" requires START_DEFERRED_WORK`, () => {
        const policy = policyForPrompt(
          phrase,
          `AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED\n${phrase}`,
        );
        expect(policy.result).toBe("REQUIRE_HUMAN");
        expect(policy.primaryCode).toBe("DEFERRED_SCOPE");
        expect(policy.requiredApprovalType).toBe("START_DEFERRED_WORK");
      });
    }
  });

  it("rejects remediation because Pilot 01 remediation budget is 0", () => {
    const { state, fingerprint } = loadPlanningState();
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      workType: "REMEDIATION",
      maxRemediationPasses: 1,
      objective: "Remediate failing Stage 2 tests",
      requestedWork: "Fix the failing tests with one remediation pass.",
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
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

  it("allows REMEDIATION when transaction remediationBudget remains", () => {
    const { state, fingerprint } = loadPlanningState();
    const withBudget = structuredClone(state);
    withBudget.currentTransaction!.remediationBudget = 1;
    withBudget.currentTransaction!.remediationsUsed = 0;
    withBudget.currentTransaction!.remediationBudgetExhausted = false;
    const fp = computeStateFingerprint(withBudget);
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      workType: "REMEDIATION",
      maxRemediationPasses: 1,
      objective: "Narrow remediation with authorized budget",
      requestedWork: "Apply one authorized remediation pass.",
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
    };
    const policy = evaluatePolicy({
      decision,
      state: withBudget,
      envelope: baseEnvelope(withBudget, fp, decision.decisionId),
      currentFingerprint: fp,
    });
    expect(policy.result).toBe("ALLOW");
    expect(policy.primaryCode).toBe("OK");
  });

  it("rejects specialist / API Parent workflow because specialist budget is 0", () => {
    const { state, fingerprint } = loadPlanningState();
    const decision = legalLaunch();
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      agentAction: "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
      workType: "IMPLEMENTATION",
      objective: "Implement with Sol/Opus specialists via API Parent",
      requestedWork: "Create API Parent and specialists.",
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
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
    const { state, fingerprint } = loadPlanningState();
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
    const { state, fingerprint } = loadPlanningState();
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

  it("rejects PLANNING → WAITING_FOR_AGENT as ILLEGAL_STATE_TRANSITION", () => {
    const { state, fingerprint } = loadPlanningState();
    const decision = legalLaunch();
    decision.stateTransition = {
      from: "PLANNING",
      to: "WAITING_FOR_AGENT",
      reason:
        "Incorrectly skipping IMPLEMENTING; dispatch has not started yet.",
    };
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("REJECT");
    expect(policy.primaryCode).toBe("ILLEGAL_STATE_TRANSITION");
  });

  it("allows PLANNING → IMPLEMENTING for legal Bellhop LAUNCH_CURSOR fixture", () => {
    const { state, fingerprint } = loadPlanningState();
    const decision = legalLaunch();
    expect(decision.stateTransition).toEqual(
      expect.objectContaining({
        from: "PLANNING",
        to: "IMPLEMENTING",
      }),
    );
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: baseEnvelope(state, fingerprint, decision.decisionId),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("ALLOW");
    expect(policy.primaryCode).toBe("OK");
  });
});
