import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canLiveCursorDispatch,
  createHttpCursorApiClient,
  CursorApiError,
  isCursorExecutionEnabled,
  resolveCursorApiKey,
  sanitizeCursorErrorText,
  type CursorApiClient,
  type V1CreateAgentRequest,
  type V1CreateAgentResponse,
  type V1Run,
} from "../src/cursor/api-client.js";
import {
  buildCreateAgentRequest,
  classifyRunStatus,
  createOrReconcileAgent,
  generatePlannedAgentId,
  isPlannedAgentId,
  pollRunUntilTerminal,
} from "../src/cursor/adapter.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { isLegalTransition } from "../src/policy/transitions.js";
import {
  resolvePhase0Config,
  runBellhopPilot,
} from "../src/runtime/pilot-bellhop.js";
import {
  ensureLedgerFile,
  FIXTURE_AGENT_ID,
  FIXTURE_RAW_CURSOR_RESULT,
  FIXTURE_RUN_ID,
  transmitCursorWorkOrder,
} from "../src/runtime/transmitter.js";
import {
  findLedgerEventByIdempotency,
  readLedgerEvents,
} from "../src/state/ledger.js";
import { loadProjectState, loadBellhopBrain } from "../src/state/store.js";
import type { DecisionEnvelope, CursorWorkOrder } from "../src/types.js";
import {
  newId,
  nowIso,
  readJsonFile,
  resolveRepoPath,
} from "../src/util/io.js";
import { callSol } from "../src/orchestrator/sol-adapter.js";
import { buildSolContext } from "../src/orchestrator/context-builder.js";

function tempWorkspace(): {
  dir: string;
  statePath: string;
  ledgerPath: string;
  runDir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radio-phase1-"));
  const statePath = path.join(dir, "PROJECT-STATE.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  const runDir = path.join(dir, "run");
  fs.copyFileSync(
    resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"),
    statePath,
  );
  fs.mkdirSync(runDir, { recursive: true });
  ensureLedgerFile(ledgerPath);
  return { dir, statePath, ledgerPath, runDir };
}

async function buildAllowWorkOrder(statePath: string): Promise<{
  workOrder: CursorWorkOrder;
  state: ReturnType<typeof loadProjectState>["state"];
  fingerprint: string;
}> {
  const loaded = loadProjectState({ projectId: "bellhop", statePath });
  const brain = loadBellhopBrain();
  const context = buildSolContext({
    brain: { ...brain, state: loaded.state, fingerprint: loaded.fingerprint },
    projectId: "bellhop",
    workstreamId: "radio-pilot-01",
    transactionId: "bellhop-radio-pilot-01-stage2-verification",
  });
  const sol = await callSol({
    context,
    projectId: "bellhop",
    workstreamId: "radio-pilot-01",
    transactionId: "bellhop-radio-pilot-01-stage2-verification",
    currentRuntimeState: loaded.state.radioRuntime.state,
    model: "gpt-5.6-sol",
    mode: "fixture",
    fixturePath: resolveRepoPath(
      "fixtures",
      "decisions",
      "bellhop-legal-launch-cursor.json",
    ),
  });
  const envelope: DecisionEnvelope = {
    schemaVersion: "phase0-1.0",
    decisionId: sol.decision.decisionId,
    projectId: "bellhop",
    workstreamId: "radio-pilot-01",
    transactionId: "bellhop-radio-pilot-01-stage2-verification",
    stateRevision: loaded.state.stateRevision,
    requestFingerprint: loaded.fingerprint,
    model: sol.model,
    mode: "fixture",
    generatedAt: nowIso(),
    cursorExecutionEnabled: false,
    notes: [],
  };
  const policy = evaluatePolicy({
    decision: sol.decision,
    state: loaded.state,
    envelope,
    currentFingerprint: loaded.fingerprint,
  });
  expect(policy.result).toBe("ALLOW");
  const workOrder = buildCursorWorkOrder({
    state: loaded.state,
    decision: sol.decision,
    policy,
  });
  return {
    workOrder,
    state: loaded.state,
    fingerprint: loaded.fingerprint,
  };
}

function createRecordingV1Client(options?: {
  plannedId?: string;
  failUsage?: boolean;
  createImpl?: (
    req: V1CreateAgentRequest,
    ctx: { createCount: number },
  ) => Promise<V1CreateAgentResponse>;
}): {
  client: CursorApiClient;
  calls: Array<{ method: string; path?: string; body?: unknown }>;
  getCreateCount: () => number;
} {
  const plannedId = options?.plannedId ?? FIXTURE_AGENT_ID;
  const runId = FIXTURE_RUN_ID;
  const calls: Array<{ method: string; path?: string; body?: unknown }> = [];
  let createCount = 0;
  let runStatus = "CREATING";
  let storedAgent: V1CreateAgentResponse | null = null;

  const client: CursorApiClient = {
    async createAgent(request) {
      calls.push({ method: "POST", path: "/v1/agents", body: request });
      createCount += 1;
      if (options?.createImpl) {
        const result = await options.createImpl(request, { createCount });
        storedAgent = result;
        return result;
      }
      if (createCount > 1 && storedAgent) {
        throw new CursorApiError(
          "Cursor API POST /v1/agents failed with 409",
          409,
          JSON.stringify({ error: "agent_id_conflict" }),
          "agent_id_conflict",
        );
      }
      runStatus = "RUNNING";
      storedAgent = {
        agent: {
          id: request.agentId ?? plannedId,
          name: "Test Agent",
          status: "ACTIVE",
          repos: request.repos,
          autoCreatePR: request.autoCreatePR ?? false,
          latestRunId: runId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        run: {
          id: runId,
          agentId: request.agentId ?? plannedId,
          status: "RUNNING",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      };
      return storedAgent;
    },
    async getAgent(agentId) {
      calls.push({ method: "GET", path: `/v1/agents/${agentId}` });
      return {
        id: agentId,
        name: "Test Agent",
        status: runStatus === "FINISHED" ? "IDLE" : "ACTIVE",
        latestRunId: runId,
        autoCreatePR: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    },
    async getRun(agentId, rid) {
      calls.push({
        method: "GET",
        path: `/v1/agents/${agentId}/runs/${rid}`,
      });
      if (runStatus === "CREATING" || runStatus === "RUNNING") {
        runStatus = "FINISHED";
      }
      return {
        id: rid,
        agentId,
        status: runStatus,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        durationMs: 99,
        result: FIXTURE_RAW_CURSOR_RESULT,
        git: {
          branches: [
            {
              repoUrl: "github.com/timcgha/Bellhop",
              branch: "cursor/level4-stage2-asteroid-garden-9dce",
            },
          ],
        },
      };
    },
    async getAgentUsage(agentId, rid) {
      calls.push({
        method: "GET",
        path: `/v1/agents/${agentId}/usage`,
        body: { runId: rid },
      });
      if (options?.failUsage) {
        throw new CursorApiError(
          "Cursor API GET usage failed with 404",
          404,
          JSON.stringify({ error: "run_not_found" }),
          "run_not_found",
        );
      }
      return {
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheWriteTokens: 1,
          cacheReadTokens: 2,
          totalTokens: 18,
        },
        runs: [
          {
            id: rid ?? runId,
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cacheWriteTokens: 1,
              cacheReadTokens: 2,
              totalTokens: 18,
            },
          },
        ],
      };
    },
    async getMe() {
      calls.push({ method: "GET", path: "/v1/me" });
      return { apiKeyName: "test", createdAt: nowIso() };
    },
  };

  return {
    client,
    calls,
    getCreateCount: () => createCount,
  };
}

describe("cursor execution gate", () => {
  it("requires both CURSOR_EXECUTION_ENABLED=true and CURSOR_API_KEY", () => {
    expect(
      canLiveCursorDispatch({
        CURSOR_EXECUTION_ENABLED: "true",
        CURSOR_API_KEY: "test-key",
      }),
    ).toBe(true);
    expect(
      canLiveCursorDispatch({
        CURSOR_EXECUTION_ENABLED: "false",
        CURSOR_API_KEY: "test-key",
      }),
    ).toBe(false);
    expect(
      canLiveCursorDispatch({
        CURSOR_EXECUTION_ENABLED: "true",
      }),
    ).toBe(false);
    expect(isCursorExecutionEnabled({ CURSOR_EXECUTION_ENABLED: "true" })).toBe(
      true,
    );
    expect(resolveCursorApiKey({ CURSOR_API_KEY: "  abc  " })).toBe("abc");
    expect(resolveCursorApiKey({})).toBeNull();
  });

  it("sanitizes auth material from error text", () => {
    expect(
      sanitizeCursorErrorText("Authorization: Bearer secret-token-here"),
    ).toContain("[REDACTED]");
    expect(
      sanitizeCursorErrorText("CURSOR_API_KEY=supersecret"),
    ).toContain("[REDACTED]");
  });
});

describe("v1 adapter contract", () => {
  it("generates bc-<uuid> planned agent ids", () => {
    const id = generatePlannedAgentId();
    expect(isPlannedAgentId(id)).toBe(true);
    expect(id.startsWith("bc-")).toBe(true);
  });

  it("builds POST /v1/agents body with required Phase 1 fields and omits model", async () => {
    const { dir, statePath } = tempWorkspace();
    const { workOrder } = await buildAllowWorkOrder(statePath);
    const planned = generatePlannedAgentId();
    const prompt = "authoritative Radio-rendered Cursor prompt";
    const req = buildCreateAgentRequest({
      workOrder,
      prompt,
      plannedAgentId: planned,
    });
    expect(req.prompt.text).toBe(prompt);
    expect(req.repos?.[0]?.url).toBe(workOrder.source.repository);
    expect(req.repos?.[0]?.startingRef).toBe(
      workOrder.source.workingBranch ?? workOrder.source.baseBranch,
    );
    expect(req.autoCreatePR).toBe(false);
    expect(req.mode).toBe("agent");
    expect(req.agentId).toBe(planned);
    expect(req.model).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(req, "model")).toBe(false);
    void dir;
  });

  it("classifies documented v1 run statuses", () => {
    expect(classifyRunStatus("CREATING")).toBe("RUNNING");
    expect(classifyRunStatus("RUNNING")).toBe("RUNNING");
    expect(classifyRunStatus("FINISHED")).toBe("FINISHED");
    expect(classifyRunStatus("ERROR")).toBe("FAILED");
    expect(classifyRunStatus("CANCELLED")).toBe("FAILED");
    expect(classifyRunStatus("EXPIRED")).toBe("FAILED");
  });

  it("http client targets v1 paths only", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          agent: { id: "bc-1", status: "ACTIVE", latestRunId: "run-1" },
          run: { id: "run-1", agentId: "bc-1", status: "CREATING" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = createHttpCursorApiClient({
      apiKey: "test-key",
      baseUrl: "https://api.cursor.com",
      fetchImpl,
    });
    await client.createAgent({
      prompt: { text: "x" },
      repos: [{ url: "https://github.com/timcgha/Bellhop", startingRef: "main" }],
      autoCreatePR: false,
      agentId: "bc-00000000-0000-0000-0000-000000000099",
    });
    expect(seen[0]).toBe("https://api.cursor.com/v1/agents");
    expect(seen.some((u) => u.includes("/v0/"))).toBe(false);
  });
});

describe("v1 create + idempotency", () => {
  it("POSTs create with client-supplied agentId and captures agent+run ids", async () => {
    const { statePath, ledgerPath, runDir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    const planned = FIXTURE_AGENT_ID;
    const { client, calls, getCreateCount } = createRecordingV1Client({
      plannedId: planned,
    });

    const result = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "phase1 prompt text",
      forceFixtureTransmit: true,
      client,
      plannedAgentIdOverride: planned,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });

    expect(getCreateCount()).toBe(1);
    const createCall = calls.find((c) => c.method === "POST");
    expect(createCall?.path).toBe("/v1/agents");
    const body = createCall?.body as V1CreateAgentRequest;
    expect(body.prompt.text).toBe("phase1 prompt text");
    expect(body.repos?.[0]?.url).toContain("Bellhop");
    expect(body.autoCreatePR).toBe(false);
    expect(body.model).toBeUndefined();
    expect(body.agentId).toBe(planned);
    expect(result.agentId).toBe(planned);
    expect(result.runId).toBe(FIXTURE_RUN_ID);
    expect(result.createRequest?.agentId).toBe(planned);

    const created = findLedgerEventByIdempotency(
      ledgerPath,
      workOrder.idempotencyKey,
      ["CURSOR_AGENT_CREATED"],
    );
    expect(created?.payload.runId).toBe(FIXTURE_RUN_ID);
  });

  it("409 agent_id_conflict reconciles via GET same planned agent; no new id", async () => {
    const planned = FIXTURE_AGENT_ID;
    let createAttempts = 0;
    const { client, calls } = createRecordingV1Client({
      plannedId: planned,
      createImpl: async (req) => {
        createAttempts += 1;
        if (createAttempts === 1) {
          throw new CursorApiError(
            "conflict",
            409,
            JSON.stringify({ error: "agent_id_conflict" }),
            "agent_id_conflict",
          );
        }
        throw new Error("should not create twice");
      },
    });

    const reconciled = await createOrReconcileAgent({
      client,
      workOrder: {
        agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
        source: {
          repository: "https://github.com/timcgha/Bellhop",
          workingBranch: "cursor/level4-stage2-asteroid-garden-9dce",
          baseBranch: "main",
        },
      } as CursorWorkOrder,
      prompt: "p",
      plannedAgentId: planned,
    });

    expect(reconciled.reconciledViaConflict).toBe(true);
    expect(reconciled.agent.id).toBe(planned);
    expect(reconciled.run.id).toBe(FIXTURE_RUN_ID);
    expect(calls.some((c) => c.path === `/v1/agents/${planned}`)).toBe(true);
  });

  it("ambiguous timeout reconciles same planned agent id", async () => {
    const planned = generatePlannedAgentId();
    const { client } = createRecordingV1Client({
      plannedId: planned,
      createImpl: async () => {
        throw new Error("fetch failed: network timeout");
      },
    });
    // Seed getAgent/getRun by using planned id as stored — recording client returns latestRunId.
    const result = await createOrReconcileAgent({
      client,
      workOrder: {
        agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
        source: {
          repository: "https://github.com/timcgha/Bellhop",
          workingBranch: "cursor/x",
          baseBranch: "main",
        },
      } as CursorWorkOrder,
      prompt: "p",
      plannedAgentId: planned,
    });
    expect(result.reconciledViaAmbiguous).toBe(true);
    expect(result.agent.id).toBe(planned);
  });

  it("same work order cannot produce two logical agents", async () => {
    const { statePath, ledgerPath, runDir, dir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    const { client, getCreateCount } = createRecordingV1Client();

    const first = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "p1",
      forceFixtureTransmit: true,
      client,
      plannedAgentIdOverride: FIXTURE_AGENT_ID,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });
    expect(first.agentId).toBe(FIXTURE_AGENT_ID);

    const planningClone = readJsonFile<typeof state>(
      resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"),
    );
    const clonePath = path.join(dir, "clone-state.json");
    fs.writeFileSync(clonePath, JSON.stringify(planningClone, null, 2));
    const createsBefore = getCreateCount();

    const second = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir: path.join(dir, "run2"),
      state: planningClone,
      statePath: clonePath,
      ledgerPath,
      workOrder,
      prompt: "p2",
      forceFixtureTransmit: true,
      client,
      plannedAgentIdOverride: FIXTURE_AGENT_ID,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });

    expect(getCreateCount()).toBe(createsBefore);
    expect(second.agentId).toBe(first.agentId);
    expect(second.summaryNotes.join(" ")).toMatch(/Idempotency reconcile/i);
    const createdEvents = readLedgerEvents(ledgerPath).filter(
      (e) => e.eventType === "CURSOR_AGENT_CREATED",
    );
    expect(createdEvents).toHaveLength(1);
  });
});

describe("v1 run polling + raw result", () => {
  it("polls exact agentId+runId and stores result byte-for-byte", async () => {
    const { statePath, ledgerPath, runDir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    const { client, calls } = createRecordingV1Client();

    const result = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "poll prompt",
      forceFixtureTransmit: true,
      client,
      plannedAgentIdOverride: FIXTURE_AGENT_ID,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });

    expect(
      calls.some(
        (c) =>
          c.method === "GET" &&
          c.path === `/v1/agents/${FIXTURE_AGENT_ID}/runs/${FIXTURE_RUN_ID}`,
      ),
    ).toBe(true);
    expect(result.rawResultText).toBe(FIXTURE_RAW_CURSOR_RESULT);
    const onDisk = fs.readFileSync(
      path.join(runDir, "cursor-result.txt"),
      "utf8",
    );
    expect(onDisk).toBe(FIXTURE_RAW_CURSOR_RESULT);
    expect(Buffer.from(onDisk, "utf8").equals(Buffer.from(FIXTURE_RAW_CURSOR_RESULT, "utf8"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(runDir, "cursor-run-final.json"))).toBe(true);
  });

  it("captures usage via GET /v1/agents/{id}/usage and tolerates missing usage", async () => {
    const { statePath, ledgerPath, runDir, dir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    const ok = createRecordingV1Client();
    const first = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "u",
      forceFixtureTransmit: true,
      client: ok.client,
      plannedAgentIdOverride: FIXTURE_AGENT_ID,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });
    expect(first.usageCaptureStatus).toBe("captured");
    expect(first.usage?.totalUsage.totalTokens).toBe(18);

    const ws2 = tempWorkspace();
    const built2 = await buildAllowWorkOrder(ws2.statePath);
    const failing = createRecordingV1Client({ failUsage: true });
    const second = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir: ws2.runDir,
      state: built2.state,
      statePath: ws2.statePath,
      ledgerPath: ws2.ledgerPath,
      workOrder: built2.workOrder,
      prompt: "u2",
      forceFixtureTransmit: true,
      client: failing.client,
      plannedAgentIdOverride: FIXTURE_AGENT_ID,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });
    expect(second.terminalVerdict).toBe("RADIO_PHASE1_RAW_RESULT_READY");
    expect(second.usageCaptureStatus).toBe("error");
    void dir;
  });

  it("terminal failure fails closed without replacement worker", async () => {
    const planned = FIXTURE_AGENT_ID;
    let createCount = 0;
    const client: CursorApiClient = {
      async createAgent(req) {
        createCount += 1;
        return {
          agent: {
            id: req.agentId ?? planned,
            status: "ACTIVE",
            latestRunId: FIXTURE_RUN_ID,
          },
          run: {
            id: FIXTURE_RUN_ID,
            agentId: req.agentId ?? planned,
            status: "RUNNING",
          },
        };
      },
      async getAgent(id) {
        return { id, status: "IDLE", latestRunId: FIXTURE_RUN_ID };
      },
      async getRun(agentId, runId) {
        return {
          id: runId,
          agentId,
          status: "ERROR",
          result: "boom",
        };
      },
      async getAgentUsage() {
        throw new Error("unused");
      },
      async getMe() {
        return {};
      },
    };

    const { statePath, ledgerPath, runDir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    const result = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "fail",
      forceFixtureTransmit: true,
      client,
      plannedAgentIdOverride: planned,
      pollIntervalMs: 1,
      pollMaxAttempts: 3,
      sleep: async () => undefined,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE1_BLOCKED");
    expect(createCount).toBe(1);
  });
});

describe("phase 1 boundary — no semantic ingestion", () => {
  it("raw result containing BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST does not make READY_FOR_HUMAN", async () => {
    const { statePath, ledgerPath, runDir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    const { client } = createRecordingV1Client();

    const result = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "boundary",
      forceFixtureTransmit: true,
      client,
      plannedAgentIdOverride: FIXTURE_AGENT_ID,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });

    expect(result.rawResultText).toContain(
      "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST",
    );
    expect(result.terminalVerdict).toBe("RADIO_PHASE1_RAW_RESULT_READY");
    expect(result.state.radioRuntime.state).toBe("VERIFYING");
    expect(result.state.pendingHumanDecision).toBeNull();
    expect(result.state.activeAgent?.status).toBe("COMPLETED");
    expect(isLegalTransition("VERIFYING", "READY_FOR_HUMAN")).toBe(false);

    const events = readLedgerEvents(ledgerPath).map((e) => e.eventType);
    expect(events).toContain("CURSOR_REPORT_RECEIVED");
    expect(events).not.toContain("CURSOR_REPORT_VALIDATED");
    expect(events).not.toContain("SOL_DECISION_REQUESTED");

    // Phase 2 parser files must not exist.
    expect(
      fs.existsSync(resolveRepoPath("src", "cursor", "completion-parser.ts")),
    ).toBe(false);
    expect(
      fs.existsSync(
        resolveRepoPath("src", "cursor", "completion-validator.ts"),
      ),
    ).toBe(false);
  });

  it("state path PLANNING → IMPLEMENTING → WAITING_FOR_AGENT → VERIFYING and STOP", async () => {
    const { statePath, ledgerPath, runDir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    expect(state.radioRuntime.state).toBe("PLANNING");
    const startRevision = state.stateRevision;
    const { client } = createRecordingV1Client();

    const result = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "states",
      forceFixtureTransmit: true,
      client,
      plannedAgentIdOverride: FIXTURE_AGENT_ID,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });

    expect(result.state.radioRuntime.state).toBe("VERIFYING");
    expect(result.state.stateRevision).toBeGreaterThan(startRevision);
    expect(result.terminalVerdict).toBe("RADIO_PHASE1_RAW_RESULT_READY");

    // Checked-in Bellhop state untouched.
    const checkedIn = readJsonFile<{ stateRevision: number }>(
      resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"),
    );
    expect(checkedIn.stateRevision).toBe(1);
  });
});

describe("crash recovery", () => {
  it("A: dispatch intent persisted → crash before POST → restart uses same planned agent id", async () => {
    const { statePath, ledgerPath, runDir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    const planned = generatePlannedAgentId();

    // Simulate CREATE_REQUESTED persisted, then crash before POST.
    const { appendLedgerEvent } = await import("../src/state/ledger.js");
    appendLedgerEvent({
      ledgerPath,
      eventType: "CURSOR_AGENT_CREATE_REQUESTED",
      projectId: workOrder.projectId,
      workstreamId: workOrder.workstreamId,
      transactionId: workOrder.transactionId,
      workOrderId: workOrder.workOrderId,
      decisionId: workOrder.decisionId,
      agentId: planned,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: null,
      idempotencyKey: workOrder.idempotencyKey,
      summary: "pre-crash intent",
      payload: { plannedAgentId: planned, apiVersion: "v1" },
    });

    const { client, calls } = createRecordingV1Client({ plannedId: planned });
    const result = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "recover-a",
      forceFixtureTransmit: true,
      client,
      // No override — must recover from ledger.
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });

    const createBody = calls.find((c) => c.method === "POST")
      ?.body as V1CreateAgentRequest;
    expect(createBody.agentId).toBe(planned);
    expect(result.agentId).toBe(planned);
    expect(result.summaryNotes.join(" ")).toMatch(/reusing planned agent ID/i);
  });

  it("B: POST succeeds → crash before CREATED persistence → restart reconciles same id", async () => {
    const planned = FIXTURE_AGENT_ID;
    let postSucceeded = false;
    const { client, getCreateCount } = createRecordingV1Client({
      plannedId: planned,
      createImpl: async (req) => {
        if (!postSucceeded) {
          postSucceeded = true;
          // First "POST succeeded remotely" but we simulate local crash by
          // throwing before caller persists — then next attempt gets 409.
          throw new Error("simulated crash after remote success / timeout");
        }
        throw new CursorApiError(
          "conflict",
          409,
          JSON.stringify({ error: "agent_id_conflict" }),
          "agent_id_conflict",
        );
      },
    });

    // First attempt: ambiguous failure after remote create.
    const first = await createOrReconcileAgent({
      client,
      workOrder: {
        agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
        source: {
          repository: "https://github.com/timcgha/Bellhop",
          workingBranch: "cursor/x",
          baseBranch: "main",
        },
      } as CursorWorkOrder,
      prompt: "p",
      plannedAgentId: planned,
    });
    expect(first.reconciledViaAmbiguous || first.reconciledViaConflict).toBe(
      true,
    );
    expect(first.agent.id).toBe(planned);
    expect(first.run.id).toBe(FIXTURE_RUN_ID);
    expect(getCreateCount()).toBe(1);
  });

  it("C/D: active/finished run resumes exact run; finished → VERIFYING; no semantic ingestion", async () => {
    const { statePath, ledgerPath, runDir, dir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    const { client } = createRecordingV1Client();

    const first = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "c",
      forceFixtureTransmit: true,
      client,
      plannedAgentIdOverride: FIXTURE_AGENT_ID,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });
    expect(first.state.radioRuntime.state).toBe("VERIFYING");

    // Restart after FINISHED: should remain VERIFYING, no new create, no semantic events.
    const reloaded = loadProjectState({ projectId: "bellhop", statePath });
    const second = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir: path.join(dir, "run-restart"),
      state: reloaded.state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "c-restart",
      forceFixtureTransmit: true,
      client,
      plannedAgentIdOverride: FIXTURE_AGENT_ID,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });

    expect(second.terminalVerdict).toBe("RADIO_PHASE1_RAW_RESULT_READY");
    expect(second.state.radioRuntime.state).toBe("VERIFYING");
    expect(second.state.pendingHumanDecision).toBeNull();
    const validated = readLedgerEvents(ledgerPath).filter(
      (e) => e.eventType === "CURSOR_REPORT_VALIDATED",
    );
    expect(validated).toHaveLength(0);
    const created = readLedgerEvents(ledgerPath).filter(
      (e) => e.eventType === "CURSOR_AGENT_CREATED",
    );
    expect(created).toHaveLength(1);
  });
});

describe("phase1 fixture pilot CLI", () => {
  it("pilot --transmit-fixture returns RADIO_PHASE1_RAW_RESULT_READY without network", async () => {
    const { statePath, ledgerPath } = tempWorkspace();
    const config = {
      ...resolvePhase0Config(["node", "pilot", "--transmit-fixture"]),
      statePath,
      ledgerPath,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
    };
    const result = await runBellhopPilot(config);
    expect(result.cursorApiCalled).toBe(true);
    expect(result.terminalVerdict).toBe("RADIO_PHASE1_RAW_RESULT_READY");
    expect(result.state.radioRuntime.state).toBe("VERIFYING");
    expect(result.summary.liveCursorDispatchAuthorized).toBe(false);
    expect(result.state.pendingHumanDecision).toBeNull();
  });

  it("without execution enablement, gate returns LIVE_NOT_RUN / Phase0 dry-run", async () => {
    const config = resolvePhase0Config(["node", "pilot"]);
    const result = await runBellhopPilot({
      ...config,
      mode: "fixture",
      cursorExecutionEnabled: false,
      liveCursorDispatchAuthorized: false,
      phase1FixtureTransmit: false,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE0_DRY_RUN_COMPLETE");

    const { statePath, ledgerPath, runDir } = tempWorkspace();
    const { workOrder, state } = await buildAllowWorkOrder(statePath);
    const gated = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "should not launch",
      forceFixtureTransmit: false,
      env: {
        CURSOR_EXECUTION_ENABLED: "false",
        CURSOR_API_KEY: "present-but-not-enough",
      },
    });
    expect(gated.terminalVerdict).toBe("RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN");
    expect(gated.cursorApiCalled).toBe(false);
  });
});

describe("pollRunUntilTerminal unit", () => {
  it("handles intermediate RUNNING then FINISHED", async () => {
    const statuses = ["CREATING", "RUNNING", "FINISHED"];
    let i = 0;
    const client: CursorApiClient = {
      async createAgent() {
        throw new Error("unused");
      },
      async getAgent() {
        throw new Error("unused");
      },
      async getRun(agentId, runId): Promise<V1Run> {
        const status = statuses[Math.min(i, statuses.length - 1)]!;
        i += 1;
        return {
          id: runId,
          agentId,
          status,
          result: status === "FINISHED" ? "done" : undefined,
        };
      },
      async getAgentUsage() {
        throw new Error("unused");
      },
      async getMe() {
        return {};
      },
    };
    const run = await pollRunUntilTerminal({
      client,
      agentId: "bc-1",
      runId: "run-1",
      intervalMs: 1,
      maxAttempts: 5,
      sleep: async () => undefined,
    });
    expect(run.status).toBe("FINISHED");
    expect(run.result).toBe("done");
  });
});
