import fs from "node:fs";
import path from "node:path";
import { writeJson, writeText } from "../artifacts/writer.js";
import {
  canLiveCursorDispatch,
  createHttpCursorApiClient,
  type CursorApiClient,
  resolveCursorApiKey,
} from "../cursor/api-client.js";
import {
  classifyAgentStatus,
  launchCursorAgent,
  pollAgentUntilTerminal,
  retrieveCompletionFromAgent,
} from "../cursor/adapter.js";
import {
  type CompletionValidationResult,
  validateCompletionAgainstWorkOrder,
  type CursorCompletionReport,
} from "../cursor/completion-validator.js";
import {
  appendLedgerEvent,
  findLedgerEventByIdempotency,
} from "../state/ledger.js";
import { computeStateFingerprint } from "../state/fingerprint.js";
import {
  persistProjectState,
  transitionRuntimeState,
} from "../state/mutate.js";
import type {
  CursorWorkOrder,
  Phase1TerminalVerdict,
  ProjectState,
  RadioTerminalVerdict,
} from "../types.js";
import { nowIso, readJsonFile, resolveRepoPath } from "../util/io.js";

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
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface TransmitResult {
  terminalVerdict: RadioTerminalVerdict;
  cursorApiCalled: boolean;
  agentId: string | null;
  state: ProjectState;
  fingerprint: string;
  completionReport: CursorCompletionReport | null;
  validation: CompletionValidationResult | null;
  artifactPaths: Record<string, string>;
  summaryNotes: string[];
}

function createFixtureCursorClient(reportPath: string): CursorApiClient {
  const report = readJsonFile<Record<string, unknown>>(reportPath);
  let launched = false;
  let status = "CREATING";
  const agentId = "bc_fixture_bellhop_01";

  return {
    async launchAgent() {
      if (launched) {
        // Idempotent-ish: return same agent if somehow called twice.
        return {
          id: agentId,
          name: "Fixture Bellhop Verifier",
          status,
          source: {
            repository: "https://github.com/timcgha/Bellhop",
            ref: "cursor/level4-stage2-asteroid-garden-9dce",
          },
          createdAt: nowIso(),
        };
      }
      launched = true;
      status = "RUNNING";
      return {
        id: agentId,
        name: "Fixture Bellhop Verifier",
        status,
        source: {
          repository: "https://github.com/timcgha/Bellhop",
          ref: "cursor/level4-stage2-asteroid-garden-9dce",
        },
        createdAt: nowIso(),
      };
    },
    async getAgent(id: string) {
      if (id !== agentId) {
        throw new Error(`Unknown fixture agent ${id}`);
      }
      if (status === "RUNNING") {
        status = "FINISHED";
      }
      return {
        id: agentId,
        name: "Fixture Bellhop Verifier",
        status,
        source: {
          repository: "https://github.com/timcgha/Bellhop",
          ref: "cursor/level4-stage2-asteroid-garden-9dce",
        },
        summary: "Fixture verification complete",
        createdAt: nowIso(),
      };
    },
    async getConversation(id: string) {
      if (id !== agentId) {
        throw new Error(`Unknown fixture agent ${id}`);
      }
      const body = {
        ...report,
        workOrderId: report.workOrderId,
      };
      const fenced = "```text\n" + JSON.stringify(body, null, 2) + "\n```";
      return {
        id: agentId,
        messages: [
          {
            id: "msg_user",
            type: "user_message",
            text: "verify stage 2",
          },
          {
            id: "msg_assistant_final",
            type: "assistant_message",
            text: fenced,
          },
        ],
      };
    },
    async listAgents() {
      return launched
        ? [
            {
              id: agentId,
              name: "Fixture Bellhop Verifier",
              status,
            },
          ]
        : [];
    },
  };
}

function applyCompletionToState(input: {
  state: ProjectState;
  workOrder: CursorWorkOrder;
  report: CursorCompletionReport;
  agentId: string;
}): ProjectState {
  let next = { ...input.state };
  const txn = next.currentTransaction
    ? { ...next.currentTransaction }
    : null;
  const ws = next.activeWorkstream ? { ...next.activeWorkstream } : null;

  if (txn) {
    txn.branchTipSha =
      input.report.repositoryState.branchTipSha ?? txn.branchTipSha;
    txn.finalExecutableSha =
      input.report.repositoryState.finalExecutableSha ?? txn.finalExecutableSha;
    txn.evidenceTipSha =
      input.report.repositoryState.evidenceTipSha ?? txn.evidenceTipSha;
    txn.status =
      input.report.terminalVerdict ===
      "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST"
        ? "READY_FOR_HUMAN"
        : "BLOCKED";
  }

  if (ws) {
    if (
      input.report.terminalVerdict ===
      "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST"
    ) {
      ws.status = "READY_FOR_HUMAN";
      ws.terminalVerdict = input.report.terminalVerdict;
    } else {
      ws.status = "BLOCKED";
      ws.terminalVerdict = input.report.terminalVerdict;
    }
  }

  next = {
    ...next,
    currentTransaction: txn,
    activeWorkstream: ws,
    activeAgent: null,
    pendingHumanDecision:
      input.report.terminalVerdict ===
      "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST"
        ? {
            approvalId: `approval-stage2-playtest-${input.workOrder.workOrderId}`,
            type: "OTHER",
            summary:
              "Technical verification passed. Human Stage 2 playtest is required before merge/deploy/Stage 3.",
            requestedAction: "COMPLETE_STAGE2_HUMAN_PLAYTEST",
            risk: "LOW",
            choices: ["APPROVE", "REJECT", "REVISE"],
            createdAt: nowIso(),
            stateRevisionBasis: next.stateRevision,
            consumed: false,
          }
        : next.pendingHumanDecision,
    radioRuntime: {
      ...next.radioRuntime,
      activeWorkOrderId: input.workOrder.workOrderId,
      activeTransactionId: input.workOrder.transactionId,
      lastEvent: "CURSOR_REPORT_VALIDATED",
    },
  };

  // Runtime path after verification: WAITING_FOR_AGENT → VERIFYING → READY_FOR_HUMAN
  next = transitionRuntimeState(next, "VERIFYING", "CURSOR_REPORT_VALIDATED");
  if (
    input.report.terminalVerdict ===
    "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST"
  ) {
    // VERIFYING → READY_FOR_HUMAN is legal per transition table.
    next = transitionRuntimeState(
      next,
      "READY_FOR_HUMAN",
      "HUMAN_PLAYTEST_BOUNDARY",
    );
  } else {
    next = transitionRuntimeState(next, "BLOCKED", "PILOT_BLOCKED");
  }

  return next;
}

/**
 * Phase 1 Cursor transmitter: idempotent launch → poll → ingest → validate → state/ledger.
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

  const liveAuthorized = canLiveCursorDispatch(env);
  const useFixture = Boolean(options.forceFixtureTransmit);

  if (!liveAuthorized && !useFixture) {
    notes.push(
      "Live Cursor dispatch not authorized. Requires CURSOR_EXECUTION_ENABLED=true AND CURSOR_API_KEY.",
    );
    return {
      terminalVerdict: "RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN",
      cursorApiCalled: false,
      agentId: null,
      state,
      fingerprint,
      completionReport: null,
      validation: null,
      artifactPaths,
      summaryNotes: notes,
    };
  }

  let client = options.client;
  if (!client) {
    if (useFixture) {
      client = createFixtureCursorClient(
        resolveRepoPath(
          "fixtures",
          "completion-reports",
          "bellhop-pilot-verified.json",
        ),
      );
      notes.push("Using fixture Cursor API client (no network).");
    } else {
      const apiKey = resolveCursorApiKey(env);
      if (!apiKey) {
        return {
          terminalVerdict: "RADIO_PHASE1_BLOCKED",
          cursorApiCalled: false,
          agentId: null,
          state,
          fingerprint,
          completionReport: null,
          validation: null,
          artifactPaths,
          summaryNotes: ["CURSOR_API_KEY missing despite execution enabled"],
        };
      }
      client = createHttpCursorApiClient({
        apiKey,
        baseUrl: env.CURSOR_API_BASE_URL?.trim() || "https://api.cursor.com",
      });
    }
  }

  // Persist work-order identity on state before external call.
  state = transitionRuntimeState(state, "IMPLEMENTING", "WORK_ORDER_CREATED");
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

  // Idempotency: reuse existing agent for this key if already created.
  const priorCreated = findLedgerEventByIdempotency(
    options.ledgerPath,
    options.workOrder.idempotencyKey,
    ["CURSOR_AGENT_CREATED"],
  );

  if (priorCreated?.agentId) {
    agentId = priorCreated.agentId;
    notes.push(
      `Idempotency reconcile: reusing agent ${agentId} for key ${options.workOrder.idempotencyKey}`,
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
      summary: `Reconciled existing Cursor agent ${agentId}`,
      payload: { agentId },
    });
  } else if (state.activeAgent?.agentId) {
    agentId = state.activeAgent.agentId;
    notes.push(`Resuming activeAgent ${agentId}`);
  } else {
    appendLedgerEvent({
      ledgerPath: options.ledgerPath,
      eventType: "CURSOR_AGENT_CREATE_REQUESTED",
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
      summary: "Requesting Cursor agent create",
      payload: {
        repository: options.workOrder.source.repository,
        ref: options.workOrder.source.workingBranch,
      },
    });

    try {
      cursorApiCalled = true;
      const launched = await launchCursorAgent({
        client,
        workOrder: options.workOrder,
        prompt: options.prompt,
      });
      agentId = launched.agent.id;

      // Patch fixture report workOrderId into conversation by rewriting report file copy in run dir.
      // (Fixture client embeds report as-is; we bind identity during validation by rewriting report.)
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
        summary: `Cursor agent created: ${agentId}`,
        payload: {
          agentId,
          status: launched.agent.status,
          reusedExisting: launched.reusedExisting,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLedgerEvent({
        ledgerPath: options.ledgerPath,
        eventType: "CURSOR_AGENT_CREATE_FAILED",
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
        severity: "ERROR",
        summary: `Cursor agent create failed: ${message}`,
        payload: { error: message },
      });
      return {
        terminalVerdict: "RADIO_PHASE1_BLOCKED",
        cursorApiCalled,
        agentId: null,
        state,
        fingerprint,
        completionReport: null,
        validation: null,
        artifactPaths,
        summaryNotes: [...notes, message],
      };
    }
  }

  state = {
    ...state,
    activeAgent: {
      agentId: agentId!,
      role: "ORDINARY_AGENT",
      source: "api",
      model: "default",
      workOrderId: options.workOrder.workOrderId,
      transactionId: options.workOrder.transactionId,
      launchedAt: nowIso(),
      status: "RUNNING",
      lastObservedAt: nowIso(),
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
    payload: { runtimeState: state.radioRuntime.state },
  });

  // Poll
  cursorApiCalled = true;
  let terminalAgent;
  try {
    terminalAgent = await pollAgentUntilTerminal({
      client,
      agentId: agentId!,
      intervalMs: options.pollIntervalMs ?? (useFixture ? 1 : 15_000),
      maxAttempts: options.pollMaxAttempts ?? (useFixture ? 5 : 120),
      sleep: options.sleep,
      onStatus: (agent, classified) => {
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
            summary: `Agent status → ${agent.status}`,
            payload: { status: agent.status, classified },
          });
        }
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      terminalVerdict: "RADIO_PHASE1_DISPATCH_WAITING",
      cursorApiCalled,
      agentId,
      state,
      fingerprint,
      completionReport: null,
      validation: null,
      artifactPaths,
      summaryNotes: [...notes, message],
    };
  }

  const classified = classifyAgentStatus(terminalAgent.status);
  if (classified !== "FINISHED") {
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
      summary: `Agent ended non-success status=${terminalAgent.status}`,
      payload: { status: terminalAgent.status },
    });
    return {
      terminalVerdict: "BELLHOP_RADIO_PILOT_BLOCKED",
      cursorApiCalled,
      agentId,
      state,
      fingerprint,
      completionReport: null,
      validation: null,
      artifactPaths,
      summaryNotes: [...notes, `Agent status ${terminalAgent.status}`],
    };
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
    summary: `Agent finished: ${agentId}`,
    payload: { status: terminalAgent.status },
  });

  const { conversation, parsed } = await retrieveCompletionFromAgent({
    client,
    agentId: agentId!,
  });

  // Bind fixture report identity to this work order when placeholders are used.
  let reportRaw = parsed.reportJson;
  if (
    reportRaw &&
    typeof reportRaw === "object" &&
    (reportRaw as { workOrderId?: string }).workOrderId === "PLACEHOLDER_WO"
  ) {
    reportRaw = {
      ...(reportRaw as object),
      workOrderId: options.workOrder.workOrderId,
      workOrderRevision: options.workOrder.revision,
      decisionId: options.workOrder.decisionId,
      projectId: options.workOrder.projectId,
      workstreamId: options.workOrder.workstreamId,
      transactionId: options.workOrder.transactionId,
    };
  }

  const rawReportPath = path.join(options.runDir, "completion-report.raw.json");
  const conversationPath = path.join(options.runDir, "cursor-conversation.json");
  writeJson(rawReportPath, reportRaw);
  writeJson(conversationPath, conversation);
  writeText(path.join(options.runDir, "completion-report.fenced.txt"), parsed.fencedText);
  artifactPaths.completionReportRaw = rawReportPath;
  artifactPaths.cursorConversation = conversationPath;

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
    summary: "Completion report received from Cursor conversation",
    payload: { sourceMessageId: parsed.sourceMessageId },
  });

  const validation = validateCompletionAgainstWorkOrder({
    raw: reportRaw,
    workOrder: options.workOrder,
  });

  const validationPath = path.join(
    options.runDir,
    "completion-validation.json",
  );
  writeJson(validationPath, validation);
  artifactPaths.completionValidation = validationPath;

  if (validation.status !== "VALID" || !validation.report) {
    appendLedgerEvent({
      ledgerPath: options.ledgerPath,
      eventType: "CURSOR_REPORT_SCHEMA_REJECTED",
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
      summary: `Completion report rejected: ${validation.status}`,
      payload: { status: validation.status, errors: validation.errors },
    });
    return {
      terminalVerdict: "RADIO_PHASE1_BLOCKED",
      cursorApiCalled,
      agentId,
      state,
      fingerprint,
      completionReport: validation.report,
      validation,
      artifactPaths,
      summaryNotes: [...notes, ...validation.errors],
    };
  }

  const reportPath = path.join(options.runDir, "completion-report.json");
  writeJson(reportPath, validation.report);
  artifactPaths.completionReport = reportPath;

  appendLedgerEvent({
    ledgerPath: options.ledgerPath,
    eventType: "CURSOR_REPORT_VALIDATED",
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
    summary: `Completion report validated: ${validation.report.terminalVerdict}`,
    payload: {
      terminalVerdict: validation.report.terminalVerdict,
      reportHash: validation.reportHash,
    },
  });

  state = applyCompletionToState({
    state,
    workOrder: options.workOrder,
    report: validation.report,
    agentId: agentId!,
  });

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
    summary: "State updated after validated completion",
    payload: {
      runtimeState: state.radioRuntime.state,
      terminalVerdict: validation.report.terminalVerdict,
    },
  });

  const pilotVerdict = validation.report.terminalVerdict as Phase1TerminalVerdict;

  return {
    terminalVerdict: pilotVerdict,
    cursorApiCalled,
    agentId,
    state,
    fingerprint,
    completionReport: validation.report,
    validation,
    artifactPaths,
    summaryNotes: notes,
  };
}

export function ensureLedgerFile(ledgerPath: string): void {
  if (!fs.existsSync(ledgerPath)) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, "", "utf8");
  }
}
