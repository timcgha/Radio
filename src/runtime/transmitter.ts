import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../artifacts/writer.js";
import {
  canLiveCursorDispatch,
  createHttpCursorApiClient,
  CursorApiError,
  isCursorExecutionEnabled,
  isHttpCursorApiClient,
  sanitizeCursorErrorText,
  type CursorApiClient,
  type V1AgentUsage,
  type V1CreateAgentRequest,
  type V1Me,
  type V1Run,
  resolveCursorApiKey,
} from "../cursor/api-client.js";
import {
  classifyRunStatus,
  createOrReconcileAgent,
  generatePlannedAgentId,
  pollRunUntilTerminal,
  reconcileExistingAgent,
} from "../cursor/adapter.js";
import {
  deriveSourceLaunchIntent,
  resolveRemoteBranchTipViaGitLsRemote,
  SourceRefPrecheckError,
  requireLiveFullCommitSha,
  verifyRemoteSourceRef,
  type ResolveRemoteBranchTip,
  type SourceRefVerification,
} from "../cursor/source-ref.js";
import { renderCursorPrompt } from "../cursor/prompt-renderer.js";
import {
  appendLedgerEvent,
  findLedgerEventByIdempotency,
  readLedgerEvents,
} from "../state/ledger.js";
import { computeStateFingerprint } from "../state/fingerprint.js";
import {
  persistProjectState,
  transitionRuntimeState,
} from "../state/mutate.js";
import type {
  CursorWorkOrder,
  ProjectState,
  RadioTerminalVerdict,
  RunLedgerEvent,
} from "../types.js";
import { newId, nowIso, sha256Hex } from "../util/io.js";
import {
  buildUsageTelemetrySnapshot,
  evaluateCursorWorkerModel,
  resolveCursorWorkerModelPolicy,
  usageDeltaTokens,
  validateModelAgainstCursorCatalog,
  type CursorUsageTelemetrySnapshot,
  type CursorWorkerModelPolicy,
} from "./cursor-worker-model.js";

export interface TransmitOptions {
  runId: string;
  runDir: string;
  state: ProjectState;
  statePath: string;
  ledgerPath: string;
  workOrder: CursorWorkOrder;
  prompt: string;
  /** Injected client for fixture/deterministic tests. */
  client?: CursorApiClient;
  /** Force transmit even when live gate is closed (fixture mock only). */
  forceFixtureTransmit?: boolean;
  /**
   * Explicit live transmitter mode (--transmit).
   * Required together with env gates for real HTTP Cursor transport.
   */
  explicitTransmitMode?: boolean;
  /**
   * Structural external-Cursor allow flag.
   * Fixture mode always forces this false (EXTERNAL_CURSOR_ALLOWED=false).
   */
  externalCursorAllowed?: boolean;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Optional override for planned agent id (tests / crash recovery). */
  plannedAgentIdOverride?: string;
  /**
   * Injected remote branch tip resolver (tests / fixture isolation).
   * Live path defaults to read-only `git ls-remote`.
   * Fixture path defaults to returning the work-order expected tip when the
   * requested branch matches the transport ref (no live network).
   */
  resolveRemoteBranchTip?: ResolveRemoteBranchTip;
  /** Optional objective id for usage telemetry binding. */
  objectiveId?: string | null;
  /** Injected worker model policy (tests). */
  workerModelPolicy?: CursorWorkerModelPolicy;
  /**
   * When true, skip GET /v1/models catalog validation (fixture/injected clients).
   */
  skipModelCatalogValidation?: boolean;
}

export interface TransmitResult {
  terminalVerdict: RadioTerminalVerdict;
  cursorApiCalled: boolean;
  agentId: string | null;
  runId: string | null;
  state: ProjectState;
  fingerprint: string;
  rawResultText: string | null;
  usage: V1AgentUsage | null;
  usageCaptureStatus: "captured" | "missing" | "skipped" | "error";
  artifactPaths: Record<string, string>;
  summaryNotes: string[];
  createRequest: V1CreateAgentRequest | null;
  workerModel: string | null;
  usageTelemetryBefore: CursorUsageTelemetrySnapshot | null;
  usageTelemetryAfter: CursorUsageTelemetrySnapshot | null;
  usageDeltaTokens: number | null;
}

const FIXTURE_AGENT_ID = "bc-00000000-0000-0000-0000-0000000000f1";
const FIXTURE_RUN_ID = "run-00000000-0000-0000-0000-0000000000f1";

/** Production-safe Cursor Cloud Agent polling (Phase 1 live defaults). */
export const CURSOR_LIVE_POLL_INTERVAL_MS = 15_000;
export const CURSOR_LIVE_POLL_MAX_ATTEMPTS = 120;
/** Deterministic fixture/mock polling (fast, bounded). */
export const CURSOR_FIXTURE_POLL_INTERVAL_MS = 1;
export const CURSOR_FIXTURE_POLL_MAX_ATTEMPTS = 5;

export function resolveCursorPollDefaults(useFixture: boolean): {
  pollIntervalMs: number;
  pollMaxAttempts: number;
} {
  return useFixture
    ? {
        pollIntervalMs: CURSOR_FIXTURE_POLL_INTERVAL_MS,
        pollMaxAttempts: CURSOR_FIXTURE_POLL_MAX_ATTEMPTS,
      }
    : {
        pollIntervalMs: CURSOR_LIVE_POLL_INTERVAL_MS,
        pollMaxAttempts: CURSOR_LIVE_POLL_MAX_ATTEMPTS,
      };
}

/** Semantic product string may appear inside raw Cursor evidence — Radio must not interpret it. */
export const FIXTURE_RAW_CURSOR_RESULT =
  "Fixture Cursor ordinary agent finished Stage 2 verification work.\n\n" +
  "Embedded worker self-report (UNTRUSTED EXTERNAL EVIDENCE — not interpreted by Radio Phase 1):\n" +
  "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST\n";

function sanitizeMeForArtifact(me: V1Me): Record<string, unknown> {
  return {
    apiKeyName: me.apiKeyName ?? null,
    createdAt: me.createdAt ?? null,
    userId: me.userId ?? null,
    // Intentionally omit email/name fields from durable artifacts.
  };
}

function createFixtureCursorClient(plannedAgentId?: string): CursorApiClient {
  const agentId = plannedAgentId ?? FIXTURE_AGENT_ID;
  const runId = FIXTURE_RUN_ID;
  let created = false;
  let runStatus = "CREATING";
  let lastCreateRequest: V1CreateAgentRequest | null = null;

  return {
    radioClientKind: "fixture",
    async createAgent(request) {
      lastCreateRequest = request;
      if (request.agentId && request.agentId !== agentId) {
        // Honor client-supplied id for idempotency tests that inject planned id.
      }
      const id = request.agentId ?? agentId;
      if (created) {
        throw new CursorApiError(
          "Cursor API POST /v1/agents failed with 409",
          409,
          JSON.stringify({ error: "agent_id_conflict" }),
          "agent_id_conflict",
        );
      }
      created = true;
      runStatus = "RUNNING";
      return {
        agent: {
          id,
          name: "Fixture Bellhop Verifier",
          status: "ACTIVE",
          repos: request.repos,
          autoCreatePR: request.autoCreatePR ?? false,
          latestRunId: runId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          url: `https://cursor.com/agents/${id}`,
        },
        run: {
          id: runId,
          agentId: id,
          status: runStatus,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      };
    },
    async getAgent(id: string) {
      return {
        id,
        name: "Fixture Bellhop Verifier",
        status: runStatus === "FINISHED" ? "IDLE" : "ACTIVE",
        latestRunId: runId,
        repos: lastCreateRequest?.repos,
        autoCreatePR: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        url: `https://cursor.com/agents/${id}`,
      };
    },
    async getRun(id: string, rid: string) {
      if (rid !== runId) {
        throw new Error(`Unknown fixture run ${rid}`);
      }
      if (runStatus === "RUNNING" || runStatus === "CREATING") {
        runStatus = "FINISHED";
      }
      return {
        id: runId,
        agentId: id,
        status: runStatus,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        durationMs: 42,
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
    async getAgentUsage(id: string, rid?: string) {
      return {
        totalUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 10,
          cacheReadTokens: 20,
          totalTokens: 180,
        },
        runs: [
          {
            id: rid ?? runId,
            usageUuid: "00000000-0000-0000-0000-0000000000f1",
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              cacheWriteTokens: 10,
              cacheReadTokens: 20,
              totalTokens: 180,
            },
          },
        ],
      };
    },
    async getMe() {
      return { apiKeyName: "fixture", createdAt: nowIso() };
    },
  };
}

function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const body =
    err instanceof CursorApiError ? ` ${err.body}` : "";
  return sanitizeCursorErrorText(`${message}${body}`.trim());
}

function findCreatedBinding(
  ledgerPath: string,
  idempotencyKey: string,
): { agentId: string; runId: string } | null {
  const event = findLedgerEventByIdempotency(ledgerPath, idempotencyKey, [
    "CURSOR_AGENT_CREATED",
  ]);
  if (!event?.agentId) return null;
  const runId =
    typeof event.payload.runId === "string" ? event.payload.runId : null;
  if (!runId) return null;
  return { agentId: event.agentId, runId };
}

function findPlannedAgentId(
  ledgerPath: string,
  idempotencyKey: string,
): string | null {
  const event = findLedgerEventByIdempotency(ledgerPath, idempotencyKey, [
    "CURSOR_AGENT_CREATE_REQUESTED",
  ]);
  if (!event) return null;
  const planned =
    typeof event.payload.plannedAgentId === "string"
      ? event.payload.plannedAgentId
      : null;
  return planned;
}

function findRawResultReceipt(
  ledgerPath: string,
  idempotencyKey: string,
): RunLedgerEvent | null {
  return findLedgerEventByIdempotency(ledgerPath, idempotencyKey, [
    "CURSOR_REPORT_RECEIVED",
  ]);
}

/**
 * Phase 1 Cursor transmitter (v1):
 * DECIDE→POLICY→WORK ORDER → TRANSMIT → WAIT → STORE RAW → VERIFYING → STOP
 *
 * Does NOT parse/validate completion reports or transition to READY_FOR_HUMAN.
 */
export async function transmitCursorWorkOrder(
  options: TransmitOptions,
): Promise<TransmitResult> {
  const env = options.env ?? process.env;
  const notes: string[] = [];
  const artifactPaths: Record<string, string> = {};
  let state = options.state;
  let fingerprint = computeStateFingerprint(state);
  let cursorApiCalled = false;
  let agentId: string | null = null;
  let runId: string | null = null;
  let createRequest: V1CreateAgentRequest | null = null;
  let rawResultText: string | null = null;
  let usage: V1AgentUsage | null = null;
  let usageCaptureStatus: TransmitResult["usageCaptureStatus"] = "skipped";
  let workerModel: string | null =
    options.workOrder.agentPlan?.workerModel?.trim() || null;
  let usageTelemetryBefore: CursorUsageTelemetrySnapshot | null = null;
  let usageTelemetryAfter: CursorUsageTelemetrySnapshot | null = null;

  const envLiveGate = canLiveCursorDispatch(env);
  const useFixture = Boolean(options.forceFixtureTransmit);
  // Fixture mode structurally forces EXTERNAL_CURSOR_ALLOWED = false.
  const externalCursorAllowed = useFixture
    ? false
    : Boolean(
        options.externalCursorAllowed ??
          (options.explicitTransmitMode && envLiveGate),
      );
  const explicitTransmitMode = Boolean(options.explicitTransmitMode);
  const modelPolicy =
    options.workerModelPolicy ??
    resolveCursorWorkerModelPolicy(env);

  const emptyResult = (
    verdict: RadioTerminalVerdict,
    extraNotes: string[] = [],
  ): TransmitResult => ({
    terminalVerdict: verdict,
    cursorApiCalled,
    agentId,
    runId,
    state,
    fingerprint,
    rawResultText,
    usage,
    usageCaptureStatus,
    artifactPaths,
    summaryNotes: [...notes, ...extraNotes],
    createRequest,
    workerModel,
    usageTelemetryBefore,
    usageTelemetryAfter,
    usageDeltaTokens: usageDeltaTokens(usageTelemetryBefore, usageTelemetryAfter),
  });

  if (!useFixture && !explicitTransmitMode) {
    notes.push(
      "Live Cursor dispatch not authorized. Explicit --transmit mode required (plus CURSOR_EXECUTION_ENABLED=true AND CURSOR_API_KEY).",
    );
    return emptyResult("RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN");
  }

  if (!useFixture && !isCursorExecutionEnabled(env)) {
    notes.push("LIVE_DISPATCH_DISABLED: CURSOR_EXECUTION_ENABLED is not true.");
    return emptyResult("RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN");
  }

  if (!useFixture && resolveCursorApiKey(env) === null) {
    notes.push("BLOCKED_NO_CURSOR_API_KEY: CURSOR_API_KEY is missing.");
    return emptyResult("RADIO_PHASE1_BLOCKED");
  }

  if (!useFixture && !envLiveGate) {
    notes.push(
      "Live Cursor dispatch not authorized. Requires CURSOR_EXECUTION_ENABLED=true AND CURSOR_API_KEY.",
    );
    return emptyResult("RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN");
  }

  if (!useFixture && !externalCursorAllowed) {
    notes.push(
      "EXTERNAL_CURSOR_ALLOWED=false — refusing live HTTP Cursor transport.",
    );
    return emptyResult("RADIO_PHASE1_BLOCKED");
  }

  let client = options.client;
  if (!client) {
    if (useFixture || !externalCursorAllowed) {
      client = createFixtureCursorClient(options.plannedAgentIdOverride);
      notes.push("Using fixture Cursor API v1 client (no network).");
    } else {
      const apiKey = resolveCursorApiKey(env);
      if (!apiKey) {
        return emptyResult("RADIO_PHASE1_BLOCKED", [
          "BLOCKED_NO_CURSOR_API_KEY: CURSOR_API_KEY missing despite execution enabled",
        ]);
      }
      client = createHttpCursorApiClient({
        apiKey,
        baseUrl: env.CURSOR_API_BASE_URL?.trim() || "https://api.cursor.com",
      });
    }
  }

  // Fail closed: fixture / non-external mode must never reach HTTP Cursor adapter.
  if (!externalCursorAllowed && isHttpCursorApiClient(client)) {
    notes.push(
      "EXTERNAL_CURSOR_ALLOWED=false — HTTP Cursor client refused before network execution.",
    );
    return emptyResult("RADIO_PHASE1_BLOCKED", [
      "Fixture/live isolation: refused HTTP Cursor adapter",
    ]);
  }

  // Track work-order identity; PLANNING→IMPLEMENTING waits until dispatch intent
  // (and auth preflight for create) are ready.
  state = {
    ...state,
    radioRuntime: {
      ...state.radioRuntime,
      activeWorkOrderId: options.workOrder.workOrderId,
      activeTransactionId: options.workOrder.transactionId,
    },
  };

  appendLedgerEvent({
    ledgerPath: options.ledgerPath,
    eventType: "WORK_ORDER_CREATED",
    projectId: options.workOrder.projectId,
    workstreamId: options.workOrder.workstreamId,
    transactionId: options.workOrder.transactionId,
    workOrderId: options.workOrder.workOrderId,
    decisionId: options.workOrder.decisionId,
    agentId: null,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: options.workOrder.idempotencyKey,
    summary: `Work order ${options.workOrder.workOrderId} created`,
    payload: {
      workOrderId: options.workOrder.workOrderId,
      agentAction: options.workOrder.agentAction,
      workType: options.workOrder.workType,
    },
  });

  // Crash recovery D: raw result already received → restore VERIFYING, no re-launch.
  const priorReceipt = findRawResultReceipt(
    options.ledgerPath,
    options.workOrder.idempotencyKey,
  );
  if (priorReceipt && state.radioRuntime.state === "VERIFYING") {
    notes.push(
      "Crash recovery: raw Cursor result already received; remaining at VERIFYING (no semantic ingestion).",
    );
    const priorBinding = findCreatedBinding(
      options.ledgerPath,
      options.workOrder.idempotencyKey,
    );
    return {
      ...emptyResult("RADIO_PHASE1_RAW_RESULT_READY"),
      agentId: priorBinding?.agentId ?? priorReceipt.agentId,
      runId: priorBinding?.runId ?? null,
    };
  }

  // Idempotency: reuse existing agent+run for this work order key.
  const priorCreated = findCreatedBinding(
    options.ledgerPath,
    options.workOrder.idempotencyKey,
  );

  if (priorCreated) {
    agentId = priorCreated.agentId;
    runId = priorCreated.runId;
    notes.push(
      `Idempotency reconcile: reusing agent ${agentId} run ${runId} for key ${options.workOrder.idempotencyKey}`,
    );
    appendLedgerEvent({
      ledgerPath: options.ledgerPath,
      eventType: "IDEMPOTENCY_RECONCILED",
      projectId: options.workOrder.projectId,
      workstreamId: options.workOrder.workstreamId,
      transactionId: options.workOrder.transactionId,
      workOrderId: options.workOrder.workOrderId,
      decisionId: options.workOrder.decisionId,
      agentId,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: options.workOrder.idempotencyKey,
      summary: `Reconciled existing Cursor agent ${agentId} run ${runId}`,
      payload: { agentId, runId },
    });
  } else if (state.activeAgent?.agentId) {
    agentId = state.activeAgent.agentId;
    const fromLedger = findCreatedBinding(
      options.ledgerPath,
      options.workOrder.idempotencyKey,
    );
    runId =
      fromLedger?.runId ??
      (typeof state.activeAgent.runId === "string"
        ? state.activeAgent.runId
        : null);
    if (!runId) {
      // Resume: fetch latest run from durable agent.
      cursorApiCalled = true;
      try {
        const agent = await client.getAgent(agentId);
        if (agent.latestRunId) {
          runId = agent.latestRunId;
        }
      } catch (err) {
        return emptyResult("RADIO_PHASE1_BLOCKED", [safeErrorMessage(err)]);
      }
    }
    notes.push(`Resuming activeAgent ${agentId} run ${runId}`);
    if (
      typeof state.activeAgent.model === "string" &&
      state.activeAgent.model.trim()
    ) {
      workerModel = state.activeAgent.model.trim();
    }
  } else {
    // Generate or recover planned agent ID BEFORE POST.
    let plannedAgentId =
      options.plannedAgentIdOverride ??
      findPlannedAgentId(options.ledgerPath, options.workOrder.idempotencyKey);

    if (!plannedAgentId) {
      plannedAgentId = generatePlannedAgentId();
    } else {
      notes.push(
        `Crash recovery: reusing planned agent ID ${plannedAgentId} from prior CREATE_REQUESTED`,
      );
    }

    // Re-render worker prompt with planned agent identity so the completion
    // contract template binds ordinaryAgent.agentId before Cursor create.
    const promptWithIdentity = renderCursorPrompt(options.workOrder, {
      plannedAgentId,
    });
    const promptHash = sha256Hex(promptWithIdentity);
    const dispatchId = newId("dispatch");
    // Persist the identity-bound prompt for auditability.
    writeJson(path.join(options.runDir, "cursor-prompt-meta.json"), {
      plannedAgentId,
      promptHash,
      identityBoundAt: nowIso(),
    });
    fs.writeFileSync(
      path.join(options.runDir, "cursor-prompt.txt"),
      promptWithIdentity,
      "utf8",
    );
    artifactPaths.cursorPrompt = path.join(options.runDir, "cursor-prompt.txt");
    artifactPaths.cursorPromptMeta = path.join(
      options.runDir,
      "cursor-prompt-meta.json",
    );

    let sourceLaunch;
    try {
      sourceLaunch = deriveSourceLaunchIntent(options.workOrder.source);
      // Live external write: require full 40-char SHA. Do not expand short pins
      // or accept prefix equality. Fixture transmit may retain artificial shorts.
      if (externalCursorAllowed && !useFixture) {
        requireLiveFullCommitSha(sourceLaunch.expectedCommitSha);
      }
    } catch (err) {
      const message =
        err instanceof SourceRefPrecheckError
          ? err.message
          : `SOURCE_REF_PRECHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`;
      return emptyResult("RADIO_PHASE1_BLOCKED", [message]);
    }
    const transportStartingRef = sourceLaunch.transportStartingRef;
    const expectedCommitSha = sourceLaunch.expectedCommitSha;
    // Back-compat alias: startingRef means Cursor transport ref (branch name).
    const startingRef = transportStartingRef;

    // Authenticated Cursor preflight BEFORE create (and before IMPLEMENTING).
    try {
      cursorApiCalled = true;
      const me = await client.getMe();
      const preflightPath = path.join(
        options.runDir,
        "cursor-preflight-me.json",
      );
      writeJson(preflightPath, sanitizeMeForArtifact(me));
      artifactPaths.preflightMe = preflightPath;
      notes.push("Cursor authenticated preflight GET /v1/me succeeded.");
    } catch (err) {
      cursorApiCalled = true;
      const message = safeErrorMessage(err);
      const preflightFailPath = path.join(
        options.runDir,
        "cursor-preflight-failure.json",
      );
      writeJson(preflightFailPath, {
        endpoint: "GET /v1/me",
        error: message,
        createCalled: false,
      });
      artifactPaths.preflightFailure = preflightFailPath;
      appendLedgerEvent({
        ledgerPath: options.ledgerPath,
        eventType: "CURSOR_AGENT_CREATE_FAILED",
        projectId: options.workOrder.projectId,
        workstreamId: options.workOrder.workstreamId,
        transactionId: options.workOrder.transactionId,
        workOrderId: options.workOrder.workOrderId,
        decisionId: options.workOrder.decisionId,
        agentId: plannedAgentId,
        stateRevisionBefore: state.stateRevision,
        stateRevisionAfter: state.stateRevision,
        stateFingerprint: fingerprint,
        idempotencyKey: options.workOrder.idempotencyKey,
        severity: "ERROR",
        summary: `Cursor preflight GET /v1/me failed: ${message}`,
        payload: {
          error: message,
          plannedAgentId,
          phase: "preflight",
          endpoint: "GET /v1/me",
          createCalled: false,
          apiVersion: "v1",
        },
      });
      return emptyResult("RADIO_PHASE1_BLOCKED", [
        `CURSOR_PREFLIGHT_FAILED: ${message}`,
      ]);
    }

    // Remote source-ref precheck: prove transport branch tip == expected SHA
    // BEFORE persisting create intent / POST /v1/agents.
    const resolveRemoteBranchTip: ResolveRemoteBranchTip =
      options.resolveRemoteBranchTip ??
      (useFixture
        ? async ({ branch }) => {
            if (branch === transportStartingRef) {
              return expectedCommitSha;
            }
            throw new SourceRefPrecheckError(
              `SOURCE_REF_PRECHECK_FAILED: remote branch ${JSON.stringify(branch)} does not exist`,
            );
          }
        : resolveRemoteBranchTipViaGitLsRemote);

    let sourceRefVerification: SourceRefVerification;
    try {
      sourceRefVerification = await verifyRemoteSourceRef({
        intent: sourceLaunch,
        resolveRemoteBranchTip,
        nowIso,
      });
      notes.push(
        `Source ref precheck OK: ${transportStartingRef} → ${sourceRefVerification.remoteResolvedSha}`,
      );
    } catch (err) {
      const message =
        err instanceof SourceRefPrecheckError
          ? err.message
          : `SOURCE_REF_PRECHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`;
      const failPath = path.join(
        options.runDir,
        "cursor-source-ref-precheck-failure.json",
      );
      writeJson(failPath, {
        repository: sourceLaunch.repository,
        expectedCommitSha,
        transportStartingRef,
        error: message,
        createCalled: false,
      });
      artifactPaths.sourceRefPrecheckFailure = failPath;
      appendLedgerEvent({
        ledgerPath: options.ledgerPath,
        eventType: "CURSOR_AGENT_CREATE_FAILED",
        projectId: options.workOrder.projectId,
        workstreamId: options.workOrder.workstreamId,
        transactionId: options.workOrder.transactionId,
        workOrderId: options.workOrder.workOrderId,
        decisionId: options.workOrder.decisionId,
        agentId: plannedAgentId,
        stateRevisionBefore: state.stateRevision,
        stateRevisionAfter: state.stateRevision,
        stateFingerprint: fingerprint,
        idempotencyKey: options.workOrder.idempotencyKey,
        severity: "ERROR",
        summary: message,
        payload: {
          error: message,
          plannedAgentId,
          phase: "source_ref_precheck",
          expectedCommitSha,
          transportStartingRef,
          createCalled: false,
          apiVersion: "v1",
        },
      });
      return emptyResult("RADIO_PHASE1_BLOCKED", [message]);
    }

    const intentPath = path.join(options.runDir, "cursor-dispatch-intent.json");
    writeJson(intentPath, {
      dispatchId,
      workOrderId: options.workOrder.workOrderId,
      projectId: options.workOrder.projectId,
      transactionId: options.workOrder.transactionId,
      idempotencyKey: options.workOrder.idempotencyKey,
      plannedAgentId,
      repository: options.workOrder.source.repository,
      expectedCommitSha: sourceRefVerification.expectedCommitSha,
      transportStartingRef: sourceRefVerification.transportStartingRef,
      remoteResolvedSha: sourceRefVerification.remoteResolvedSha,
      sourceRefVerifiedAt: sourceRefVerification.sourceRefVerifiedAt,
      /** @deprecated alias of transportStartingRef (Cursor API create ref) */
      startingRef,
      promptHash,
      createdAt: nowIso(),
      stateRevision: state.stateRevision,
      stateFingerprint: fingerprint,
      apiVersion: "v1",
      externalCursorAllowed,
    });
    artifactPaths.dispatchIntent = intentPath;

    // Only emit CREATE_REQUESTED once per planned id for this key.
    const priorRequest = findLedgerEventByIdempotency(
      options.ledgerPath,
      options.workOrder.idempotencyKey,
      ["CURSOR_AGENT_CREATE_REQUESTED"],
    );
    if (!priorRequest) {
      appendLedgerEvent({
        ledgerPath: options.ledgerPath,
        eventType: "CURSOR_AGENT_CREATE_REQUESTED",
        projectId: options.workOrder.projectId,
        workstreamId: options.workOrder.workstreamId,
        transactionId: options.workOrder.transactionId,
        workOrderId: options.workOrder.workOrderId,
        decisionId: options.workOrder.decisionId,
        agentId: plannedAgentId,
        stateRevisionBefore: state.stateRevision,
        stateRevisionAfter: state.stateRevision,
        stateFingerprint: fingerprint,
        idempotencyKey: options.workOrder.idempotencyKey,
        summary: "Requesting Cursor v1 agent create",
        payload: {
          plannedAgentId,
          dispatchId,
          repository: options.workOrder.source.repository,
          expectedCommitSha: sourceRefVerification.expectedCommitSha,
          transportStartingRef: sourceRefVerification.transportStartingRef,
          remoteResolvedSha: sourceRefVerification.remoteResolvedSha,
          sourceRefVerifiedAt: sourceRefVerification.sourceRefVerifiedAt,
          startingRef,
          promptHash,
          autoCreatePR: false,
          workerModel,
          apiVersion: "v1",
        },
      });
    }

    // Explicit worker model gate — fail closed before POST /v1/agents.
    const modelDecision = evaluateCursorWorkerModel({
      modelId: workerModel,
      policy: modelPolicy,
      allowPolicyDefault: true,
    });
    workerModel = modelDecision.modelId;
    writeJson(path.join(options.runDir, "cursor-worker-model-decision.json"), {
      ...modelDecision,
      policyDefaultModelId: modelPolicy.defaultModelId,
      approvedModelIds: modelPolicy.approvedModelIds,
    });
    if (!modelDecision.ok) {
      appendLedgerEvent({
        ledgerPath: options.ledgerPath,
        eventType: "CURSOR_AGENT_CREATE_FAILED",
        projectId: options.workOrder.projectId,
        workstreamId: options.workOrder.workstreamId,
        transactionId: options.workOrder.transactionId,
        workOrderId: options.workOrder.workOrderId,
        decisionId: options.workOrder.decisionId,
        agentId: plannedAgentId,
        stateRevisionBefore: state.stateRevision,
        stateRevisionAfter: state.stateRevision,
        stateFingerprint: fingerprint,
        idempotencyKey: options.workOrder.idempotencyKey,
        severity: "ERROR",
        summary: modelDecision.summary,
        payload: {
          code: modelDecision.code,
          modelId: modelDecision.modelId,
          humanApprovalRequired: modelDecision.humanApprovalRequired,
          createCalled: false,
          apiVersion: "v1",
        },
      });
      if (modelDecision.humanApprovalRequired) {
        return emptyResult("RADIO_PHASE1_HUMAN_REQUIRED", [
          modelDecision.summary,
        ]);
      }
      return emptyResult("RADIO_PHASE1_BLOCKED", [modelDecision.summary]);
    }

    if (
      !options.skipModelCatalogValidation &&
      !useFixture &&
      externalCursorAllowed &&
      workerModel
    ) {
      const catalogDecision = await validateModelAgainstCursorCatalog({
        modelId: workerModel,
        client,
        policy: modelPolicy,
      });
      writeJson(
        path.join(options.runDir, "cursor-worker-model-catalog.json"),
        catalogDecision,
      );
      if (!catalogDecision.ok) {
        return emptyResult("RADIO_PHASE1_BLOCKED", [catalogDecision.summary]);
      }
    }

    // PLANNING → IMPLEMENTING only after local auth + durable dispatch intent.
    if (state.radioRuntime.state === "PLANNING") {
      state = transitionRuntimeState(
        state,
        "IMPLEMENTING",
        "CURSOR_AGENT_CREATE_REQUESTED",
      );
    }

    try {
      cursorApiCalled = true;
      const launched = await createOrReconcileAgent({
        client,
        workOrder: options.workOrder,
        prompt: promptWithIdentity,
        plannedAgentId,
        modelId: workerModel!,
      });
      createRequest = launched.createRequest;
      agentId = launched.agent.id;
      runId = launched.run.id;

      if (agentId !== plannedAgentId) {
        throw new Error(
          `Cursor returned agent id ${agentId} which differs from planned ${plannedAgentId}`,
        );
      }

      const createResponsePath = path.join(
        options.runDir,
        "cursor-create-response.json",
      );
      writeJson(createResponsePath, {
        agent: launched.agent,
        run: launched.run,
      });
      artifactPaths.createResponse = createResponsePath;

      if (launched.reconciledViaConflict) {
        notes.push(
          `409 agent_id_conflict: reconciled via GET /v1/agents/${plannedAgentId}`,
        );
      }
      if (launched.reconciledViaAmbiguous) {
        notes.push(
          `Ambiguous create: reconciled via GET /v1/agents/${plannedAgentId}`,
        );
      }

      appendLedgerEvent({
        ledgerPath: options.ledgerPath,
        eventType: "CURSOR_AGENT_CREATED",
        projectId: options.workOrder.projectId,
        workstreamId: options.workOrder.workstreamId,
        transactionId: options.workOrder.transactionId,
        workOrderId: options.workOrder.workOrderId,
        decisionId: options.workOrder.decisionId,
        agentId,
        stateRevisionBefore: state.stateRevision,
        stateRevisionAfter: state.stateRevision,
        stateFingerprint: fingerprint,
        idempotencyKey: options.workOrder.idempotencyKey,
        summary: `Cursor v1 agent created: ${agentId} run ${runId}`,
        payload: {
          agentId,
          runId,
          agentStatus: launched.agent.status,
          runStatus: launched.run.status,
          reusedExisting: launched.reusedExisting,
          reconciledViaConflict: launched.reconciledViaConflict,
          reconciledViaAmbiguous: launched.reconciledViaAmbiguous,
          startingRef,
          apiVersion: "v1",
        },
      });
    } catch (err) {
      const message = safeErrorMessage(err);
      appendLedgerEvent({
        ledgerPath: options.ledgerPath,
        eventType: "CURSOR_AGENT_CREATE_FAILED",
        projectId: options.workOrder.projectId,
        workstreamId: options.workOrder.workstreamId,
        transactionId: options.workOrder.transactionId,
        workOrderId: options.workOrder.workOrderId,
        decisionId: options.workOrder.decisionId,
        agentId: plannedAgentId,
        stateRevisionBefore: state.stateRevision,
        stateRevisionAfter: state.stateRevision,
        stateFingerprint: fingerprint,
        idempotencyKey: options.workOrder.idempotencyKey,
        severity: "ERROR",
        summary: `Cursor agent create failed: ${message}`,
        payload: { error: message, plannedAgentId, apiVersion: "v1" },
      });
      return emptyResult("RADIO_PHASE1_BLOCKED", [message]);
    }
  }

  if (!agentId || !runId) {
    return emptyResult("RADIO_PHASE1_BLOCKED", [
      "Missing agentId or runId after create/reconcile",
    ]);
  }

  // Confirmed/reconciled create → WAITING_FOR_AGENT (if not already past it).
  if (
    state.radioRuntime.state === "IMPLEMENTING" ||
    state.radioRuntime.state === "PLANNING"
  ) {
    if (state.radioRuntime.state === "PLANNING") {
      state = transitionRuntimeState(
        state,
        "IMPLEMENTING",
        "CURSOR_AGENT_CREATE_REQUESTED",
      );
    }
    state = {
      ...state,
      activeAgent: {
        agentId,
        role: "ORDINARY_AGENT",
        source: "api",
        model: workerModel,
        workOrderId: options.workOrder.workOrderId,
        transactionId: options.workOrder.transactionId,
        launchedAt: nowIso(),
        status: "RUNNING",
        lastObservedAt: nowIso(),
        runId,
      },
    };
    state = transitionRuntimeState(
      state,
      "WAITING_FOR_AGENT",
      "CURSOR_AGENT_CREATED",
    );

    const persistedWaiting = persistProjectState({
      state,
      path: options.statePath,
      expectedRevision: state.stateRevision,
    });
    state = persistedWaiting.state;
    fingerprint = persistedWaiting.fingerprint;

    appendLedgerEvent({
      ledgerPath: options.ledgerPath,
      eventType: "PROJECT_STATE_UPDATED",
      projectId: options.workOrder.projectId,
      workstreamId: options.workOrder.workstreamId,
      transactionId: options.workOrder.transactionId,
      workOrderId: options.workOrder.workOrderId,
      decisionId: options.workOrder.decisionId,
      agentId,
      stateRevisionBefore: persistedWaiting.previousRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: options.workOrder.idempotencyKey,
      summary: "State updated to WAITING_FOR_AGENT",
      payload: { runtimeState: state.radioRuntime.state, runId },
    });
  }

  // If already VERIFYING with receipt, stop (handled above). If WAITING, poll.
  if (state.radioRuntime.state === "VERIFYING" && priorReceipt) {
    return {
      ...emptyResult("RADIO_PHASE1_RAW_RESULT_READY"),
      agentId,
      runId,
    };
  }

  // Poll exact run
  cursorApiCalled = true;

  // Before-usage snapshot (best-effort; Cursor may report zeros while RUNNING).
  try {
    const beforeUsage = await client.getAgentUsage(agentId, runId);
    usageTelemetryBefore = buildUsageTelemetrySnapshot({
      objectiveId: options.objectiveId ?? null,
      agentId,
      runId,
      workerModel,
      phase: "before",
      usage: beforeUsage.totalUsage,
      usageCaptureStatus: "captured",
    });
    writeJson(
      path.join(options.runDir, "cursor-usage-before.json"),
      usageTelemetryBefore,
    );
  } catch (err) {
    usageTelemetryBefore = buildUsageTelemetrySnapshot({
      objectiveId: options.objectiveId ?? null,
      agentId,
      runId,
      workerModel,
      phase: "before",
      usage: null,
      usageCaptureStatus: "error",
      notes: [safeErrorMessage(err)],
    });
    writeJson(
      path.join(options.runDir, "cursor-usage-before.json"),
      usageTelemetryBefore,
    );
  }

  let terminalRun: V1Run;
  try {
    terminalRun = await pollRunUntilTerminal({
      client,
      agentId,
      runId,
      intervalMs:
        options.pollIntervalMs ??
        resolveCursorPollDefaults(useFixture).pollIntervalMs,
      maxAttempts:
        options.pollMaxAttempts ??
        resolveCursorPollDefaults(useFixture).pollMaxAttempts,
      sleep: options.sleep,
      onStatus: (run, classified) => {
        if (classified !== "RUNNING") {
          appendLedgerEvent({
            ledgerPath: options.ledgerPath,
            eventType: "CURSOR_AGENT_STATUS_CHANGED",
            projectId: options.workOrder.projectId,
            workstreamId: options.workOrder.workstreamId,
            transactionId: options.workOrder.transactionId,
            workOrderId: options.workOrder.workOrderId,
            decisionId: options.workOrder.decisionId,
            agentId,
            stateRevisionBefore: state.stateRevision,
            stateRevisionAfter: state.stateRevision,
            stateFingerprint: fingerprint,
            idempotencyKey: options.workOrder.idempotencyKey,
            summary: `Run status → ${run.status}`,
            payload: {
              runId,
              status: run.status,
              classified,
              apiVersion: "v1",
            },
          });
        }
      },
    });
  } catch (err) {
    // Observation budget expired while worker is still healthy/non-terminal.
    // Persist WAITING_FOR_AGENT with active agent binding — resumable, not blocked.
    if (state.radioRuntime.state !== "WAITING_FOR_AGENT") {
      if (
        state.radioRuntime.state === "IMPLEMENTING" ||
        state.radioRuntime.state === "PLANNING"
      ) {
        state = {
          ...state,
          activeAgent: {
            agentId,
            role: "ORDINARY_AGENT",
            source: "api",
            model: workerModel,
            workOrderId: options.workOrder.workOrderId,
            transactionId: options.workOrder.transactionId,
            launchedAt: nowIso(),
            status: "RUNNING",
            lastObservedAt: nowIso(),
            runId,
          },
        };
        state = transitionRuntimeState(
          state,
          "WAITING_FOR_AGENT",
          "CURSOR_POLL_OBSERVATION_BUDGET",
        );
      }
    } else {
      state = {
        ...state,
        activeAgent: state.activeAgent
          ? {
              ...state.activeAgent,
              agentId,
              runId,
              model: workerModel ?? state.activeAgent.model ?? null,
              status: "RUNNING",
              lastObservedAt: nowIso(),
            }
          : {
              agentId,
              role: "ORDINARY_AGENT",
              source: "api",
              model: workerModel,
              workOrderId: options.workOrder.workOrderId,
              transactionId: options.workOrder.transactionId,
              launchedAt: nowIso(),
              status: "RUNNING",
              lastObservedAt: nowIso(),
              runId,
            },
        radioRuntime: {
          ...state.radioRuntime,
          lastEvent: "CURSOR_POLL_OBSERVATION_BUDGET",
        },
      };
    }

    const persistedWaiting = persistProjectState({
      state,
      path: options.statePath,
      expectedRevision: state.stateRevision,
    });
    state = persistedWaiting.state;
    fingerprint = persistedWaiting.fingerprint;

    writeJson(path.join(options.runDir, "cursor-wait-checkpoint.json"), {
      agentId,
      runId,
      workerModel,
      runtimeState: state.radioRuntime.state,
      observationBudgetExpired: true,
      resumable: true,
      error: safeErrorMessage(err),
      capturedAt: nowIso(),
    });

    return {
      ...emptyResult("RADIO_PHASE1_DISPATCH_WAITING", [safeErrorMessage(err)]),
      agentId,
      runId,
      workerModel,
    };
  }

  const classified = classifyRunStatus(terminalRun.status);
  if (classified !== "FINISHED") {
    rawResultText =
      typeof terminalRun.result === "string" ? terminalRun.result : "";
    const errResultPath = path.join(options.runDir, "cursor-result-error.txt");
    fs.mkdirSync(path.dirname(errResultPath), { recursive: true });
    fs.writeFileSync(errResultPath, rawResultText, "utf8");
    artifactPaths.cursorResultError = errResultPath;
    writeJson(path.join(options.runDir, "cursor-run-final.json"), terminalRun);

    appendLedgerEvent({
      ledgerPath: options.ledgerPath,
      eventType: "CURSOR_AGENT_COMPLETED",
      projectId: options.workOrder.projectId,
      workstreamId: options.workOrder.workstreamId,
      transactionId: options.workOrder.transactionId,
      workOrderId: options.workOrder.workOrderId,
      decisionId: options.workOrder.decisionId,
      agentId,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: options.workOrder.idempotencyKey,
      severity: "ERROR",
      summary: `Run ended non-success status=${terminalRun.status}`,
      payload: { runId, status: terminalRun.status, apiVersion: "v1" },
    });

    state = {
      ...state,
      activeAgent: state.activeAgent
        ? {
            ...state.activeAgent,
            status: "FAILED",
            lastObservedAt: nowIso(),
            runId,
            model: workerModel ?? state.activeAgent.model ?? null,
          }
        : {
            agentId,
            role: "ORDINARY_AGENT",
            source: "api",
            model: workerModel,
            workOrderId: options.workOrder.workOrderId,
            transactionId: options.workOrder.transactionId,
            launchedAt: nowIso(),
            status: "FAILED",
            lastObservedAt: nowIso(),
            runId,
          },
    };
    const persistedFailed = persistProjectState({
      state,
      path: options.statePath,
      expectedRevision: state.stateRevision,
    });
    state = persistedFailed.state;
    fingerprint = persistedFailed.fingerprint;

    return {
      ...emptyResult("RADIO_PHASE1_BLOCKED", [
        `Run status ${terminalRun.status}`,
      ]),
      agentId,
      runId,
      rawResultText,
    };
  }

  // Store raw API payload + result text byte-for-byte.
  const rawRunPath = path.join(options.runDir, "cursor-run-final.json");
  writeJson(rawRunPath, terminalRun);
  artifactPaths.cursorRunFinal = rawRunPath;

  rawResultText =
    typeof terminalRun.result === "string" ? terminalRun.result : "";
  const cursorResultPath = path.join(options.runDir, "cursor-result.txt");
  // Byte-for-byte persistence — do not normalize newlines via writeText.
  fs.mkdirSync(path.dirname(cursorResultPath), { recursive: true });
  fs.writeFileSync(cursorResultPath, rawResultText, "utf8");
  artifactPaths.cursorResult = cursorResultPath;

  // Usage capture (nonfatal if missing).
  try {
    usage = await client.getAgentUsage(agentId, runId);
    usageCaptureStatus = "captured";
    const usagePath = path.join(options.runDir, "cursor-usage.json");
    writeJson(usagePath, usage);
    artifactPaths.cursorUsage = usagePath;
    usageTelemetryAfter = buildUsageTelemetrySnapshot({
      objectiveId: options.objectiveId ?? null,
      agentId,
      runId,
      workerModel,
      phase: "after",
      usage: usage.totalUsage,
      usageCaptureStatus: "captured",
      runtimeMs: terminalRun.durationMs ?? null,
    });
    writeJson(
      path.join(options.runDir, "cursor-usage-after.json"),
      usageTelemetryAfter,
    );
    writeJson(path.join(options.runDir, "cursor-usage-telemetry.json"), {
      before: usageTelemetryBefore,
      after: usageTelemetryAfter,
      deltaTokens: usageDeltaTokens(usageTelemetryBefore, usageTelemetryAfter),
      workerModel,
      objectiveId: options.objectiveId ?? null,
      agentId,
      runId,
      exactDollarBudgetSupported: false,
    });
  } catch (err) {
    usageCaptureStatus = "error";
    notes.push(`Usage capture nonfatal: ${safeErrorMessage(err)}`);
    writeJson(path.join(options.runDir, "cursor-usage-error.json"), {
      error: safeErrorMessage(err),
      captured: false,
    });
    usageTelemetryAfter = buildUsageTelemetrySnapshot({
      objectiveId: options.objectiveId ?? null,
      agentId,
      runId,
      workerModel,
      phase: "after",
      usage: null,
      usageCaptureStatus: "error",
      runtimeMs: terminalRun.durationMs ?? null,
      notes: [safeErrorMessage(err)],
    });
  }

  appendLedgerEvent({
    ledgerPath: options.ledgerPath,
    eventType: "CURSOR_AGENT_COMPLETED",
    projectId: options.workOrder.projectId,
    workstreamId: options.workOrder.workstreamId,
    transactionId: options.workOrder.transactionId,
    workOrderId: options.workOrder.workOrderId,
    decisionId: options.workOrder.decisionId,
    agentId,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: options.workOrder.idempotencyKey,
    summary: `Cursor run finished: ${agentId}/${runId}`,
    payload: {
      runId,
      status: terminalRun.status,
      durationMs: terminalRun.durationMs ?? null,
      git: terminalRun.git ?? null,
      usageCaptureStatus,
      apiVersion: "v1",
    },
  });

  // Raw receipt only — NOT semantic validation (Phase 2).
  appendLedgerEvent({
    ledgerPath: options.ledgerPath,
    eventType: "CURSOR_REPORT_RECEIVED",
    projectId: options.workOrder.projectId,
    workstreamId: options.workOrder.workstreamId,
    transactionId: options.workOrder.transactionId,
    workOrderId: options.workOrder.workOrderId,
    decisionId: options.workOrder.decisionId,
    agentId,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: options.workOrder.idempotencyKey,
    summary: "Raw Cursor run result received (untrusted external evidence)",
    payload: {
      runId,
      resultByteLength: Buffer.byteLength(rawResultText, "utf8"),
      semanticIngestion: false,
      apiVersion: "v1",
    },
  });

  // Update activeAgent to completed; do NOT clear — Phase 2 recovery needs it.
  // Persist Radio-owned runId so identity survives missing gitignored ledger.
  // Do NOT set pendingHumanDecision. Do NOT go READY_FOR_HUMAN.
  state = {
    ...state,
    activeAgent: {
      agentId,
      role: "ORDINARY_AGENT",
      source: "api",
      model: workerModel,
      workOrderId: options.workOrder.workOrderId,
      transactionId: options.workOrder.transactionId,
      launchedAt:
        typeof state.activeAgent?.launchedAt === "string"
          ? state.activeAgent.launchedAt
          : nowIso(),
      status: "COMPLETED",
      lastObservedAt: nowIso(),
      runId,
    },
    radioRuntime: {
      ...state.radioRuntime,
      lastEvent: "CURSOR_REPORT_RECEIVED",
    },
  };

  if (state.radioRuntime.state === "WAITING_FOR_AGENT") {
    state = transitionRuntimeState(
      state,
      "VERIFYING",
      "CURSOR_REPORT_RECEIVED",
    );
  }

  const persistedFinal = persistProjectState({
    state,
    path: options.statePath,
    expectedRevision: state.stateRevision,
  });
  state = persistedFinal.state;
  fingerprint = persistedFinal.fingerprint;

  appendLedgerEvent({
    ledgerPath: options.ledgerPath,
    eventType: "PROJECT_STATE_UPDATED",
    projectId: options.workOrder.projectId,
    workstreamId: options.workOrder.workstreamId,
    transactionId: options.workOrder.transactionId,
    workOrderId: options.workOrder.workOrderId,
    decisionId: options.workOrder.decisionId,
    agentId,
    stateRevisionBefore: persistedFinal.previousRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: options.workOrder.idempotencyKey,
    summary: "State updated to VERIFYING after raw Cursor result",
    payload: {
      runtimeState: state.radioRuntime.state,
      runId,
      phase1Terminal: "RADIO_PHASE1_RAW_RESULT_READY",
    },
  });

  // Assert Phase 1 boundary: no semantic events.
  const semanticEvents = readLedgerEvents(options.ledgerPath).filter(
    (e) => e.eventType === "CURSOR_REPORT_VALIDATED",
  );
  if (semanticEvents.length > 0) {
    throw new Error(
      "Phase 1 invariant violated: CURSOR_REPORT_VALIDATED was emitted",
    );
  }

  return {
    terminalVerdict: "RADIO_PHASE1_RAW_RESULT_READY",
    cursorApiCalled,
    agentId,
    runId,
    state,
    fingerprint,
    rawResultText,
    usage,
    usageCaptureStatus,
    artifactPaths,
    summaryNotes: notes,
    createRequest,
    workerModel,
    usageTelemetryBefore,
    usageTelemetryAfter,
    usageDeltaTokens: usageDeltaTokens(usageTelemetryBefore, usageTelemetryAfter),
  };
}

export function ensureLedgerFile(ledgerPath: string): void {
  if (!fs.existsSync(ledgerPath)) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, "", "utf8");
  }
}

export { FIXTURE_AGENT_ID, FIXTURE_RUN_ID, createFixtureCursorClient };
