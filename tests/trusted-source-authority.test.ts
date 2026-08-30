/**
 * Trusted source authority: ObjectiveAuthority owns baseBranch + expectedStartingSha.
 * Sol claims must exactly match; work orders and remote precheck use Radio-owned values.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CursorApiClient, V1CreateAgentRequest } from "../src/cursor/api-client.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { isFullGitCommitSha } from "../src/cursor/source-ref.js";
import type { CallSolOptions } from "../src/orchestrator/sol-adapter.js";
import {
  buildObjectiveAuthorityIdentityMaterial,
  checkObjectiveAuthorityForDecision,
  checkSolSourceBinding,
  computeObjectiveAuthorityIdentity,
  loadObjectiveAuthority,
  STAGE2_PLAYTEST_APPROVAL_ID,
  validateObjectiveAuthorityForLiveEntry,
  validateTrustedSourcePinForLive,
} from "../src/runtime/objective-authority.js";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import { prepareAcceptedBaselineForObjectiveStart } from "../src/runtime/phase3-objective-start.js";
import { runPhase3Loop } from "../src/runtime/phase3.js";
import {
  ensureLedgerFile,
  transmitCursorWorkOrder,
} from "../src/runtime/transmitter.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  ObjectiveAuthority,
  OrchestratorDecision,
  PolicyEvaluation,
  RuntimeState,
  WorkType,
} from "../src/types.js";
import { newId, nowIso, readJsonFile, resolveRepoPath } from "../src/util/io.js";

const LEVEL3_FULL = "847ca2d64090aaeb94ca681b651a44062ab9f644";
const LEVEL3_SHORT = "847ca2d";
const MALICIOUS_FULL = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRONG_REMOTE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-trusted-src-"));
}

function liveEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CURSOR_API_KEY: "test-cursor-key-not-real",
    CURSOR_EXECUTION_ENABLED: "true",
    OPENAI_API_KEY: "test-openai-key-not-real",
  };
}

function stage3AuthorityPath(): string {
  return resolveRepoPath("fixtures", "phase3", "stage3-objective-authority.json");
}

function acceptedBaselineSeedPath(): string {
  return resolveRepoPath(
    "fixtures",
    "state",
    "bellhop-accepted-baseline-seed.json",
  );
}

function seedAcceptedBaseline(dir: string) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(acceptedBaselineSeedPath(), statePath);
  fs.writeFileSync(ledgerPath, "", "utf8");
  const authorityDest = path.join(dir, "objective-authority.json");
  fs.copyFileSync(stage3AuthorityPath(), authorityDest);
  return {
    statePath,
    ledgerPath,
    authorityPath: authorityDest,
    runDir: dir,
  };
}

function passRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
    "utf8",
  );
}

function launchCursorDecision(input: {
  authority: ObjectiveAuthority;
  from: RuntimeState;
  to: RuntimeState;
  workType?: WorkType;
  baseBranch?: string | null;
  expectedStartingSha?: string | null;
}): OrchestratorDecision {
  const branch =
    input.baseBranch === undefined
      ? input.authority.baseBranch
      : input.baseBranch;
  const sha =
    input.expectedStartingSha === undefined
      ? input.authority.expectedStartingSha
      : input.expectedStartingSha;
  return {
    schemaVersion: "1.0",
    decisionId: newId("dec"),
    generatedAt: nowIso(),
    projectId: input.authority.projectId,
    workstreamId: input.authority.workstreamId,
    transactionId: input.authority.transactionId,
    decision: "LAUNCH_CURSOR",
    reason: "Trusted source authority regression launch",
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
    policyReferences: ["trusted-source-authority"],
    blockers: [],
    stateTransition: {
      from: input.from,
      to: input.to,
      reason: "Authorized launch for trusted source authority regression.",
    },
    cursorInstruction: {
      agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
      workType: input.workType ?? "IMPLEMENTATION",
      objective: input.authority.summary,
      baseBranch: branch,
      expectedStartingSha: sha,
      requestedWork:
        "authorized Stage 3 work — implement bounded Stage 3 foundation only",
      verificationCriteria:
        "valid Stage 3 criteria — verify prohibited scope was not performed",
      expectedTerminalVerdicts: [
        "RADIO_PHASE3_LIVE_VERIFIED",
        "RADIO_PHASE3_LIVE_BLOCKED",
      ],
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
    generatedAt: nowIso(),
    projectId: authority.projectId,
    workstreamId: authority.workstreamId,
    transactionId: authority.transactionId,
    decision: "REQUEST_HUMAN_APPROVAL",
    reason: "Human judgment required.",
    confidence: "HIGH",
    authority: {
      classification: "HUMAN_APPROVAL_REQUIRED",
      withinAutonomousAuthority: false,
      humanApprovalRequired: true,
      reason: "Human gate.",
    },
    evidenceBasis: [],
    policyReferences: [],
    blockers: [],
    stateTransition: {
      from: "REVIEWING",
      to: "READY_FOR_HUMAN",
      reason: "Stop for human judgment.",
    },
    cursorInstruction: null,
    humanApproval: {
      approvalType: "OTHER",
      summary: authority.summary,
      requestedAction: "HUMAN_REVIEW",
      risk: "MEDIUM",
      allowedChoices: ["APPROVE", "REJECT"],
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

function defaultAssessment(summary: string) {
  return {
    resultClass: "UNKNOWN" as const,
    confidence: "HIGH" as const,
    summary,
    materialFindings: [],
    sourceIntegrityAssessment: "Radio-owned source pins remain authoritative.",
    requiresHumanJudgment: false,
    structuredWorkerReportStatus: "UNAVAILABLE_OR_INVALID" as const,
  };
}

function createMockLiveSolHarness(input: {
  authority: ObjectiveAuthority;
  initial: OrchestratorDecision;
  continuations: OrchestratorDecision[];
}) {
  let continuationIndex = 0;
  const solCall = vi.fn(async (options: CallSolOptions) => {
    const decision = {
      ...input.initial,
      projectId: input.authority.projectId,
      workstreamId: input.authority.workstreamId,
      transactionId: input.authority.transactionId,
    };
    return {
      decision,
      model: options.model,
      mode: "live" as const,
      requestId: "mock-initial",
      rawText: JSON.stringify(decision),
      schemaCompatNotes: ["mock"],
      usage: null,
    };
  });
  const solPhase2Call = vi.fn(async (options: CallSolOptions) => {
    const decision = {
      ...(input.continuations[continuationIndex] ??
        humanGateDecision(input.authority)),
      projectId: input.authority.projectId,
      workstreamId: input.authority.workstreamId,
      transactionId: input.authority.transactionId,
    };
    continuationIndex += 1;
    const assessment = defaultAssessment("Mock continuation");
    return {
      assessment,
      decision,
      continuation: { assessment, decision },
      model: options.model,
      mode: "live" as const,
      requestId: `mock-cont-${continuationIndex}`,
      rawText: JSON.stringify({ assessment, decision }),
      schemaCompatNotes: ["mock"],
      usage: null,
    };
  });
  return { solCall, solPhase2Call };
}

function allowPolicy(decision: OrchestratorDecision): PolicyEvaluation {
  return {
    schemaVersion: "1.0",
    evaluationId: newId("pol"),
    decisionId: decision.decisionId,
    evaluatedAt: nowIso(),
    result: "ALLOW",
    primaryCode: "ALLOW",
    summary: "trusted-source-authority ALLOW",
    triggeredRules: [],
    currentRuntimeState: "PLANNING",
    proposedRuntimeState: "IMPLEMENTING",
    executionPermitted: true,
    solShouldChooseAgain: false,
    humanInputRequired: false,
    requiredApprovalType: null,
    idempotencyKey: `${decision.projectId}:${decision.transactionId}:test`,
    stateFingerprint: "fp-trusted-source",
  };
}

function createRecordingClient(): {
  client: CursorApiClient;
  getCreateCount: () => number;
} {
  let createCount = 0;
  const agentId = "bc-00000000-0000-0000-0000-0000000000bb";
  const runId = "run-trusted-src-mock";
  const client: CursorApiClient = {
    radioClientKind: "test",
    async getMe() {
      return { apiKeyName: "mock", createdAt: nowIso() };
    },
    async createAgent(req: V1CreateAgentRequest) {
      createCount += 1;
      const id = req.agentId ?? agentId;
      return {
        agent: {
          id,
          name: "Mock",
          status: "ACTIVE",
          latestRunId: runId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          url: `https://cursor.com/agents/${id}`,
        },
        run: {
          id: runId,
          agentId: id,
          status: "FINISHED",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      };
    },
    async getAgent(id: string) {
      return {
        id,
        name: "Mock",
        status: "ACTIVE",
        latestRunId: runId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        url: `https://cursor.com/agents/${id}`,
      };
    },
    async getRun(id: string, rid: string) {
      return {
        id: rid,
        agentId: id,
        status: "FINISHED",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        durationMs: 1,
        result: "```text\nRADIO_PHASE3_LIVE_VERIFIED\n```",
      };
    },
    async getAgentUsage() {
      return {
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 2,
        },
        runs: [],
      };
    },
  };
  return { client, getCreateCount: () => createCount };
}

describe("ObjectiveAuthority trusted source pin", () => {
  it("stage3 fixture carries trusted baseBranch + full expectedStartingSha", () => {
    const authority = loadObjectiveAuthority(stage3AuthorityPath());
    expect(authority.baseBranch).toBe("level3");
    expect(authority.expectedStartingSha).toBe(LEVEL3_FULL);
    expect(isFullGitCommitSha(authority.expectedStartingSha)).toBe(true);
    expect(validateTrustedSourcePinForLive(authority).ok).toBe(true);
  });

  it("source pin change alters authority identity", () => {
    const a = loadObjectiveAuthority(stage3AuthorityPath());
    const b = { ...a, expectedStartingSha: MALICIOUS_FULL };
    expect(computeObjectiveAuthorityIdentity(a)).not.toBe(
      computeObjectiveAuthorityIdentity(b),
    );
    expect(buildObjectiveAuthorityIdentityMaterial(a).expectedStartingSha).toBe(
      LEVEL3_FULL,
    );
  });

  it("live entry fails closed on missing source pin", () => {
    const authority = {
      ...loadObjectiveAuthority(stage3AuthorityPath()),
      baseBranch: "",
      expectedStartingSha: "",
    };
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: acceptedBaselineSeedPath(),
    });
    const check = validateObjectiveAuthorityForLiveEntry({
      authority,
      state: { ...loaded.state, activeAgent: null },
    });
    expect(check.ok).toBe(false);
    expect(check.code).toBe("SOURCE_PIN_MISSING");
  });

  it("live entry fails closed on short expectedStartingSha", () => {
    const authority = {
      ...loadObjectiveAuthority(stage3AuthorityPath()),
      expectedStartingSha: LEVEL3_SHORT,
    };
    const check = validateTrustedSourcePinForLive(authority);
    expect(check.ok).toBe(false);
    expect(check.code).toBe("SOURCE_PIN_NOT_FULL_SHA");
  });
});

describe("Sol source binding", () => {
  it("matching Sol claims PASS", () => {
    const authority = loadObjectiveAuthority(stage3AuthorityPath());
    const decision = launchCursorDecision({
      authority,
      from: "PLANNING",
      to: "IMPLEMENTING",
    });
    expect(checkSolSourceBinding({ authority, decision }).ok).toBe(true);
    expect(
      checkObjectiveAuthorityForDecision({ authority, decision }).ok,
    ).toBe(true);
  });

  it("wrong Sol full SHA FAIL even when remote would match Sol", () => {
    const authority = loadObjectiveAuthority(stage3AuthorityPath());
    const decision = launchCursorDecision({
      authority,
      from: "PLANNING",
      to: "IMPLEMENTING",
      expectedStartingSha: MALICIOUS_FULL,
    });
    const check = checkObjectiveAuthorityForDecision({ authority, decision });
    expect(check.ok).toBe(false);
    expect(check.code).toBe("SOL_SOURCE_BINDING_FAILED");
    expect(check.summary).toMatch(/aaaaaaaa/);
  });

  it("wrong Sol baseBranch FAIL even if commit would match", () => {
    const authority = loadObjectiveAuthority(stage3AuthorityPath());
    const decision = launchCursorDecision({
      authority,
      from: "PLANNING",
      to: "IMPLEMENTING",
      baseBranch: "main",
      expectedStartingSha: LEVEL3_FULL,
    });
    const check = checkObjectiveAuthorityForDecision({ authority, decision });
    expect(check.ok).toBe(false);
    expect(check.code).toBe("SOL_SOURCE_BINDING_FAILED");
    expect(check.summary).toMatch(/main/);
  });
});

describe("work order grounded in ObjectiveAuthority", () => {
  it("uses trusted authority values; Sol claim cannot supply dispatch pin", () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: paths.statePath,
    });
    const prepared = prepareAcceptedBaselineForObjectiveStart({
      state: loaded.state,
      authority,
      statePath: paths.statePath,
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.state.currentTransaction?.branchTipSha).toBe(LEVEL3_FULL);

    const decision = launchCursorDecision({
      authority,
      from: "PLANNING",
      to: "IMPLEMENTING",
      expectedStartingSha: MALICIOUS_FULL,
    });
    const workOrder = buildCursorWorkOrder({
      state: prepared.state,
      decision,
      policy: allowPolicy(decision),
      objectiveAuthority: authority,
    });
    expect(workOrder.source.baseBranch).toBe(authority.baseBranch);
    expect(workOrder.source.expectedBaseTipSha).toBe(
      authority.expectedStartingSha,
    );
    expect(workOrder.source.expectedBaseTipSha).not.toBe(MALICIOUS_FULL);
  });
});

describe("malicious Sol regression (primary acceptance)", () => {
  it("wrong Sol SHA + attacker-aligned remote → binding FAIL, create=0", async () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority,
      initial: launchCursorDecision({
        authority,
        from: "PLANNING",
        to: "IMPLEMENTING",
        expectedStartingSha: MALICIOUS_FULL,
        baseBranch: "level3",
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
      resolveRemoteBranchTip: async () => MALICIOUS_FULL,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
      env: liveEnv(),
    });

    expect(result.terminalVerdict).toBe("RADIO_PHASE3_BLOCKED");
    expect(result.stopReason).toMatch(/Sol expectedStartingSha|aaaaaaaa|trusted ObjectiveAuthority/);
    expect(client.logicalLaunchCount).toBe(0);
    expect(result.cursorExecutionCount).toBe(0);
  });

  it("wrong Sol branch → FAIL, create=0", async () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const harness = createMockLiveSolHarness({
      authority,
      initial: launchCursorDecision({
        authority,
        from: "PLANNING",
        to: "IMPLEMENTING",
        baseBranch: "main",
        expectedStartingSha: LEVEL3_FULL,
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
      resolveRemoteBranchTip: async () => LEVEL3_FULL,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
      env: liveEnv(),
    });

    expect(result.terminalVerdict).toBe("RADIO_PHASE3_BLOCKED");
    expect(result.stopReason).toMatch(/Sol baseBranch|trusted ObjectiveAuthority baseBranch/);
    expect(client.logicalLaunchCount).toBe(0);
  });
});

describe("authority pin vs remote pin (independent checks)", () => {
  it("matching Sol + wrong remote → SOURCE_REF_PRECHECK_FAILED, create=0", async () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: paths.statePath,
    });
    const prepared = prepareAcceptedBaselineForObjectiveStart({
      state: loaded.state,
      authority,
      statePath: paths.statePath,
    });
    expect(prepared.ok).toBe(true);

    const decision = launchCursorDecision({
      authority,
      from: "PLANNING",
      to: "IMPLEMENTING",
    });
    const workOrder = buildCursorWorkOrder({
      state: prepared.state,
      decision,
      policy: allowPolicy(decision),
      objectiveAuthority: authority,
    });
    expect(workOrder.source.expectedBaseTipSha).toBe(LEVEL3_FULL);

    const { client, getCreateCount } = createRecordingClient();
    const runDir = path.join(dir, "tx-run");
    fs.mkdirSync(runDir, { recursive: true });
    ensureLedgerFile(paths.ledgerPath);
    const result = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state: prepared.state,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      workOrder,
      prompt: "authority-vs-remote",
      forceFixtureTransmit: false,
      explicitTransmitMode: true,
      externalCursorAllowed: true,
      env: liveEnv(),
      client,
      plannedAgentIdOverride: "bc-00000000-0000-0000-0000-0000000000cc",
      pollIntervalMs: 1,
      pollMaxAttempts: 3,
      sleep: async () => undefined,
      resolveRemoteBranchTip: async () => WRONG_REMOTE,
    });
    expect(getCreateCount()).toBe(0);
    expect(result.terminalVerdict).toBe("RADIO_PHASE1_BLOCKED");
    expect(result.summaryNotes.join("\n")).toMatch(/SOURCE_REF_PRECHECK_FAILED/);
  });

  it("valid authority + Sol + remote → create exactly 1; work order from authority", async () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
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
      resolveRemoteBranchTip: async () => LEVEL3_FULL,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
      env: liveEnv(),
    });

    expect(client.logicalLaunchCount).toBe(1);
    expect(result.cursorExecutionCount).toBe(1);
    expect(result.terminalVerdict).toMatch(
      /RADIO_PHASE3_READY_FOR_HUMAN|RADIO_PHASE3_AUTONOMOUS_LOOP_READY/,
    );

    const workOrder = readJsonFile<{
      source: { baseBranch: string; expectedBaseTipSha: string };
    }>(path.join(paths.runDir, "work-order-iter-1.json"));
    expect(workOrder.source.baseBranch).toBe(authority.baseBranch);
    expect(workOrder.source.expectedBaseTipSha).toBe(
      authority.expectedStartingSha,
    );
  });
});

describe("continuation cannot pivot trusted source pin", () => {
  it("continuation Sol wrong SHA → FAIL after first create, no second create", async () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
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
          expectedStartingSha: MALICIOUS_FULL,
        }),
      ],
    });
    const client = createPhase3FixtureCursorClient([
      { rawResult: passRaw() },
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
      resolveRemoteBranchTip: async () => LEVEL3_FULL,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
      env: liveEnv(),
    });

    expect(client.logicalLaunchCount).toBe(1);
    expect(result.cursorExecutionCount).toBe(1);
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_BLOCKED");
    expect(result.stopReason).toMatch(
      /Sol expectedStartingSha|trusted ObjectiveAuthority expectedStartingSha|aaaaaaaa/,
    );
  });
});
