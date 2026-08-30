/**
 * Phase 3 live Cursor client wiring + live-safe polling defaults.
 *
 * Proves the real-mode path obtains createHttpCursorApiClient (Phase 1)
 * after deterministic gates, with mocked network only — never fixture
 * decision files and never real Cursor/OpenAI calls.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createHttpCursorApiClient,
  isHttpCursorApiClient,
  type HttpCursorApiClientOptions,
  type V1CreateAgentRequest,
} from "../src/cursor/api-client.js";
import {
  loadObjectiveAuthority,
  STAGE2_PLAYTEST_APPROVAL_ID,
} from "../src/runtime/objective-authority.js";
import {
  resolvePhase3TransmitPollOptions,
  runPhase3Loop,
} from "../src/runtime/phase3.js";
import {
  CURSOR_FIXTURE_POLL_INTERVAL_MS,
  CURSOR_FIXTURE_POLL_MAX_ATTEMPTS,
  CURSOR_LIVE_POLL_INTERVAL_MS,
  CURSOR_LIVE_POLL_MAX_ATTEMPTS,
  resolveCursorPollDefaults,
} from "../src/runtime/transmitter.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  ObjectiveAuthority,
  OrchestratorDecision,
  RuntimeState,
  SolPhase2Assessment,
  WorkType,
} from "../src/types.js";
import { newId, nowIso, readJsonFile, resolveRepoPath } from "../src/util/io.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-phase3-live-wiring-"));
}

function stage3AuthorityPath(): string {
  return resolveRepoPath("fixtures", "phase3", "stage3-objective-authority.json");
}

function liveEntryAuthorityPath(): string {
  return resolveRepoPath(
    "fixtures",
    "phase3",
    "live-entry-objective-authority.json",
  );
}

function acceptedBaselineSeedPath(): string {
  return resolveRepoPath(
    "fixtures",
    "state",
    "bellhop-accepted-baseline-seed.json",
  );
}

function livePlanningSeedPath(): string {
  return resolveRepoPath("fixtures", "state", "phase3-live-planning-seed.json");
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

function seedAcceptedBaseline(dir: string) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(acceptedBaselineSeedPath(), statePath);
  fs.writeFileSync(ledgerPath, "", "utf8");
  const authorityDest = path.join(dir, "objective-authority.json");
  fs.copyFileSync(stage3AuthorityPath(), authorityDest);
  return { statePath, ledgerPath, authorityPath: authorityDest, runDir: dir };
}

function seedLivePlanning(dir: string) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(livePlanningSeedPath(), statePath);
  fs.writeFileSync(ledgerPath, "", "utf8");
  const authorityDest = path.join(dir, "objective-authority.json");
  fs.copyFileSync(liveEntryAuthorityPath(), authorityDest);
  return { statePath, ledgerPath, authorityPath: authorityDest, runDir: dir };
}

function tipResolverForRunDir(runDir: string) {
  return async (): Promise<string> => {
    const files = fs
      .readdirSync(runDir)
      .filter((f) => /^work-order-iter-\d+\.json$/.test(f))
      .sort();
    const latest = files[files.length - 1];
    if (!latest) {
      throw new Error("No work-order artifact for tip resolution");
    }
    const workOrder = readJsonFile<{
      source: { expectedBaseTipSha: string };
    }>(path.join(runDir, latest));
    return workOrder.source.expectedBaseTipSha;
  };
}

function liveEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CURSOR_API_KEY: "test-cursor-key-not-real",
    CURSOR_EXECUTION_ENABLED: "true",
    OPENAI_API_KEY: "test-openai-key-not-real",
    RADIO_OBJECTIVE_LEASE_BACKEND: "memory",
    RADIO_CURSOR_WORKER_MODEL: "composer-2",
    ...overrides,
  };
}

function launchCursorDecision(input: {
  authority: ObjectiveAuthority;
  from: RuntimeState;
  to: RuntimeState;
  workType?: WorkType;
}): OrchestratorDecision {
  const loaded = loadProjectState({
    projectId: input.authority.projectId,
    statePath: acceptedBaselineSeedPath(),
  });
  const branch =
    input.authority.baseBranch ??
    loaded.state.canonicalState.mainBranch ??
    "level3";
  const fullSha =
    input.authority.expectedStartingSha ||
    "847ca2d64090aaeb94ca681b651a44062ab9f644";

  return {
    schemaVersion: "1.0",
    decisionId: newId("dec"),
    generatedAt: new Date().toISOString(),
    projectId: input.authority.projectId,
    workstreamId: input.authority.workstreamId,
    transactionId: input.authority.transactionId,
    decision: "LAUNCH_CURSOR",
    reason: `Live mocked launch for ${input.authority.summary}`,
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
    policyReferences: ["Phase3-live-cursor-wiring"],
    blockers: [],
    stateTransition: {
      from: input.from,
      to: input.to,
      reason: "Mocked live Sol launch authorized by objective authority.",
    },
    cursorInstruction: {
      agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
      workType: input.workType ?? "VERIFICATION",
      objective: `Execute bounded work for objective ${input.authority.objectiveId}.`,
      baseBranch: branch,
      expectedStartingSha: fullSha,
      requestedWork:
        "AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED\nReturn the entire final completion report inside exactly one fenced text code block.\n",
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
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
  let continuationIndex = 0;
  let fixtureLoaderInvoked = false;
  const solCall = vi.fn(async (options: { mode?: string; fixturePath?: string; model?: string }) => {
    if (options.mode === "fixture" || options.fixturePath) {
      fixtureLoaderInvoked = true;
    }
    return {
      decision: input.initial,
      model: options.model ?? "gpt-5.6-sol",
      mode: "live" as const,
      requestId: "mock-initial",
      rawText: JSON.stringify(input.initial),
      schemaCompatNotes: ["mock live initial Sol"],
      usage: null,
    };
  });
  const solPhase2Call = vi.fn(async (options: { mode?: string; fixturePath?: string; model?: string }) => {
    if (options.mode === "fixture" || options.fixturePath) {
      fixtureLoaderInvoked = true;
    }
    const decision =
      input.continuations[continuationIndex] ??
      humanGateDecision(input.authority);
    continuationIndex += 1;
    const assessment = defaultAssessment("Mocked live Phase 2 continuation");
    return {
      assessment,
      decision,
      continuation: { assessment, decision },
      model: options.model ?? "gpt-5.6-sol",
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
    fixtureLoaderInvoked: () => fixtureLoaderInvoked,
    getCounts: () => ({
      initialCalls: solCall.mock.calls.length,
      continuationCalls: solPhase2Call.mock.calls.length,
    }),
  };
}

/**
 * Mocked Cursor Cloud HTTP transport via createHttpCursorApiClient fetchImpl.
 * No real network. Scripts one raw result per POST /v1/agents.
 */
function createMockCursorFetch(rawResults: string[]): {
  fetchImpl: typeof fetch;
  getCreateCount: () => number;
  getPostBodies: () => V1CreateAgentRequest[];
  getSeenUrls: () => string[];
} {
  let createCount = 0;
  const postBodies: V1CreateAgentRequest[] = [];
  const seenUrls: string[] = [];
  const agents = new Map<
    string,
    { runId: string; rawResult: string; status: string }
  >();

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seenUrls.push(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url.endsWith("/v1/me")) {
      return new Response(
        JSON.stringify({ apiKeyName: "mock-phase3", createdAt: nowIso() }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "GET" && url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "composer-2",
              displayName: "Composer 2",
              aliases: ["composer", "composer-latest"],
            },
            { id: "composer-2.5", displayName: "Composer 2.5" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "POST" && url.endsWith("/v1/agents")) {
      createCount += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as V1CreateAgentRequest;
      postBodies.push(body);
      if (createCount > rawResults.length) {
        return new Response(JSON.stringify({ error: "exhausted" }), {
          status: 500,
        });
      }
      const agentId =
        body.agentId ??
        `bc-mock-live-${String(createCount).padStart(4, "0")}`;
      const runId = `run-mock-live-${String(createCount).padStart(4, "0")}`;
      agents.set(agentId, {
        runId,
        rawResult: rawResults[createCount - 1]!,
        status: "RUNNING",
      });
      return new Response(
        JSON.stringify({
          agent: {
            id: agentId,
            name: `Mock Live Worker ${createCount}`,
            status: "ACTIVE",
            repos: body.repos,
            autoCreatePR: false,
            latestRunId: runId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            url: `https://cursor.com/agents/${agentId}`,
          },
          run: {
            id: runId,
            agentId,
            status: "CREATING",
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const agentMatch = url.match(/\/v1\/agents\/([^/?]+)$/);
    if (method === "GET" && agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]!);
      const entry = agents.get(agentId);
      return new Response(
        JSON.stringify({
          id: agentId,
          name: "Mock Live Worker",
          status: entry?.status === "FINISHED" ? "IDLE" : "ACTIVE",
          latestRunId: entry?.runId,
          autoCreatePR: false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const runMatch = url.match(/\/v1\/agents\/([^/]+)\/runs\/([^/?]+)$/);
    if (method === "GET" && runMatch) {
      const agentId = decodeURIComponent(runMatch[1]!);
      const runId = decodeURIComponent(runMatch[2]!);
      const entry = agents.get(agentId);
      if (entry && entry.status !== "FINISHED") {
        entry.status = "FINISHED";
      }
      return new Response(
        JSON.stringify({
          id: runId,
          agentId,
          status: "FINISHED",
          createdAt: nowIso(),
          updatedAt: nowIso(),
          durationMs: 42,
          result: entry?.rawResult ?? "",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const usageMatch = url.match(/\/v1\/agents\/([^/]+)\/usage/);
    if (method === "GET" && usageMatch) {
      return new Response(
        JSON.stringify({
          totalUsage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 15,
          },
          runs: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), {
      status: 500,
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    getCreateCount: () => createCount,
    getPostBodies: () => postBodies,
    getSeenUrls: () => seenUrls,
  };
}

describe("Phase 3 live Cursor client wiring", () => {
  it("live poll defaults are Phase 1 production-safe; fixture stays fast", () => {
    expect(resolveCursorPollDefaults(false)).toEqual({
      pollIntervalMs: CURSOR_LIVE_POLL_INTERVAL_MS,
      pollMaxAttempts: CURSOR_LIVE_POLL_MAX_ATTEMPTS,
    });
    expect(resolveCursorPollDefaults(true)).toEqual({
      pollIntervalMs: CURSOR_FIXTURE_POLL_INTERVAL_MS,
      pollMaxAttempts: CURSOR_FIXTURE_POLL_MAX_ATTEMPTS,
    });
    expect(CURSOR_LIVE_POLL_INTERVAL_MS).toBe(15_000);
    expect(CURSOR_LIVE_POLL_MAX_ATTEMPTS).toBe(120);
    expect(CURSOR_LIVE_POLL_INTERVAL_MS).not.toBe(1);
    expect(CURSOR_LIVE_POLL_MAX_ATTEMPTS).not.toBe(5);

    const live = resolvePhase3TransmitPollOptions({
      mode: "live",
      usingInjectedCursorClient: false,
    });
    expect(live.pollIntervalMs).toBe(CURSOR_LIVE_POLL_INTERVAL_MS);
    expect(live.pollMaxAttempts).toBe(CURSOR_LIVE_POLL_MAX_ATTEMPTS);

    const fixture = resolvePhase3TransmitPollOptions({
      mode: "fixture",
      usingInjectedCursorClient: false,
    });
    expect(fixture.pollIntervalMs).toBe(CURSOR_FIXTURE_POLL_INTERVAL_MS);
    expect(fixture.pollMaxAttempts).toBe(CURSOR_FIXTURE_POLL_MAX_ATTEMPTS);

    const injectedLive = resolvePhase3TransmitPollOptions({
      mode: "live",
      usingInjectedCursorClient: true,
    });
    expect(injectedLive.pollIntervalMs).toBe(CURSOR_FIXTURE_POLL_INTERVAL_MS);
    expect(injectedLive.pollMaxAttempts).toBe(CURSOR_FIXTURE_POLL_MAX_ATTEMPTS);
  });

  it("valid live mode constructs Phase 1 HTTP client and creates once", async () => {
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
    const transport = createMockCursorFetch([passRaw()]);
    let factoryCalls = 0;
    const createCursorHttpClient = (options: HttpCursorApiClientOptions) => {
      factoryCalls += 1;
      const client = createHttpCursorApiClient({
        ...options,
        fetchImpl: transport.fetchImpl,
      });
      expect(isHttpCursorApiClient(client)).toBe(true);
      return client;
    };

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
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      externalCursorAllowed: true,
      env: liveEnv(),
      createCursorHttpClient,
      sleep: async () => undefined,
      resolveRemoteBranchTip: tipResolverForRunDir(paths.runDir),
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(result.stopReason).not.toMatch(/No Cursor client available/i);
    expect(result.terminalVerdict).not.toBe(
      "RADIO_PHASE3_INFRASTRUCTURE_BLOCKED",
    );
    expect(factoryCalls).toBeGreaterThanOrEqual(1);
    expect(transport.getCreateCount()).toBe(1);
    expect(transport.getSeenUrls().some((u) => u.includes("/v1/me"))).toBe(
      true,
    );
    expect(
      transport.getSeenUrls().some((u) => u.endsWith("/v1/agents")),
    ).toBe(true);
    expect(result.cursorExecutionCount).toBe(1);
    const checkpoint = readJsonFile<{
      lastAgentId: string | null;
      lastRunId: string | null;
    }>(path.join(paths.runDir, "phase3-checkpoint.json"));
    expect(checkpoint.lastAgentId).toMatch(/^bc-/);
    expect(checkpoint.lastRunId).toMatch(/^run-mock-live-/);
    expect(harness.fixtureLoaderInvoked()).toBe(false);
  });

  it("missing CURSOR_API_KEY fails closed with zero creates", async () => {
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
    const transport = createMockCursorFetch([passRaw()]);
    let factoryCalls = 0;

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
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      externalCursorAllowed: true,
      env: liveEnv({ CURSOR_API_KEY: "" }),
      createCursorHttpClient: (opts) => {
        factoryCalls += 1;
        return createHttpCursorApiClient({
          ...opts,
          fetchImpl: transport.fetchImpl,
        });
      },
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(factoryCalls).toBe(0);
    expect(transport.getCreateCount()).toBe(0);
    expect(result.cursorExecutionCount).toBe(0);
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_IMPLEMENTED_LIVE_NOT_RUN");
    expect(result.stopReason).toMatch(/CURSOR_API_KEY/i);
  });

  it("CURSOR_EXECUTION_ENABLED=false fails closed with zero creates", async () => {
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
    const transport = createMockCursorFetch([passRaw()]);
    let factoryCalls = 0;

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
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      externalCursorAllowed: true,
      env: liveEnv({ CURSOR_EXECUTION_ENABLED: "false" }),
      createCursorHttpClient: (opts) => {
        factoryCalls += 1;
        return createHttpCursorApiClient({
          ...opts,
          fetchImpl: transport.fetchImpl,
        });
      },
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(factoryCalls).toBe(0);
    expect(transport.getCreateCount()).toBe(0);
    expect(result.cursorExecutionCount).toBe(0);
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_IMPLEMENTED_LIVE_NOT_RUN");
    expect(result.stopReason).toMatch(/CURSOR_EXECUTION/i);
  });

  it("mocked live two-iteration SOL→CURSOR→SOL→CURSOR→SOL→HUMAN via HTTP wiring", async () => {
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
    const transport = createMockCursorFetch([failRaw(), passRaw()]);
    let factoryCalls = 0;

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
      solCall: harness.solCall,
      solPhase2Call: harness.solPhase2Call,
      externalCursorAllowed: true,
      env: liveEnv(),
      createCursorHttpClient: (opts) => {
        factoryCalls += 1;
        return createHttpCursorApiClient({
          ...opts,
          fetchImpl: transport.fetchImpl,
        });
      },
      sleep: async () => undefined,
      resolveRemoteBranchTip: tipResolverForRunDir(paths.runDir),
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    const counts = harness.getCounts();
    expect(counts.initialCalls).toBe(1);
    expect(counts.continuationCalls).toBe(2);
    expect(factoryCalls).toBe(2);
    expect(transport.getCreateCount()).toBe(2);
    expect(result.cursorExecutionCount).toBe(2);
    expect(result.solDecisionCount).toBe(3);
    expect(result.iterations).toBe(2);
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_AUTONOMOUS_LOOP_READY");
    expect(result.runtimeState).toBe("READY_FOR_HUMAN");
    expect(result.stopReason).not.toMatch(/No Cursor client available/i);
    expect(harness.fixtureLoaderInvoked()).toBe(false);
    for (const body of transport.getPostBodies()) {
      expect(body.agentId).toMatch(/^bc-/);
      expect(body.autoCreatePR).toBe(false);
    }
    const checkpoint = readJsonFile<{
      lastAgentId: string | null;
      lastRunId: string | null;
      cursorExecutionCount: number;
    }>(path.join(paths.runDir, "phase3-checkpoint.json"));
    expect(checkpoint.cursorExecutionCount).toBe(2);
    expect(checkpoint.lastAgentId).toMatch(/^bc-/);
    expect(checkpoint.lastRunId).toMatch(/^run-mock-live-0002$/);
  });
});
