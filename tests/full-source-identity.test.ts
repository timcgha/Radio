/**
 * Full source-identity precision: objective-authorized SHA must survive
 * work-order build and live source-ref precheck without truncation or
 * prefix-equality weakening.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CursorApiClient, V1CreateAgentRequest } from "../src/cursor/api-client.js";
import {
  commitShasMatch,
  deriveSourceLaunchIntent,
  isFullGitCommitSha,
  requireLiveFullCommitSha,
  SourceRefPrecheckError,
  verifyRemoteSourceRef,
} from "../src/cursor/source-ref.js";
import {
  buildCursorWorkOrder,
  resolveAuthoritativeExpectedBaseTipSha,
} from "../src/cursor/work-order-builder.js";
import { prepareAcceptedBaselineForObjectiveStart } from "../src/runtime/phase3-objective-start.js";
import { loadObjectiveAuthority } from "../src/runtime/objective-authority.js";
import {
  ensureLedgerFile,
  transmitCursorWorkOrder,
} from "../src/runtime/transmitter.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  CursorWorkOrder,
  OrchestratorDecision,
  PolicyEvaluation,
  ProjectState,
} from "../src/types.js";
import { newId, nowIso, readJsonFile, resolveRepoPath } from "../src/util/io.js";

const LEVEL3_FULL = "847ca2d64090aaeb94ca681b651a44062ab9f644";
const LEVEL3_SHORT = "847ca2d";
const LEVEL3_PREFIX_OTHER =
  "847ca2d2222222222222222222222222222222222";
const LEVEL3_PREFIX_FAKE =
  "847ca2d1111111111111111111111111111111111";
const WRONG_FULL = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-full-sha-"));
}

function liveEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CURSOR_API_KEY: "test-cursor-key-not-real",
    CURSOR_EXECUTION_ENABLED: "true",
  };
}

function acceptedBaselineState(): ProjectState {
  return loadProjectState({
    projectId: "bellhop",
    statePath: resolveRepoPath(
      "fixtures",
      "state",
      "bellhop-accepted-baseline-seed.json",
    ),
  }).state;
}

function stage3LaunchDecision(overrides?: {
  expectedStartingSha?: string;
  baseBranch?: string;
  requestedWork?: string;
  verificationCriteria?: string;
}): OrchestratorDecision {
  const authority = loadObjectiveAuthority(
    resolveRepoPath("fixtures", "phase3", "stage3-objective-authority.json"),
  );
  return {
    schemaVersion: "1.0",
    decisionId: newId("dec"),
    generatedAt: nowIso(),
    projectId: authority.projectId,
    workstreamId: authority.workstreamId,
    transactionId: authority.transactionId,
    decision: "LAUNCH_CURSOR",
    reason: "Deterministic Stage 3 source-identity regression launch",
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
    policyReferences: ["full-source-identity"],
    blockers: [],
    stateTransition: {
      from: "PLANNING",
      to: "IMPLEMENTING",
      reason: "Authorized Stage 3 launch for source-identity regression.",
    },
    cursorInstruction: {
      agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
      workType: "IMPLEMENTATION",
      objective: authority.summary,
      baseBranch: overrides?.baseBranch ?? "level3",
      expectedStartingSha: overrides?.expectedStartingSha ?? LEVEL3_FULL,
      requestedWork:
        overrides?.requestedWork ??
        "authorized Stage 3 work — implement bounded Stage 3 foundation only",
      verificationCriteria:
        overrides?.verificationCriteria ??
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
      workstreamStatus: "IMPLEMENTING",
      transactionStatus: "IMPLEMENTING",
      terminalVerdict: null,
      pendingHumanDecisionType: null,
    },
  };
}

function allowPolicy(decision: OrchestratorDecision): PolicyEvaluation {
  return {
    schemaVersion: "1.0",
    evaluationId: newId("pol"),
    decisionId: decision.decisionId,
    evaluatedAt: nowIso(),
    result: "ALLOW",
    primaryCode: "ALLOW",
    summary: "Deterministic full-source-identity regression ALLOW",
    triggeredRules: [],
    currentRuntimeState: "PLANNING",
    proposedRuntimeState: "IMPLEMENTING",
    executionPermitted: true,
    solShouldChooseAgain: false,
    humanInputRequired: false,
    requiredApprovalType: null,
    idempotencyKey: `${decision.projectId}:${decision.transactionId}:test`,
    stateFingerprint: "fp-full-source-identity",
  };
}

function buildStage3WorkOrder(input: {
  state: ProjectState;
  decision: OrchestratorDecision;
}): { workOrder: CursorWorkOrder } {
  const policy = allowPolicy(input.decision);
  const workOrder = buildCursorWorkOrder({
    state: input.state,
    decision: input.decision,
    policy,
    objectiveAuthority: loadObjectiveAuthority(
      resolveRepoPath("fixtures", "phase3", "stage3-objective-authority.json"),
    ),
  });
  return { workOrder };
}

function createRecordingClient(): {
  client: CursorApiClient;
  getCreateCount: () => number;
} {
  let createCount = 0;
  let runStatus = "CREATING";
  const agentId = "bc-00000000-0000-0000-0000-0000000000aa";
  const runId = "run-full-sha-mock";
  const client: CursorApiClient = {
    radioClientKind: "test",
    async getMe() {
      return { apiKeyName: "mock", createdAt: nowIso() };
    },
    async createAgent(req: V1CreateAgentRequest) {
      createCount += 1;
      runStatus = "FINISHED";
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
        status: runStatus === "FINISHED" ? "IDLE" : "ACTIVE",
        latestRunId: runId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        url: `https://cursor.com/agents/${id}`,
      };
    },
    async getRun(id: string, rid: string) {
      runStatus = "FINISHED";
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

describe("authoritative source-pin precedence", () => {
  it("short project/display SHA cannot downgrade full objective expectedStartingSha", () => {
    expect(
      resolveAuthoritativeExpectedBaseTipSha({
        expectedStartingSha: LEVEL3_FULL,
        transactionBranchTipSha: LEVEL3_SHORT,
        fallbackFullSha: "aa512d6ef721f855be33ddc36da490f9de66dc23",
      }),
    ).toBe(LEVEL3_FULL);
  });

  it("latest live shape: abbreviated PROJECT-STATE mainSha + full Sol pin → full work-order tip", () => {
    const baseline = acceptedBaselineState();
    expect(baseline.canonicalState.mainSha).toBe(LEVEL3_SHORT);

    // Mirror objective-start: branchTipSha copied from abbreviated mainSha.
    const afterStart: ProjectState = {
      ...baseline,
      activeWorkstream: {
        id: "bellhop-stage3-foundation-01",
        name: "Stage 3",
        status: "PLANNING",
        terminalVerdict: null,
        priority: "HIGH",
        scopeGuard: "stage3",
      },
      currentTransaction: {
        id: "bellhop-stage3-foundation-tx-01",
        type: "IMPLEMENTATION",
        status: "PLANNING",
        branch: "level3",
        branchTipSha: baseline.canonicalState.mainSha,
        sourceBaseBranch: "level3",
        sourceBaseTipSha: baseline.canonicalState.mainSha,
        finalExecutableSha: null,
        evidenceTipSha: null,
        remediationBudget: 0,
        remediationsUsed: 0,
        remediationBudgetExhausted: true,
        recoverySequence: 0,
        pr: { state: "NOT_OPENED", number: null, url: null },
        review: {
          solFinal: { agentId: null, verdict: null },
          opusFinal: { agentId: null, verdict: null },
        },
      },
    };
    expect(afterStart.currentTransaction?.branchTipSha).toBe(LEVEL3_SHORT);

    const decision = stage3LaunchDecision({
      expectedStartingSha: LEVEL3_FULL,
      baseBranch: "level3",
      requestedWork: "authorized Stage 3 work",
      verificationCriteria: "valid Stage 3 criteria",
    });
    const { workOrder } = buildStage3WorkOrder({
      state: afterStart,
      decision,
    });

    expect(workOrder.source.baseBranch).toBe("level3");
    expect(workOrder.source.workingBranch).toBe("level3");
    expect(workOrder.source.expectedBaseTipSha).toBe(LEVEL3_FULL);
    expect(workOrder.source.expectedBaseTipSha).not.toBe(LEVEL3_SHORT);
    expect(workOrder.source.canonicalMainSha).toBe(LEVEL3_SHORT);
    expect(isFullGitCommitSha(workOrder.source.expectedBaseTipSha!)).toBe(true);
  });

  it("objective-start copies short mainSha into branchTipSha but work order still keeps full Sol pin", () => {
    const dir = tmpDir();
    const statePath = path.join(dir, "PROJECT-STATE.json");
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    fs.copyFileSync(
      resolveRepoPath("fixtures", "state", "bellhop-accepted-baseline-seed.json"),
      statePath,
    );
    ensureLedgerFile(ledgerPath);
    const authorityPath = resolveRepoPath(
      "fixtures",
      "phase3",
      "stage3-objective-authority.json",
    );
    const loaded = loadProjectState({ projectId: "bellhop", statePath });
    const authority = loadObjectiveAuthority(authorityPath);
    const prepared = prepareAcceptedBaselineForObjectiveStart({
      state: loaded.state,
      authority,
      statePath,
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.state.canonicalState.mainSha).toBe(LEVEL3_SHORT);
    expect(prepared.state.currentTransaction?.branchTipSha).toBe(LEVEL3_SHORT);

    const decision = stage3LaunchDecision();
    const { workOrder } = buildStage3WorkOrder({
      state: prepared.state,
      decision,
    });
    expect(workOrder.source.expectedBaseTipSha).toBe(LEVEL3_FULL);
  });
});

describe("exact full-SHA comparison (no prefix equality)", () => {
  it("matching abbreviated prefix of two different full SHAs fails", async () => {
    expect(LEVEL3_PREFIX_FAKE.startsWith(LEVEL3_SHORT)).toBe(true);
    expect(LEVEL3_PREFIX_OTHER.startsWith(LEVEL3_SHORT)).toBe(true);
    expect(commitShasMatch(LEVEL3_PREFIX_FAKE, LEVEL3_PREFIX_OTHER)).toBe(
      false,
    );

    const intent = deriveSourceLaunchIntent({
      repository: "https://github.com/timcgha/Bellhop",
      expectedBaseTipSha: LEVEL3_PREFIX_FAKE,
      workingBranch: "level3",
      baseBranch: "level3",
    });
    await expect(
      verifyRemoteSourceRef({
        intent,
        resolveRemoteBranchTip: async () => LEVEL3_PREFIX_OTHER,
      }),
    ).rejects.toBeInstanceOf(SourceRefPrecheckError);
  });

  it("short expected vs full remote does not match", () => {
    expect(commitShasMatch(LEVEL3_SHORT, LEVEL3_FULL)).toBe(false);
    expect(isFullGitCommitSha(LEVEL3_SHORT)).toBe(false);
    expect(isFullGitCommitSha(LEVEL3_FULL)).toBe(true);
  });

  it("requireLiveFullCommitSha fail-closes on abbreviated identity", () => {
    expect(() => requireLiveFullCommitSha(LEVEL3_FULL)).not.toThrow();
    expect(() => requireLiveFullCommitSha(LEVEL3_SHORT)).toThrow(
      /SOURCE_IDENTITY_NOT_FULL_SHA|full 40-character/,
    );
  });
});

describe("mocked live source-ref precheck (latest live shape)", () => {
  async function transmitLive(input: {
    expectedBaseTipSha: string;
    remoteSha: string;
  }) {
    const dir = tmpDir();
    const statePath = path.join(dir, "PROJECT-STATE.json");
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    const runDir = path.join(dir, "run");
    fs.copyFileSync(
      resolveRepoPath("fixtures", "state", "bellhop-accepted-baseline-seed.json"),
      statePath,
    );
    ensureLedgerFile(ledgerPath);
    fs.mkdirSync(runDir, { recursive: true });

    const authorityPath = resolveRepoPath(
      "fixtures",
      "phase3",
      "stage3-objective-authority.json",
    );
    const loaded = loadProjectState({ projectId: "bellhop", statePath });
    const authority = loadObjectiveAuthority(authorityPath);
    const prepared = prepareAcceptedBaselineForObjectiveStart({
      state: loaded.state,
      authority,
      statePath,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("objective start failed");

    const decision = stage3LaunchDecision({
      expectedStartingSha:
        input.expectedBaseTipSha === LEVEL3_SHORT
          ? LEVEL3_FULL
          : input.expectedBaseTipSha,
    });
    // When testing short-only, force the work-order tip after build to simulate
    // a live path that somehow lost the trusted full pin upstream.
    let { workOrder } = buildStage3WorkOrder({
      state: prepared.state,
      decision,
    });
    if (input.expectedBaseTipSha === LEVEL3_SHORT) {
      workOrder = {
        ...workOrder,
        source: {
          ...workOrder.source,
          expectedBaseTipSha: LEVEL3_SHORT,
        },
      };
    } else {
      expect(workOrder.source.expectedBaseTipSha).toBe(input.expectedBaseTipSha);
    }

    const { client, getCreateCount } = createRecordingClient();
    const result = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state: prepared.state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "full-source-identity live mock",
      forceFixtureTransmit: false,
      explicitTransmitMode: true,
      externalCursorAllowed: true,
      env: liveEnv(),
      client,
      plannedAgentIdOverride: "bc-00000000-0000-0000-0000-0000000000aa",
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
      resolveRemoteBranchTip: async () => input.remoteSha,
    });
    return { result, getCreateCount, workOrder, runDir };
  }

  it("matching full remote SHA → source precheck PASS → mock POST /v1/agents once", async () => {
    const { result, getCreateCount, workOrder } = await transmitLive({
      expectedBaseTipSha: LEVEL3_FULL,
      remoteSha: LEVEL3_FULL,
    });
    expect(workOrder.source.expectedBaseTipSha).toBe(LEVEL3_FULL);
    expect(workOrder.source.baseBranch).toBe("level3");
    expect(result.summaryNotes.join("\n")).toMatch(/Source ref precheck OK/);
    expect(result.summaryNotes.join("\n")).not.toMatch(
      /SOURCE_REF_PRECHECK_FAILED/,
    );
    expect(getCreateCount()).toBe(1);
    expect(result.terminalVerdict).toBe("RADIO_PHASE1_RAW_RESULT_READY");
  });

  it("different full remote SHA → FAIL, create=0", async () => {
    const { result, getCreateCount, runDir } = await transmitLive({
      expectedBaseTipSha: LEVEL3_FULL,
      remoteSha: WRONG_FULL,
    });
    expect(getCreateCount()).toBe(0);
    expect(result.terminalVerdict).toBe("RADIO_PHASE1_BLOCKED");
    expect(result.summaryNotes.join("\n")).toMatch(/SOURCE_REF_PRECHECK_FAILED/);
    expect(
      fs.existsSync(path.join(runDir, "cursor-source-ref-precheck-failure.json")),
    ).toBe(true);
  });

  it("same short prefix, different full SHAs → FAIL, create=0", async () => {
    const { result, getCreateCount } = await transmitLive({
      expectedBaseTipSha: LEVEL3_PREFIX_FAKE,
      remoteSha: LEVEL3_PREFIX_OTHER,
    });
    expect(getCreateCount()).toBe(0);
    expect(result.terminalVerdict).toBe("RADIO_PHASE1_BLOCKED");
    expect(result.summaryNotes.join("\n")).toMatch(/SOURCE_REF_PRECHECK_FAILED/);
  });

  it("short-only live identity fails closed before POST /v1/agents", async () => {
    const { result, getCreateCount } = await transmitLive({
      expectedBaseTipSha: LEVEL3_SHORT,
      remoteSha: LEVEL3_FULL,
    });
    expect(getCreateCount()).toBe(0);
    expect(result.terminalVerdict).toBe("RADIO_PHASE1_BLOCKED");
    expect(result.summaryNotes.join("\n")).toMatch(
      /SOURCE_IDENTITY_NOT_FULL_SHA|full 40-character/,
    );
  });
});

describe("project-state migration not required", () => {
  it("canonical PROJECT-STATE may retain abbreviated mainSha", () => {
    const state = readJsonFile<{
      canonicalState: { mainSha: string };
      stateRevision: number;
    }>(resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"));
    expect(state.canonicalState.mainSha).toBe(LEVEL3_SHORT);
    expect(state.stateRevision).toBe(11);
  });
});
