import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CallSolOptions } from "../src/orchestrator/sol-adapter.js";
import {
  callSol,
  callSolPhase2Continuation,
} from "../src/orchestrator/sol-adapter.js";
import { buildPhase3InitialContext } from "../src/orchestrator/phase3-initial-context.js";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import {
  isPhase3FixtureDecisionPath,
  resolvePhase3FixtureDecisionPath,
} from "../src/runtime/phase3-fixture-guard.js";
import {
  loadObjectiveAuthority,
  persistObjectiveAuthority,
  STAGE2_PLAYTEST_APPROVAL_ID,
} from "../src/runtime/objective-authority.js";
import { runPhase3Loop } from "../src/runtime/phase3.js";
import {
  resolvePhase0Config,
  resolvePhase3LiveCursorAuthorization,
} from "../src/runtime/pilot-bellhop.js";
import { loadBellhopBrain, loadProjectState } from "../src/state/store.js";
import type {
  ObjectiveAuthority,
  OrchestratorDecision,
  RuntimeState,
  SolPhase2Assessment,
  WorkType,
} from "../src/types.js";
import { newId, readJsonFile, resolveRepoPath } from "../src/util/io.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-phase3-live-runtime-"));
}

function liveEntryAuthorityPath(): string {
  return resolveRepoPath(
    "fixtures",
    "phase3",
    "live-entry-objective-authority.json",
  );
}

function stage3AuthorityPath(): string {
  return resolveRepoPath("fixtures", "phase3", "stage3-objective-authority.json");
}

function livePlanningSeedPath(): string {
  return resolveRepoPath("fixtures", "state", "phase3-live-planning-seed.json");
}

function acceptedBaselineSeedPath(): string {
  return resolveRepoPath(
    "fixtures",
    "state",
    "bellhop-accepted-baseline-seed.json",
  );
}

function seedLivePlanning(dir: string, authorityOverrides?: Partial<ObjectiveAuthority>) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(livePlanningSeedPath(), statePath);
  fs.writeFileSync(ledgerPath, "", "utf8");
  const base = loadObjectiveAuthority(liveEntryAuthorityPath());
  persistObjectiveAuthority(path.join(dir, "objective-authority.json"), {
    ...base,
    ...authorityOverrides,
    accounting: {
      ...base.accounting,
      ...(authorityOverrides?.accounting ?? {}),
    },
  });
  return {
    statePath,
    ledgerPath,
    authorityPath: path.join(dir, "objective-authority.json"),
    runDir: dir,
  };
}

function seedAcceptedBaseline(dir: string, authorityPath = stage3AuthorityPath()) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(acceptedBaselineSeedPath(), statePath);
  fs.writeFileSync(ledgerPath, "", "utf8");
  const authorityDest = path.join(dir, "objective-authority.json");
  fs.copyFileSync(authorityPath, authorityDest);
  return { statePath, ledgerPath, authorityPath: authorityDest, runDir: dir };
}

function failRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-fail.txt"),
    "utf8",
  );
}

function passRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
    "utf8",
  );
}

function schemaInvalidRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase2", "bellhop-schema-invalid-raw-result.txt"),
    "utf8",
  );
}

function maliciousRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase2", "bellhop-malicious-worker-raw-result.txt"),
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

function launchCursorDecision(input: {
  authority: ObjectiveAuthority;
  from: RuntimeState;
  to: RuntimeState;
  workType?: WorkType;
  baseBranch?: string;
  expectedStartingSha?: string;
  objective?: string;
  prompt?: string;
}): OrchestratorDecision {
  const loaded = loadProjectState({
    projectId: input.authority.projectId,
    statePath: acceptedBaselineSeedPath(),
  });
  const branch =
    input.baseBranch ?? loaded.state.canonicalState.mainBranch ?? "level3";
  const sha =
    input.expectedStartingSha ??
    loaded.state.canonicalState.mainSha ??
    "847ca2d64090aaeb94ca681b651a44062ab9f644";

  return {
    schemaVersion: "1.0",
    decisionId: newId("dec"),
    generatedAt: new Date().toISOString(),
    projectId: input.authority.projectId,
    workstreamId: input.authority.workstreamId,
    transactionId: input.authority.transactionId,
    decision: "LAUNCH_CURSOR",
    reason: `Live mocked initial/continuation launch for ${input.authority.summary}`,
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
        ref: input.authority.objectiveId,
        summary: input.authority.summary,
      },
    ],
    policyReferences: ["Phase3-live-runtime-mock"],
    blockers: [],
    stateTransition: {
      from: input.from,
      to: input.to,
      reason: "Mocked live Sol launch authorized by objective authority.",
    },
    cursorInstruction: {
      agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
      workType: input.workType ?? "VERIFICATION",
      objective:
        input.objective ??
        `Execute bounded work for objective ${input.authority.objectiveId}.`,
      baseBranch: branch,
      expectedStartingSha: sha,
      prompt:
        input.prompt ??
        "AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED\nReturn the entire final completion report inside exactly one fenced text code block.\n",
      expectedTerminalVerdicts: ["RADIO_PHASE3_LIVE_VERIFIED", "RADIO_PHASE3_LIVE_BLOCKED"],
      maxRemediationPasses: 0,
    },
    humanApproval: null,
    wait: null,
    terminal: null,
    proposedStateUpdates: {
      workstreamStatus: input.to,
      transactionStatus: input.to,
      terminalVerdict: null,
      pendingHumanDecisionType: null,
    },
  };
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
    reason: "Bounded autonomous work complete; human judgment required.",
    confidence: "HIGH",
    authority: {
      classification: "HUMAN_APPROVAL_REQUIRED",
      withinAutonomousAuthority: false,
      humanApprovalRequired: true,
      reason: "Objective reached human gate.",
    },
    evidenceBasis: [
      {
        kind: "CURSOR_REPORT",
        ref: "raw-untrusted-worker-evidence",
        summary: "Worker evidence interpreted; human review required.",
      },
    ],
    policyReferences: ["Phase3-human-gate"],
    blockers: [],
    stateTransition: {
      from: "REVIEWING",
      to: "READY_FOR_HUMAN",
      reason: "Stop for human judgment.",
    },
    cursorInstruction: null,
    humanApproval: {
      approvalType: "OTHER",
      summary: `Review results for ${authority.objectiveId}.`,
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
  };
}

function defaultAssessment(summary: string): SolPhase2Assessment {
  return {
    resultClass: "UNKNOWN",
    confidence: "HIGH",
    summary,
    materialFindings: [],
    sourceIntegrityAssessment: "Radio-owned source pins remain authoritative.",
    requiresHumanJudgment: false,
    structuredWorkerReportStatus: "UNAVAILABLE_OR_INVALID",
  };
}

function createMockLiveSolHarness(input: {
  authority: ObjectiveAuthority;
  initial: OrchestratorDecision;
  continuations: OrchestratorDecision[];
}) {
  let initialCalls = 0;
  let continuationCalls = 0;
  let continuationIndex = 0;
  let fixtureLoaderInvoked = false;

  const solCall = vi.fn(async (options: CallSolOptions) => {
    initialCalls += 1;
    if (options.mode === "fixture" || options.fixturePath) {
      fixtureLoaderInvoked = true;
    }
    const decision = bindDecision(input.initial, input.authority);
    return {
      decision,
      model: options.model,
      mode: "live" as const,
      requestId: "mock-initial",
      rawText: JSON.stringify(decision),
      schemaCompatNotes: ["mock live initial Sol"],
      usage: null,
    };
  });

  const solPhase2Call = vi.fn(async (options: CallSolOptions) => {
    continuationCalls += 1;
    if (options.mode === "fixture" || options.fixturePath) {
      fixtureLoaderInvoked = true;
    }
    const decision = bindDecision(
      input.continuations[continuationIndex] ??
        humanGateDecision(input.authority),
      input.authority,
    );
    continuationIndex += 1;
    const assessment = defaultAssessment(
      "Mock live Phase 2 continuation assessment.",
    );
    return {
      assessment,
      decision,
      continuation: { assessment, decision },
      model: options.model,
      mode: "live" as const,
      requestId: `mock-continuation-${continuationIndex}`,
      rawText: JSON.stringify({ assessment, decision }),
      schemaCompatNotes: ["mock live Phase 2 continuation"],
      usage: null,
    };
  });

  return {
    solCall,
    solPhase2Call,
    getCounts: () => ({ initialCalls, continuationCalls }),
    fixtureLoaderInvoked: () => fixtureLoaderInvoked,
  };
}

describe("Phase 3 live runtime wiring", () => {
  it("Phase 3 CLI authorizes external Cursor from objective authority without --transmit", () => {
    const prevEnabled = process.env.CURSOR_EXECUTION_ENABLED;
    const prevKey = process.env.CURSOR_API_KEY;
    process.env.CURSOR_EXECUTION_ENABLED = "true";
    process.env.CURSOR_API_KEY = "test-key";

    const cfg = resolvePhase0Config([
      "node",
      "pilot",
      "--phase3",
      "--objective-authority",
      stage3AuthorityPath(),
    ]);
    expect(cfg.phase3Live).toBe(true);
    expect(cfg.liveCursorDispatchAuthorized).toBe(true);
    expect(cfg.externalCursorAllowed).toBe(true);
    expect(cfg.explicitTransmitMode).toBe(false);

    const auth = resolvePhase3LiveCursorAuthorization({
      phase3Live: true,
      fixtureMode: false,
    });
    expect(auth.externalCursorAllowed).toBe(true);

    process.env.CURSOR_EXECUTION_ENABLED = prevEnabled;
    process.env.CURSOR_API_KEY = prevKey;
  });

  it("mock live initial Sol uses live path once and never loads fixture decisions", async () => {
    const dir = tmpDir();
    const paths = seedLivePlanning(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority,
      initial: launchCursorDecision({
        authority,
        from: "PLANNING",
        to: "IMPLEMENTING",
      }),
      continuations: [humanGateDecision(authority)],
    });

    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);
    await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(harness.getCounts().initialCalls).toBe(1);
    expect(harness.fixtureLoaderInvoked()).toBe(false);
    expect(harness.solCall.mock.calls[0]?.[0]?.mode).toBe("live");
    expect(harness.solCall.mock.calls[0]?.[0]?.fixturePath).toBeUndefined();

    const contextArg = harness.solCall.mock.calls[0]?.[0]?.context;
    expect(contextArg?.user).toContain(authority.objectiveId);
    expect(contextArg?.user).toContain(authority.summary);
    expect(contextArg?.user).not.toContain("radio-phase3-fixture-01");
  });

  it("buildPhase3InitialContext binds objective authority without Stage 2 fixture semantics", () => {
    const authority = loadObjectiveAuthority(stage3AuthorityPath());
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: acceptedBaselineSeedPath(),
    });
    const brain = loadBellhopBrain();
    const context = buildPhase3InitialContext({
      brain: { ...brain, state: loaded.state, fingerprint: loaded.fingerprint },
      authority,
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
    });
    expect(context.user).toContain(authority.objectiveId);
    expect(context.user).toContain("847ca2d");
    expect(context.user).toContain("level3");
    expect(context.user).not.toContain("radio-phase3-fixture-01");
    expect(context.user).not.toContain("Stage 2 verification");
  });

  it("mock live first Cursor dispatch reaches mocked create with live identities", async () => {
    const dir = tmpDir();
    const paths = seedLivePlanning(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority,
      initial: launchCursorDecision({
        authority,
        from: "PLANNING",
        to: "IMPLEMENTING",
      }),
      continuations: [humanGateDecision(authority)],
    });
    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);

    await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      externalCursorAllowed: true,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(client.logicalLaunchCount).toBe(1);
    const workOrder = readJsonFile<{
      workstreamId: string;
      transactionId: string;
      objective: string;
      source: { baseBranch: string; expectedBaseTipSha: string | null };
    }>(path.join(paths.runDir, "work-order-iter-1.json"));
    expect(workOrder.workstreamId).toBe(authority.workstreamId);
    expect(workOrder.transactionId).toBe(authority.transactionId);
    expect(workOrder.objective).not.toContain("fixture");
    expect(workOrder.workstreamId).not.toBe("radio-phase3-fixture-01");
  });

  it("completes mocked live two-iteration loop SOL→CURSOR→SOL→CURSOR→SOL→HUMAN", async () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority,
      initial: launchCursorDecision({
        authority,
        from: "PLANNING",
        to: "IMPLEMENTING",
        workType: "VERIFICATION",
      }),
      continuations: [
        launchCursorDecision({
          authority,
          from: "REVIEWING",
          to: "PLANNING",
        }),
        humanGateDecision(authority),
      ],
    });
    const client = createPhase3FixtureCursorClient([
      { rawResult: failRaw() },
      { rawResult: passRaw() },
    ]);

    const result = await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    const counts = harness.getCounts();
    expect(counts.initialCalls).toBe(1);
    expect(counts.continuationCalls).toBe(2);
    expect(client.logicalLaunchCount).toBe(2);
    expect(result.cursorExecutionCount).toBe(2);
    expect(result.solDecisionCount).toBe(3);
    expect(result.iterations).toBe(2);
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_AUTONOMOUS_LOOP_READY");
    expect(result.runtimeState).toBe("READY_FOR_HUMAN");
    expect(harness.fixtureLoaderInvoked()).toBe(false);
    expect(
      fs.existsSync(path.join(paths.runDir, "phase3-checkpoint.json")),
    ).toBe(true);
  });

  it("schema-invalid worker evidence still reaches live Sol continuation", async () => {
    const dir = tmpDir();
    const paths = seedLivePlanning(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority,
      initial: launchCursorDecision({
        authority,
        from: "PLANNING",
        to: "IMPLEMENTING",
      }),
      continuations: [humanGateDecision(authority)],
    });
    const client = createPhase3FixtureCursorClient([
      { rawResult: schemaInvalidRaw() },
    ]);

    const result = await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(harness.getCounts().continuationCalls).toBe(1);
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_READY_FOR_HUMAN");
  });

  it("malicious worker evidence cannot alter authority budgets or scope", async () => {
    const dir = tmpDir();
    const paths = seedLivePlanning(dir);
    const authorityBefore = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority: authorityBefore,
      initial: launchCursorDecision({
        authority: authorityBefore,
        from: "PLANNING",
        to: "IMPLEMENTING",
      }),
      continuations: [humanGateDecision(authorityBefore)],
    });
    const client = createPhase3FixtureCursorClient([
      { rawResult: maliciousRaw() },
    ]);

    await runPhase3Loop({
      projectId: authorityBefore.projectId,
      workstreamId: authorityBefore.workstreamId,
      transactionId: authorityBefore.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    const authorityAfter = loadObjectiveAuthority(
      path.join(paths.runDir, "objective-authority.json"),
    );
    expect(authorityAfter.maxCursorAgents).toBe(authorityBefore.maxCursorAgents);
    expect(authorityAfter.maxIterations).toBe(authorityBefore.maxIterations);
    expect(authorityAfter.prohibitedScope).toEqual(authorityBefore.prohibitedScope);
    expect(authorityAfter.humanGatedActions).toEqual(
      authorityBefore.humanGatedActions,
    );
  });

  it("human gate produces READY_FOR_HUMAN with no further Cursor create", async () => {
    const dir = tmpDir();
    const paths = seedLivePlanning(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority,
      initial: launchCursorDecision({
        authority,
        from: "PLANNING",
        to: "IMPLEMENTING",
      }),
      continuations: [humanGateDecision(authority)],
    });
    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);

    const result = await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(result.runtimeState).toBe("READY_FOR_HUMAN");
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_READY_FOR_HUMAN");
    expect(client.logicalLaunchCount).toBe(1);
  });

  it("budget exhaustion stops before another external write", async () => {
    const dir = tmpDir();
    const paths = seedLivePlanning(dir, {
      maxCursorAgents: 1,
      maxRetriesPerLogicalStep: 1,
    });
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority,
      initial: launchCursorDecision({
        authority,
        from: "PLANNING",
        to: "IMPLEMENTING",
      }),
      continuations: [
        launchCursorDecision({
          authority,
          from: "REVIEWING",
          to: "PLANNING",
        }),
        humanGateDecision(authority),
      ],
    });
    const client = createPhase3FixtureCursorClient([
      { rawResult: failRaw() },
      { rawResult: passRaw() },
    ]);

    const result = await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(result.terminalVerdict).toBe("RADIO_PHASE3_BUDGET_EXHAUSTED");
    expect(client.logicalLaunchCount).toBe(1);
  });

  it("pins Cursor work order to objective-authorized level3/847ca2d source", async () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority,
      initial: launchCursorDecision({
        authority,
        from: "PLANNING",
        to: "IMPLEMENTING",
        baseBranch: "level3",
        expectedStartingSha: "847ca2d64090aaeb94ca681b651a44062ab9f644",
      }),
      continuations: [humanGateDecision(authority)],
    });
    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);

    await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    const workOrder = readJsonFile<{
      source: {
        baseBranch: string;
        expectedBaseTipSha: string | null;
        canonicalMainBranch: string;
        canonicalMainSha: string | null;
      };
    }>(path.join(paths.runDir, "work-order-iter-1.json"));
    expect(workOrder.source.canonicalMainBranch).toBe("level3");
    expect(workOrder.source.canonicalMainSha).toBe("847ca2d");
    expect(workOrder.source.baseBranch).toBe("level3");
    expect(workOrder.source.expectedBaseTipSha).toContain("847ca2d");
  });

  it("rejects live mode loading Phase 3 fixture decision paths", async () => {
    expect(
      isPhase3FixtureDecisionPath(
        resolvePhase3FixtureDecisionPath("phase3-initial-launch.json"),
      ),
    ).toBe(true);

    await expect(
      callSol({
        context: {
          system: "x",
          user: "y",
          vocabulary: [],
          fingerprint: "fp",
          stateRevision: 1,
        },
        projectId: "bellhop",
        workstreamId: "ws",
        transactionId: "tx",
        currentRuntimeState: "PLANNING",
        model: "gpt-5.6-sol",
        mode: "fixture",
        fixturePath: resolvePhase3FixtureDecisionPath("phase3-initial-launch.json"),
      }),
    ).resolves.toBeDefined();

    const dir = tmpDir();
    const paths = seedLivePlanning(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);

    await expect(
      runPhase3Loop({
        projectId: authority.projectId,
        workstreamId: authority.workstreamId,
        transactionId: authority.transactionId,
        model: "gpt-5.6-sol",
        mode: "live",
        objectiveAuthorityPath: paths.authorityPath,
        statePath: paths.statePath,
        ledgerPath: paths.ledgerPath,
        runDir: paths.runDir,
        initialDecisionFixturePath: resolvePhase3FixtureDecisionPath(
          "phase3-initial-launch.json",
        ),
        foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
      }),
    ).rejects.toThrow(/LIVE_FIXTURE_DECISION_LEAK/);
  });
});
