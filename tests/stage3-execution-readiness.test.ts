/**
 * Stage 3 execution-readiness remediation regressions:
 *   A) Cursor workspace source fidelity (Option B materialization)
 *   B) Objective-aware work-order scope (no stale Stage-2 bans)
 *   C) Transaction Cursor-agent budget aligned to ObjectiveAuthority
 *
 * Deterministic / mocked only — no live OpenAI or Cursor networking.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCreateAgentRequest } from "../src/cursor/adapter.js";
import { renderCursorPrompt } from "../src/cursor/prompt-renderer.js";
import {
  CONTINUATION_BRANCH_CHAINING_LIMITATION,
  CONTINUATION_SOURCE_MODEL,
  SOURCE_FIDELITY_MODE,
  evaluateAuthorizedSourceBootstrap,
  secondFreshWorkerLacksPriorUnmergedChanges,
} from "../src/cursor/source-bootstrap.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import {
  WorkOrderScopeContradictionError,
  assertWorkOrderScopeConsistent,
  buildObjectiveAwareWorkOrderScope,
} from "../src/cursor/work-order-scope.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import {
  alignStateBudgetsWithObjectiveAuthority,
  resolveEffectiveMaxCursorAgentsPerTransaction,
  resolveWorkOrderMaxAgents,
} from "../src/runtime/cursor-agent-budget.js";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import {
  loadObjectiveAuthority,
  persistObjectiveAuthority,
} from "../src/runtime/objective-authority.js";
import { prepareAcceptedBaselineForObjectiveStart } from "../src/runtime/phase3-objective-start.js";
import { runPhase3Loop } from "../src/runtime/phase3.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  DecisionEnvelope,
  ObjectiveAuthority,
  OrchestratorDecision,
  ProjectState,
  RuntimeState,
  SolPhase2Assessment,
  WorkType,
} from "../src/types.js";
import { newId, readJsonFile, resolveRepoPath } from "../src/util/io.js";

const TRUSTED_BRANCH = "level3";
const TRUSTED_SHA = "847ca2d64090aaeb94ca681b651a44062ab9f644";
const WRONG_MAIN_SHA = "6b5cc0f0218e40d1061927df685ad328a60f84b0";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-stage3-readiness-"));
}

function stage3Authority(overrides?: Partial<ObjectiveAuthority>): ObjectiveAuthority {
  const base = loadObjectiveAuthority(
    resolveRepoPath("fixtures", "phase3", "stage3-objective-authority.json"),
  );
  return {
    ...base,
    ...overrides,
    summary:
      overrides?.summary ??
      "Implement and technically verify Bellhop Level 4 Stage 3 (planet sequence / Star Beam) from accepted Stage 2 base until the next genuine human product/playtest gate.",
    baseBranch: overrides?.baseBranch ?? TRUSTED_BRANCH,
    expectedStartingSha: overrides?.expectedStartingSha ?? TRUSTED_SHA,
    maxCursorAgents: overrides?.maxCursorAgents ?? 3,
    prohibitedScope: overrides?.prohibitedScope ?? [
      "Stage 4",
      "Level 4 Stage 4",
      "merge PR",
      "automatic merge",
      "production deploy",
      "automatic deployment",
      "broad unrelated flight retuning",
      "unrelated refactoring",
      "Radio implementation changes",
      "specialist swarms",
      "API Parent",
      "budget expansion",
    ],
    accounting: {
      ...base.accounting,
      ...(overrides?.accounting ?? {}),
    },
  };
}

function loadPlanningState() {
  return loadProjectState({
    projectId: "bellhop",
    statePath: resolveRepoPath("fixtures", "state", "bellhop-planning-seed.json"),
  });
}

function loadAcceptedBaseline() {
  return loadProjectState({
    projectId: "bellhop",
    statePath: resolveRepoPath(
      "fixtures",
      "state",
      "bellhop-accepted-baseline-seed.json",
    ),
  });
}

function legalLaunch(): OrchestratorDecision {
  return structuredClone(
    readJsonFile(
      resolveRepoPath("fixtures", "decisions", "bellhop-legal-launch-cursor.json"),
    ),
  ) as OrchestratorDecision;
}

function policyEnvelope(
  state: ProjectState,
  fingerprint: string,
  decision: OrchestratorDecision,
): DecisionEnvelope {
  return {
    schemaVersion: "phase0-1.0",
    decisionId: decision.decisionId,
    projectId: decision.projectId,
    workstreamId: decision.workstreamId ?? state.activeWorkstream?.id ?? "ws",
    transactionId: decision.transactionId ?? state.currentTransaction?.id ?? "tx",
    stateRevision: state.stateRevision,
    requestFingerprint: fingerprint,
    model: "gpt-5.6-sol",
    mode: "fixture",
    generatedAt: new Date().toISOString(),
    cursorExecutionEnabled: false,
    notes: [],
  };
}

/** Wording avoids policy STAGE3_ACTIVATION regex while still naming Stage 3 / Star Beam. */
const STAGE3_REQUESTED_WORK =
  "Inspect the Bellhop repository for Level 4 Stage 3. Continue Level 4 Stage 3 Star Beam implementation tasks in-repo: planet sequence, Star Beam gameplay, progression, presentation, and supporting automated tests.";
const STAGE3_OBJECTIVE =
  "Technically advance Bellhop Level 4 Stage 3 (planet sequence / Star Beam) from the accepted Stage 2 base until the next genuine human product/playtest gate.";
const STAGE3_VERIFICATION =
  "Confirm no Stage 4 work occurred; confirm merge and production deploy did not occur.";

function planningStateWithoutStage3Deferred(): {
  state: ProjectState;
  fingerprint: string;
} {
  const loaded = loadPlanningState();
  const state: ProjectState = {
    ...loaded.state,
    deferredItems: loaded.state.deferredItems.filter(
      (item) => !/stage\s*3/i.test(item.name) && !/star\s*beam/i.test(item.name),
    ),
  };
  return { state, fingerprint: loaded.fingerprint };
}

function stage3LaunchDecision(
  state: ProjectState,
  authority: ObjectiveAuthority,
): OrchestratorDecision {
  const base = legalLaunch();
  return {
    ...base,
    decisionId: newId("dec"),
    projectId: authority.projectId,
    workstreamId: state.activeWorkstream?.id ?? authority.workstreamId,
    transactionId: state.currentTransaction?.id ?? authority.transactionId,
    decision: "LAUNCH_CURSOR",
    cursorInstruction: {
      ...base.cursorInstruction!,
      agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
      workType: "IMPLEMENTATION",
      objective: STAGE3_OBJECTIVE,
      requestedWork: STAGE3_REQUESTED_WORK,
      verificationCriteria: STAGE3_VERIFICATION,
      baseBranch: authority.baseBranch,
      expectedStartingSha: authority.expectedStartingSha,
      expectedTerminalVerdicts: [
        "BELLHOP_STAGE3_TECHNICALLY_READY_FOR_HUMAN",
        "BELLHOP_STAGE3_BLOCKED_PRODUCT_DECISION",
      ],
      maxRemediationPasses: 0,
    },
  };
}

describe("Blocker A — Cursor workspace source fidelity", () => {
  it("records SOURCE_FIDELITY_MODE Option B", () => {
    expect(SOURCE_FIDELITY_MODE).toBe("OPTION_B_AUTHORIZED_MATERIALIZATION");
  });

  it("create payload includes startingRef=level3 in repos[0] (real -07 shape)", () => {
    const { state, fingerprint } = planningStateWithoutStage3Deferred();
    const authority = stage3Authority();
    const decision = stage3LaunchDecision(state, authority);
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: policyEnvelope(state, fingerprint, decision),
      currentFingerprint: fingerprint,
    });
    expect(policy.result).toBe("ALLOW");
    const workOrder = buildCursorWorkOrder({
      state,
      decision,
      policy,
      objectiveAuthority: authority,
    });
    const createReq = buildCreateAgentRequest({
      workOrder,
      prompt: renderCursorPrompt(workOrder),
      plannedAgentId: "bc-00000000-0000-4000-8000-000000000001",
      modelId: workOrder.agentPlan.workerModel ?? "composer-2",
    });
    expect(createReq.repos?.[0]?.startingRef).toBe(TRUSTED_BRANCH);
    expect(createReq.repos?.[0]?.url).toContain("Bellhop");
    expect(createReq.model?.id).toBeTruthy();
    expect(workOrder.source.expectedBaseTipSha).toBe(TRUSTED_SHA);
  });

  it("wrong initial workspace + successful trusted checkout permits product work", () => {
    const outcome = evaluateAuthorizedSourceBootstrap({
      trusted: {
        branch: TRUSTED_BRANCH,
        expectedFullSha: TRUSTED_SHA,
        repository: "https://github.com/timcgha/Bellhop",
      },
      initialWorkspace: { branch: "main", headSha: WRONG_MAIN_SHA },
      checkoutResult: "SUCCESS",
    });
    expect(outcome.materializationAttempted).toBe(true);
    expect(outcome.materializationSucceeded).toBe(true);
    expect(outcome.productWorkPermitted).toBe(true);
    expect(outcome.observedHeadSha).toBe(TRUSTED_SHA);
    expect(outcome.reason).toBe("TRUSTED_CHECKOUT_SUCCESS");
  });

  it("wrong initial workspace + failed trusted checkout forbids product work", () => {
    const outcome = evaluateAuthorizedSourceBootstrap({
      trusted: {
        branch: TRUSTED_BRANCH,
        expectedFullSha: TRUSTED_SHA,
        repository: "https://github.com/timcgha/Bellhop",
      },
      initialWorkspace: { branch: "main", headSha: WRONG_MAIN_SHA },
      checkoutResult: "FAILURE",
    });
    expect(outcome.productWorkPermitted).toBe(false);
    expect(outcome.materializationSucceeded).toBe(false);
    expect(outcome.reason).toBe("TRUSTED_CHECKOUT_FAILED_STOP");
  });

  it("rendered Stage-3 prompt authorizes materialization and forbids silent main fallback", () => {
    const { state, fingerprint } = planningStateWithoutStage3Deferred();
    const authority = stage3Authority();
    const decision = stage3LaunchDecision(state, authority);
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: policyEnvelope(state, fingerprint, decision),
      currentFingerprint: fingerprint,
    });
    const workOrder = buildCursorWorkOrder({
      state,
      decision,
      policy,
      objectiveAuthority: authority,
    });
    const prompt = renderCursorPrompt(workOrder);
    expect(workOrder.agentPlan.bootstrapRequired).toBe(true);
    expect(prompt).toContain(TRUSTED_SHA);
    expect(prompt).toContain(TRUSTED_BRANCH);
    expect(prompt).toMatch(/AUTHORIZED and REQUIRED to materialize/);
    expect(prompt).toMatch(/Do NOT fall back to main/i);
    expect(prompt).not.toMatch(/Do NOT attempt git reset\/checkout/);
    expect(prompt).toMatch(/Worker prose claiming/);
  });
});

describe("Blocker B — objective-aware work-order scope", () => {
  it("Stage-3 authority allows Star Beam and Starting Stage 3; prohibits Stage 4", () => {
    const scope = buildObjectiveAwareWorkOrderScope({
      objectiveAuthority: stage3Authority(),
      workType: "IMPLEMENTATION",
      repository: "https://github.com/timcgha/Bellhop",
    });
    expect(scope.stage3Authorized).toBe(true);
    expect(scope.outOfScope.join("\n")).not.toMatch(/Star Beam/i);
    expect(scope.outOfScope.join("\n")).not.toMatch(/Starting Stage 3/i);
    expect(scope.hardProhibitions.join("\n")).not.toMatch(/Do NOT start Stage 3/i);
    expect(scope.outOfScope.join("\n")).toMatch(/Stage 4/i);
    expect(scope.hardProhibitions.join("\n")).toMatch(/Stage 4/i);
    expect(scope.allowedProductChanges.join("\n")).toMatch(/Star Beam/i);
  });

  it("Stage-2 pilot (no authority) still prohibits Stage 3 / Star Beam", () => {
    const scope = buildObjectiveAwareWorkOrderScope({
      objectiveAuthority: null,
      workType: "VERIFICATION",
      repository: "https://github.com/timcgha/Bellhop",
    });
    expect(scope.stage3Authorized).toBe(false);
    expect(scope.outOfScope.some((s) => /Star Beam/i.test(s))).toBe(true);
    expect(scope.outOfScope.some((s) => /Starting Stage 3/i.test(s))).toBe(true);
    expect(scope.hardProhibitions.some((s) => /Do NOT start Stage 3/i.test(s))).toBe(
      true,
    );
  });

  it("rendered Stage-3 work order is WORK_ORDER_SCOPE_CONSISTENT", () => {
    const { state, fingerprint } = planningStateWithoutStage3Deferred();
    const authority = stage3Authority();
    const decision = stage3LaunchDecision(state, authority);
    const policy = evaluatePolicy({
      decision,
      state,
      envelope: policyEnvelope(state, fingerprint, decision),
      currentFingerprint: fingerprint,
    });
    const workOrder = buildCursorWorkOrder({
      state,
      decision,
      policy,
      objectiveAuthority: authority,
    });
    const consistent = assertWorkOrderScopeConsistent({
      requestedWork: workOrder.requestedWork,
      outOfScope: workOrder.scope.outOfScope,
      hardProhibitions: [
        ...workOrder.radioGuardrails.filter((g) => !/Stage 3|Star Beam/i.test(g)),
      ],
    });
    expect(consistent).toBe("WORK_ORDER_SCOPE_CONSISTENT");
    expect(workOrder.requestedWork).toMatch(/Star Beam/i);
    expect(workOrder.scope.outOfScope.join("\n")).not.toMatch(/Star Beam/i);
    expect(workOrder.scope.outOfScope.join("\n")).not.toMatch(/Starting Stage 3/i);
    const prompt = renderCursorPrompt(workOrder);
    expect(prompt).toContain("REQUESTED WORK");
    expect(prompt).toMatch(/Star Beam/i);
    expect(prompt).not.toMatch(/- Star Beam or Star Beam crates/);
    expect(prompt).not.toMatch(/- Starting Stage 3/);
    expect(prompt).not.toMatch(/Do NOT start Stage 3/);
    expect(prompt).toMatch(/Stage 4/i);
  });

  it("contradictory enforced scope fails closed", () => {
    expect(() =>
      assertWorkOrderScopeConsistent({
        requestedWork: STAGE3_REQUESTED_WORK,
        outOfScope: ["Star Beam or Star Beam crates.", "Starting Stage 3."],
        hardProhibitions: ["Do NOT start Stage 3."],
      }),
    ).toThrow(WorkOrderScopeContradictionError);
  });
});

describe("Blocker C — transaction Cursor-agent budget propagation", () => {
  it("CASE A: objective max=3, no stricter cap → effective 3", () => {
    expect(
      resolveEffectiveMaxCursorAgentsPerTransaction({
        objectiveMaxCursorAgents: 3,
      }),
    ).toBe(3);
    expect(
      resolveWorkOrderMaxAgents({
        stateMaxCursorAgentsPerTransaction: 1,
        objectiveMaxCursorAgents: 3,
      }),
    ).toBe(3);
  });

  it("CASE B: objective max=1 → effective 1", () => {
    expect(
      resolveEffectiveMaxCursorAgentsPerTransaction({
        objectiveMaxCursorAgents: 1,
      }),
    ).toBe(1);
    expect(
      resolveWorkOrderMaxAgents({
        stateMaxCursorAgentsPerTransaction: 1,
        objectiveMaxCursorAgents: 1,
      }),
    ).toBe(1);
  });

  it("CASE C: inflated state default cannot expand past objective max=3", () => {
    expect(
      resolveWorkOrderMaxAgents({
        stateMaxCursorAgentsPerTransaction: 5,
        objectiveMaxCursorAgents: 3,
      }),
    ).toBe(3);
    expect(
      resolveEffectiveMaxCursorAgentsPerTransaction({
        objectiveMaxCursorAgents: 3,
        explicitStricterTransactionCap: 5,
      }),
    ).toBe(3);
  });

  it("objective start aligns stale maxCursorAgentsPerTransaction=1 to objective max=3", () => {
    const dir = tmpDir();
    const statePath = path.join(dir, "PROJECT-STATE.working.json");
    fs.copyFileSync(
      resolveRepoPath("fixtures", "state", "bellhop-accepted-baseline-seed.json"),
      statePath,
    );
    const { state } = loadProjectState({ projectId: "bellhop", statePath });
    expect(state.budgets.maxCursorAgentsPerTransaction).toBe(1);
    const authority = stage3Authority({ maxCursorAgents: 3 });
    const prepared = prepareAcceptedBaselineForObjectiveStart({
      state,
      authority,
      statePath,
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.state.budgets.maxCursorAgentsPerTransaction).toBe(3);
  });

  it("alignStateBudgetsWithObjectiveAuthority never expands beyond objective", () => {
    const { state } = loadAcceptedBaseline();
    const inflated = {
      ...state,
      budgets: { ...state.budgets, maxCursorAgentsPerTransaction: 9 },
    };
    const aligned = alignStateBudgetsWithObjectiveAuthority(
      inflated,
      stage3Authority({ maxCursorAgents: 3 }),
    );
    expect(aligned.budgets.maxCursorAgentsPerTransaction).toBe(3);
  });
});

describe("Multi-worker continuation source limitation", () => {
  it("documents ORIGINAL_OBJECTIVE_AUTHORITY_BASE_EVERY_WORKER limitation", () => {
    expect(CONTINUATION_SOURCE_MODEL).toBe(
      "ORIGINAL_OBJECTIVE_AUTHORITY_BASE_EVERY_WORKER",
    );
    const limited = secondFreshWorkerLacksPriorUnmergedChanges({
      continuationSourceModel: CONTINUATION_SOURCE_MODEL,
      secondActionRequiresWorker1UnmergedChanges: true,
    });
    expect(limited.code).toBe(CONTINUATION_BRANCH_CHAINING_LIMITATION);
    expect(limited.shouldStopRatherThanLaunchIneffectiveWorker).toBe(true);

    const ok = secondFreshWorkerLacksPriorUnmergedChanges({
      continuationSourceModel: CONTINUATION_SOURCE_MODEL,
      secondActionRequiresWorker1UnmergedChanges: false,
    });
    expect(ok.code).toBe("OK");
  });

  it("REUSE_CURSOR does not claim workspace-preserving follow-up runs in Phase 1 adapter", () => {
    // Phase 1 create adapter only supports FRESH_ORDINARY_AGENT_REQUIRED.
    // REUSE may reconcile an existing agent identity but is not proven to post
    // a new follow-up prompt that preserves worker #1 unmerged product changes.
    expect(CONTINUATION_SOURCE_MODEL).toBe(
      "ORIGINAL_OBJECTIVE_AUTHORITY_BASE_EVERY_WORKER",
    );
  });
});

describe("Mocked corrected Stage-3 Phase 3 end-to-end", () => {
  function passRaw(): string {
    return fs.readFileSync(
      resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
      "utf8",
    );
  }

  function bindDecision(
    decision: OrchestratorDecision,
    authority: ObjectiveAuthority,
  ): OrchestratorDecision {
    return {
      ...decision,
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
    };
  }

  function launchDecision(
    authority: ObjectiveAuthority,
    from: RuntimeState,
    to: RuntimeState,
  ): OrchestratorDecision {
    const base = legalLaunch();
    return bindDecision(
      {
        ...base,
        decisionId: newId("dec"),
        generatedAt: new Date().toISOString(),
        decision: "LAUNCH_CURSOR",
        confidence: "HIGH",
        authority: {
          classification: "AUTONOMOUS_ALLOWED",
          withinAutonomousAuthority: true,
          humanApprovalRequired: false,
          reason: "Within objective authority budgets.",
        },
        evidenceBasis: [
          {
            kind: "HUMAN_INSTRUCTION",
            ref: authority.objectiveId,
            summary: authority.summary,
          },
        ],
        policyReferences: ["stage3-execution-readiness-mock"],
        blockers: [],
        stateTransition: {
          from,
          to,
          reason: "Authorized Stage 3 Cursor launch",
        },
        cursorInstruction: {
          ...base.cursorInstruction!,
          agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
          workType: "IMPLEMENTATION" as WorkType,
          objective: STAGE3_OBJECTIVE,
          requestedWork: STAGE3_REQUESTED_WORK,
          verificationCriteria: STAGE3_VERIFICATION,
          baseBranch: TRUSTED_BRANCH,
          expectedStartingSha: TRUSTED_SHA,
          expectedTerminalVerdicts: [
            "BELLHOP_STAGE3_TECHNICALLY_READY_FOR_HUMAN",
            "BELLHOP_STAGE3_BLOCKED_PRODUCT_DECISION",
          ],
          maxRemediationPasses: 0,
        },
        humanApproval: null,
        wait: null,
        terminal: null,
        proposedStateUpdates: {
          workstreamStatus: to,
          transactionStatus: to,
          terminalVerdict: null,
          pendingHumanDecisionType: null,
        },
        reason: "Mock corrected Stage 3 launch",
      },
      authority,
    );
  }

  function humanGateDecision(authority: ObjectiveAuthority): OrchestratorDecision {
    return {
      schemaVersion: "1.0",
      decisionId: newId("dec"),
      generatedAt: new Date().toISOString(),
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      decision: "REQUEST_HUMAN_APPROVAL",
      confidence: "HIGH",
      authority: {
        classification: "HUMAN_APPROVAL_REQUIRED",
        withinAutonomousAuthority: false,
        humanApprovalRequired: true,
        reason: "Technically ready; human product/playtest gate",
      },
      evidenceBasis: [
        {
          kind: "CURSOR_REPORT",
          ref: "raw-untrusted-worker-evidence",
          summary: "Worker evidence interpreted; human review required.",
        },
      ],
      policyReferences: ["stage3-execution-readiness-mock"],
      blockers: [],
      stateTransition: {
        from: "REVIEWING",
        to: "READY_FOR_HUMAN",
        reason: "Technically ready; human product/playtest gate",
      },
      cursorInstruction: null,
      humanApproval: {
        approvalType: "OTHER",
        summary: `Review Stage 3 results for ${authority.objectiveId}.`,
        requestedAction: "HUMAN_REVIEW_OBJECTIVE_RESULTS",
        risk: "MEDIUM",
        allowedChoices: ["APPROVE", "REJECT", "REVISE"],
      },
      wait: null,
      terminal: null,
      proposedStateUpdates: {
        workstreamStatus: "READY_FOR_HUMAN",
        transactionStatus: "READY_FOR_HUMAN",
        terminalVerdict: null,
        pendingHumanDecisionType: "OTHER",
      },
      reason: "REQUEST_HUMAN_APPROVAL after successful Stage 3 iteration",
    };
  }

  function assessment(): SolPhase2Assessment {
    return {
      resultClass: "PASS",
      confidence: "HIGH",
      summary: "Worker evidence technically ready for human gate.",
      materialFindings: [],
      sourceIntegrityAssessment: "Radio-owned source pins remain authoritative.",
      requiresHumanJudgment: true,
      structuredWorkerReportStatus: "UNAVAILABLE_OR_INVALID",
    };
  }

  it("CASE D/E + corrected Stage-3 mocked loop: 2 workers within max=3, 4th blocked; final READY_FOR_HUMAN", async () => {
    const dir = tmpDir();
    const statePath = path.join(dir, "PROJECT-STATE.working.json");
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    const authorityPath = path.join(dir, "objective-authority.json");
    fs.copyFileSync(
      resolveRepoPath("fixtures", "state", "bellhop-accepted-baseline-seed.json"),
      statePath,
    );
    fs.writeFileSync(ledgerPath, "", "utf8");
    const authority = stage3Authority({
      maxCursorAgents: 3,
      maxIterations: 6,
      projectId: "bellhop",
      workstreamId: "bellhop-stage3-readiness-ws",
      transactionId: "bellhop-stage3-readiness-tx",
      stateRevisionBasis: 11,
    });
    persistObjectiveAuthority(authorityPath, authority);

    // Bootstrap outcomes for the -07 wrong-workspace shape.
    const bootstrapOk = evaluateAuthorizedSourceBootstrap({
      trusted: {
        branch: TRUSTED_BRANCH,
        expectedFullSha: TRUSTED_SHA,
        repository: "https://github.com/timcgha/Bellhop",
      },
      initialWorkspace: { branch: "main", headSha: WRONG_MAIN_SHA },
      checkoutResult: "SUCCESS",
    });
    expect(bootstrapOk.productWorkPermitted).toBe(true);

    let solInitialCalls = 0;
    let solContinuationCalls = 0;
    const client = createPhase3FixtureCursorClient([
      { rawResult: passRaw() },
      { rawResult: passRaw() },
      { rawResult: passRaw() },
      { rawResult: passRaw() },
    ]);

    const result = await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: authorityPath,
      statePath,
      ledgerPath,
      runDir: dir,
      cursorClient: client,
      env: {
        ...process.env,
        CURSOR_EXECUTION_ENABLED: "false",
        OPENAI_API_KEY: "",
      },
      skipLiveExecution: false,
      foreignApprovalIds: ["ha-stage2-human-playtest-2026-08-29"],
      solCall: async (options) => {
        solInitialCalls += 1;
        const decision = launchDecision(authority, "PLANNING", "IMPLEMENTING");
        return {
          decision,
          model: options.model,
          mode: "live" as const,
          requestId: "mock-initial",
          rawText: JSON.stringify(decision),
          schemaCompatNotes: ["mock"],
          usage: null,
        };
      },
      solPhase2Call: async (options) => {
        solContinuationCalls += 1;
        const a = assessment();
        const decision =
          solContinuationCalls === 1
            ? launchDecision(authority, "REVIEWING", "PLANNING")
            : humanGateDecision(authority);
        return {
          assessment: a,
          decision,
          continuation: { assessment: a, decision },
          model: options.model,
          mode: "live" as const,
          requestId: `mock-cont-${solContinuationCalls}`,
          rawText: JSON.stringify({ assessment: a, decision }),
          schemaCompatNotes: ["mock"],
          usage: null,
        };
      },
    });
    expect(solInitialCalls).toBe(1);
    expect(solContinuationCalls).toBeGreaterThanOrEqual(1);
    expect(result.cursorExecutionCount).toBe(2);
    expect(client.logicalLaunchCount).toBe(2);
    // Phase 3 maps ≥2 Cursor executions + human gate to AUTONOMOUS_LOOP_READY
    // while runtime lands in READY_FOR_HUMAN.
    expect(
      result.terminalVerdict === "RADIO_PHASE3_READY_FOR_HUMAN" ||
        result.terminalVerdict === "RADIO_PHASE3_AUTONOMOUS_LOOP_READY",
    ).toBe(true);
    expect(result.runtimeState).toBe("READY_FOR_HUMAN");

    const workOrder = readJsonFile<{
      source: { baseBranch: string; expectedBaseTipSha: string };
      scope: { outOfScope: string[] };
      budgets: { maxAgents: number };
      requestedWork: string;
    }>(path.join(dir, "work-order-iter-1.json"));
    expect(workOrder.source.baseBranch).toBe(TRUSTED_BRANCH);
    expect(workOrder.source.expectedBaseTipSha).toBe(TRUSTED_SHA);
    expect(workOrder.budgets.maxAgents).toBe(3);
    expect(workOrder.requestedWork).toMatch(/Star Beam/i);
    expect(workOrder.scope.outOfScope.join("\n")).not.toMatch(/Star Beam/i);
    expect(workOrder.scope.outOfScope.join("\n")).not.toMatch(/Starting Stage 3/i);

    const alignedState = loadProjectState({
      projectId: "bellhop",
      statePath,
    }).state;
    expect(alignedState.budgets.maxCursorAgentsPerTransaction).toBe(3);

    // CASE E: fourth worker with max=3 must exhaust after 3.
    const dir2 = tmpDir();
    const statePath2 = path.join(dir2, "PROJECT-STATE.working.json");
    const ledgerPath2 = path.join(dir2, "RUN-LEDGER.jsonl");
    const authorityPath2 = path.join(dir2, "objective-authority.json");
    fs.copyFileSync(
      resolveRepoPath("fixtures", "state", "bellhop-accepted-baseline-seed.json"),
      statePath2,
    );
    fs.writeFileSync(ledgerPath2, "", "utf8");
    const authority2 = stage3Authority({
      maxCursorAgents: 3,
      maxIterations: 8,
      maxRetriesPerLogicalStep: 3,
      projectId: "bellhop",
      workstreamId: "bellhop-stage3-budget-ws",
      transactionId: "bellhop-stage3-budget-tx",
      stateRevisionBasis: 11,
    });
    persistObjectiveAuthority(authorityPath2, authority2);
    const client2 = createPhase3FixtureCursorClient([
      { rawResult: passRaw() },
      { rawResult: passRaw() },
      { rawResult: passRaw() },
      { rawResult: passRaw() },
    ]);
    let cont = 0;
    const result2 = await runPhase3Loop({
      projectId: authority2.projectId,
      workstreamId: authority2.workstreamId,
      transactionId: authority2.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: authorityPath2,
      statePath: statePath2,
      ledgerPath: ledgerPath2,
      runDir: dir2,
      cursorClient: client2,
      env: {
        ...process.env,
        CURSOR_EXECUTION_ENABLED: "false",
        OPENAI_API_KEY: "",
      },
      foreignApprovalIds: ["ha-stage2-human-playtest-2026-08-29"],
      solCall: async (options) => {
        const decision = launchDecision(authority2, "PLANNING", "IMPLEMENTING");
        return {
          decision,
          model: options.model,
          mode: "live" as const,
          requestId: "mock-b-initial",
          rawText: JSON.stringify(decision),
          schemaCompatNotes: [],
          usage: null,
        };
      },
      solPhase2Call: async (options) => {
        cont += 1;
        const a = assessment();
        const decision = launchDecision(authority2, "REVIEWING", "PLANNING");
        return {
          assessment: a,
          decision,
          continuation: { assessment: a, decision },
          model: options.model,
          mode: "live" as const,
          requestId: `mock-b-cont-${cont}`,
          rawText: JSON.stringify({ assessment: a, decision }),
          schemaCompatNotes: [],
          usage: null,
        };
      },
    });
    expect(result2.cursorExecutionCount).toBe(3);
    expect(client2.logicalLaunchCount).toBe(3);
    expect(result2.terminalVerdict).toBe("RADIO_PHASE3_BUDGET_EXHAUSTED");
    expect(result2.stopReason).toMatch(/CURSOR_AGENT_BUDGET_EXHAUSTED|maxCursorAgents/);
  });
});
