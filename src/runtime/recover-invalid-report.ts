/**
 * Explicit-human recovery for an invalid Cursor completion report.
 *
 * LEGACY / NARROW CONTROL-PLANE RECOVERY:
 * Under simplified Phase 2, worker report FORMAT invalidity alone no longer
 * requires VERIFYING → PLANNING recovery when Radio already has a completed
 * worker, trusted execution identity, and raw result — Phase 2 reviews that
 * raw result via Sol interpret+decide instead.
 *
 * This path remains for backwards compatibility / audit history when a human
 * explicitly authorizes returning to PLANNING after an invalid report.
 *
 * Narrow control-plane operation only:
 * - NEVER runs automatically
 * - NEVER calls OpenAI / Cursor / Bellhop product APIs
 * - NEVER launches a new worker
 * - NEVER executes Sol continuation
 * - NEVER rewrites the invalid report to valid
 *
 * VERIFYING → PLANNING is applied via human control-plane override and is
 * intentionally NOT exposed on LEGAL_TRANSITIONS for Sol.
 */

import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../artifacts/writer.js";
import {
  appendLedgerEvent,
  findLedgerEventByIdempotency,
  readLedgerEvents,
} from "../state/ledger.js";
import { computeStateFingerprint } from "../state/fingerprint.js";
import {
  applyHumanControlPlaneRuntimeState,
  persistProjectState,
} from "../state/mutate.js";
import { loadProjectState } from "../state/store.js";
import type { ProjectState, RunLedgerEvent } from "../types.js";
import { newId, nowIso, resolveRepoPath } from "../util/io.js";

export const RECOVERY_NOTE_PREFIX = "RADIO_HUMAN_INVALID_REPORT_RECOVERY_V1:";
export const RECOVERY_OPERATION = "HUMAN_AUTHORIZED_INVALID_REPORT_RETRY";

export interface Phase2ValidationArtifact {
  ok?: boolean;
  code?: string;
  reportValid?: boolean;
  extractCode?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface RecoverInvalidReportInput {
  projectId: string;
  statePath: string;
  ledgerPath: string;
  /** Explicit human authorization at invocation time. */
  humanAuthorized: boolean;
  /** Expected stateRevision — must match current state. */
  expectedRevision: number;
  /** Phase 2 completion-validation artifact for the rejected worker. */
  validationArtifactPath: string;
  /** Optional run directory for durable recovery artifacts (tests/fixtures). */
  runDir?: string;
  /** Isolate from canonical PROJECT-STATE (always true for fixture CLI). */
  isolateState?: boolean;
}

export type RecoverInvalidReportCode =
  | "RECOVERY_APPLIED"
  | "HUMAN_AUTHORIZATION_REQUIRED"
  | "STALE_REVISION"
  | "WRONG_RUNTIME_STATE"
  | "ACTIVE_AGENT_MISSING"
  | "ACTIVE_AGENT_NOT_COMPLETED"
  | "VALIDATION_ARTIFACT_MISSING"
  | "VALIDATION_NOT_REJECTED"
  | "VALID_REPORT_ALREADY_ACCEPTED"
  | "NEWER_WORKER_ALREADY_LAUNCHED"
  | "RECOVERY_ALREADY_CONSUMED"
  | "TRANSACTION_MISSING";

export interface RecoverInvalidReportResult {
  ok: boolean;
  code: RecoverInvalidReportCode;
  summary: string;
  terminalVerdict:
    | "RADIO_INVALID_REPORT_RECOVERY_APPLIED"
    | "RADIO_INVALID_REPORT_RECOVERY_DENIED";
  stateRevisionBefore: number | null;
  stateRevisionAfter: number | null;
  runtimeStateBefore: string | null;
  runtimeStateAfter: string | null;
  rejectedAgentId: string | null;
  rejectedRunId: string | null;
  rejectedWorkOrderId: string | null;
  cursorCallCount: number;
  openaiCallCount: number;
  bellhopProductMutationCount: number;
  futureRetryAutomaticallyLaunched: boolean;
  state: ProjectState | null;
  artifactPaths: Record<string, string>;
}

/**
 * Apply explicit-human invalid-report recovery, or fail closed.
 */
export function recoverInvalidReport(
  input: RecoverInvalidReportInput,
): RecoverInvalidReportResult {
  const metrics = {
    cursorCallCount: 0,
    openaiCallCount: 0,
    bellhopProductMutationCount: 0,
    futureRetryAutomaticallyLaunched: false,
  };

  const runDir =
    input.runDir ??
    resolveRepoPath("artifacts", "runs", newId("run-recovery"));
  fs.mkdirSync(runDir, { recursive: true });
  const artifactPaths: Record<string, string> = {};

  let statePath = input.statePath;
  let ledgerPath = input.ledgerPath;

  if (input.isolateState) {
    const workingState = path.join(runDir, "PROJECT-STATE.working.json");
    fs.copyFileSync(input.statePath, workingState);
    statePath = workingState;
    ledgerPath = path.join(runDir, "RUN-LEDGER.jsonl");
    if (fs.existsSync(input.ledgerPath)) {
      fs.copyFileSync(input.ledgerPath, ledgerPath);
    } else {
      fs.writeFileSync(ledgerPath, "", "utf8");
    }
  } else {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    if (!fs.existsSync(ledgerPath)) {
      fs.writeFileSync(ledgerPath, "", "utf8");
    }
  }

  artifactPaths.statePath = statePath;
  artifactPaths.ledgerPath = ledgerPath;

  if (!input.humanAuthorized) {
    return deny({
      code: "HUMAN_AUTHORIZATION_REQUIRED",
      summary:
        "Invalid-report recovery requires explicit --human-authorized at invocation time",
      stateRevisionBefore: null,
      runtimeStateBefore: null,
      rejectedAgentId: null,
      rejectedRunId: null,
      rejectedWorkOrderId: null,
      metrics,
      artifactPaths,
      runDir,
      state: null,
    });
  }

  const loaded = loadProjectState({
    projectId: input.projectId,
    statePath,
  });
  let state = loaded.state;
  let fingerprint = loaded.fingerprint;

  if (state.stateRevision !== input.expectedRevision) {
    return deny({
      code: "STALE_REVISION",
      summary: `Expected revision ${input.expectedRevision}, found ${state.stateRevision}`,
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId: state.activeAgent?.agentId ?? null,
      rejectedRunId: null,
      rejectedWorkOrderId:
        typeof state.activeAgent?.workOrderId === "string"
          ? state.activeAgent.workOrderId
          : state.radioRuntime.activeWorkOrderId,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  if (state.radioRuntime.state !== "VERIFYING") {
    return deny({
      code: "WRONG_RUNTIME_STATE",
      summary: `Recovery requires radioRuntime.state=VERIFYING; found ${state.radioRuntime.state}`,
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId: state.activeAgent?.agentId ?? null,
      rejectedRunId: null,
      rejectedWorkOrderId:
        typeof state.activeAgent?.workOrderId === "string"
          ? state.activeAgent.workOrderId
          : state.radioRuntime.activeWorkOrderId,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  if (!state.activeAgent?.agentId) {
    return deny({
      code: "ACTIVE_AGENT_MISSING",
      summary: "Recovery requires a completed activeAgent with durable agentId",
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId: null,
      rejectedRunId: null,
      rejectedWorkOrderId: state.radioRuntime.activeWorkOrderId,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  const agentStatus =
    typeof state.activeAgent.status === "string"
      ? state.activeAgent.status
      : "UNKNOWN";
  if (agentStatus !== "COMPLETED") {
    return deny({
      code: "ACTIVE_AGENT_NOT_COMPLETED",
      summary: `activeAgent.status must be COMPLETED; found ${agentStatus}`,
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId: state.activeAgent.agentId,
      rejectedRunId: null,
      rejectedWorkOrderId:
        typeof state.activeAgent.workOrderId === "string"
          ? state.activeAgent.workOrderId
          : state.radioRuntime.activeWorkOrderId,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  if (!state.currentTransaction) {
    return deny({
      code: "TRANSACTION_MISSING",
      summary: "Recovery requires currentTransaction",
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId: state.activeAgent.agentId,
      rejectedRunId: null,
      rejectedWorkOrderId:
        typeof state.activeAgent.workOrderId === "string"
          ? state.activeAgent.workOrderId
          : null,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  if (!fs.existsSync(input.validationArtifactPath)) {
    return deny({
      code: "VALIDATION_ARTIFACT_MISSING",
      summary: `Phase 2 validation artifact missing: ${input.validationArtifactPath}`,
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId: state.activeAgent.agentId,
      rejectedRunId: null,
      rejectedWorkOrderId:
        typeof state.activeAgent.workOrderId === "string"
          ? state.activeAgent.workOrderId
          : null,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  const validation = JSON.parse(
    fs.readFileSync(input.validationArtifactPath, "utf8"),
  ) as Phase2ValidationArtifact;
  artifactPaths.validationArtifact = input.validationArtifactPath;

  const reportRejected =
    validation.reportValid === false ||
    validation.ok === false ||
    validation.code === "REPORT_INVALID" ||
    (typeof validation.extractCode === "string" &&
      validation.extractCode !== "OK");

  if (!reportRejected) {
    return deny({
      code: "VALIDATION_NOT_REJECTED",
      summary:
        "Invalid-report recovery denied: Phase 2 validation artifact does not show a rejected completion report",
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId: state.activeAgent.agentId,
      rejectedRunId: null,
      rejectedWorkOrderId:
        typeof state.activeAgent.workOrderId === "string"
          ? state.activeAgent.workOrderId
          : null,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  const rejectedAgentId = state.activeAgent.agentId;
  const rejectedWorkOrderId =
    typeof state.activeAgent.workOrderId === "string"
      ? state.activeAgent.workOrderId
      : state.radioRuntime.activeWorkOrderId;
  const rejectedRunId = extractRejectedRunId(state, readLedgerEvents(ledgerPath));

  if (
    hasAcceptedValidReport(ledgerPath, rejectedWorkOrderId, rejectedAgentId)
  ) {
    return deny({
      code: "VALID_REPORT_ALREADY_ACCEPTED",
      summary:
        "A valid completion report was already accepted for this execution; invalid-report recovery denied",
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId,
      rejectedRunId,
      rejectedWorkOrderId,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  if (hasNewerWorkerLaunch(ledgerPath, rejectedAgentId, rejectedWorkOrderId)) {
    return deny({
      code: "NEWER_WORKER_ALREADY_LAUNCHED",
      summary:
        "A newer Cursor worker was already launched after the rejected execution; recovery denied",
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId,
      rejectedRunId,
      rejectedWorkOrderId,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  const idempotencyKey = recoveryIdempotencyKey({
    agentId: rejectedAgentId,
    workOrderId: rejectedWorkOrderId ?? "unknown-wo",
    expectedRevision: input.expectedRevision,
  });

  const prior = findLedgerEventByIdempotency(ledgerPath, idempotencyKey, [
    "RADIO_RECOVERED",
  ]);
  if (prior || notesContainRecovery(state.notes, idempotencyKey)) {
    return deny({
      code: "RECOVERY_ALREADY_CONSUMED",
      summary:
        "Recovery for this rejected execution/revision was already consumed; refusing duplicate recovery",
      stateRevisionBefore: state.stateRevision,
      runtimeStateBefore: state.radioRuntime.state,
      rejectedAgentId,
      rejectedRunId,
      rejectedWorkOrderId,
      metrics,
      artifactPaths,
      runDir,
      state,
    });
  }

  // Durable attribution BEFORE clearing activeAgent.
  const attribution = {
    operation: RECOVERY_OPERATION,
    humanAuthorized: true,
    recoveredAt: nowIso(),
    stateRevisionBefore: state.stateRevision,
    runtimeStateBefore: state.radioRuntime.state,
    rejectedAgentId,
    rejectedRunId,
    rejectedWorkOrderId,
    validationArtifactPath: input.validationArtifactPath,
    validationCode: validation.code ?? validation.extractCode ?? "REPORT_INVALID",
    validationSummary: validation.summary ?? null,
    reportValid: false,
    invalidReportPreserved: true,
    idempotencyKey,
  };
  writeJson(path.join(runDir, "rejected-execution-attribution.json"), attribution);
  artifactPaths.rejectedExecutionAttribution = path.join(
    runDir,
    "rejected-execution-attribution.json",
  );

  const recoveryNote = `${RECOVERY_NOTE_PREFIX}${JSON.stringify({
    idempotencyKey,
    rejectedAgentId,
    rejectedRunId,
    rejectedWorkOrderId,
    stateRevisionBefore: state.stateRevision,
    recoveredAt: attribution.recoveredAt,
  })}`;

  const revisionBefore = state.stateRevision;
  const runtimeBefore = state.radioRuntime.state;
  const currentTransaction = state.currentTransaction;

  // Human control-plane override — not a Sol-legal transition edge.
  state = applyHumanControlPlaneRuntimeState(
    state,
    "PLANNING",
    "RADIO_RECOVERED",
  );
  state = {
    ...state,
    activeAgent: null,
    radioRuntime: {
      ...state.radioRuntime,
      activeWorkOrderId: null,
      // Keep transaction identity so a future separately authorized launch can plan.
      activeTransactionId: currentTransaction.id,
    },
    currentTransaction: {
      ...currentTransaction,
      status: "PLANNING",
    },
    notes: [...state.notes, recoveryNote],
  };

  const persisted = persistProjectState({
    state,
    path: statePath,
    expectedRevision: revisionBefore,
  });
  state = persisted.state;
  fingerprint = persisted.fingerprint;

  appendLedgerEvent({
    ledgerPath,
    eventType: "RADIO_RECOVERED",
    projectId: input.projectId,
    workstreamId: state.activeWorkstream?.id ?? null,
    transactionId: state.currentTransaction?.id ?? null,
    workOrderId: rejectedWorkOrderId,
    decisionId: null,
    agentId: rejectedAgentId,
    stateRevisionBefore: revisionBefore,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey,
    severity: "NOTICE",
    summary:
      "Human-authorized invalid-report recovery: VERIFYING → PLANNING; rejected execution attribution preserved; activeAgent cleared for future separately authorized retry",
    payload: {
      ...attribution,
      runtimeStateAfter: state.radioRuntime.state,
      stateRevisionAfter: state.stateRevision,
      activeAgentCleared: true,
      solCalled: false,
      cursorCalled: false,
      workerLaunched: false,
      controlPlaneOverride: "VERIFYING_TO_PLANNING_HUMAN_ONLY",
    },
  });

  writeJson(path.join(runDir, "recovery-result.json"), {
    ok: true,
    code: "RECOVERY_APPLIED",
    ...attribution,
    stateRevisionAfter: state.stateRevision,
    runtimeStateAfter: state.radioRuntime.state,
  });
  artifactPaths.recoveryResult = path.join(runDir, "recovery-result.json");

  return {
    ok: true,
    code: "RECOVERY_APPLIED",
    summary:
      "Human-authorized invalid-report recovery applied; future retry remains separately authorized",
    terminalVerdict: "RADIO_INVALID_REPORT_RECOVERY_APPLIED",
    stateRevisionBefore: revisionBefore,
    stateRevisionAfter: state.stateRevision,
    runtimeStateBefore: runtimeBefore,
    runtimeStateAfter: state.radioRuntime.state,
    rejectedAgentId,
    rejectedRunId,
    rejectedWorkOrderId,
    cursorCallCount: 0,
    openaiCallCount: 0,
    bellhopProductMutationCount: 0,
    futureRetryAutomaticallyLaunched: false,
    state,
    artifactPaths,
  };
}

export function recoveryIdempotencyKey(input: {
  agentId: string;
  workOrderId: string;
  expectedRevision: number;
}): string {
  return `human-recover-invalid-report:${input.agentId}:${input.workOrderId}:rev${input.expectedRevision}`;
}

function notesContainRecovery(notes: string[], idempotencyKey: string): boolean {
  return notes.some(
    (n) =>
      n.startsWith(RECOVERY_NOTE_PREFIX) && n.includes(idempotencyKey),
  );
}

function hasAcceptedValidReport(
  ledgerPath: string,
  workOrderId: string | null,
  agentId: string,
): boolean {
  const events = readLedgerEvents(ledgerPath);
  return events.some(
    (e) =>
      e.eventType === "CURSOR_REPORT_VALIDATED" &&
      (workOrderId == null || e.workOrderId === workOrderId) &&
      (e.agentId === agentId || e.agentId == null),
  );
}

function hasNewerWorkerLaunch(
  ledgerPath: string,
  rejectedAgentId: string,
  rejectedWorkOrderId: string | null,
): boolean {
  const events = readLedgerEvents(ledgerPath);
  let sawRejectedCreate = false;
  for (const e of events) {
    if (
      e.eventType === "CURSOR_AGENT_CREATED" &&
      e.agentId === rejectedAgentId
    ) {
      sawRejectedCreate = true;
      continue;
    }
    if (
      sawRejectedCreate &&
      e.eventType === "CURSOR_AGENT_CREATED" &&
      e.agentId &&
      e.agentId !== rejectedAgentId
    ) {
      return true;
    }
    if (
      sawRejectedCreate &&
      e.eventType === "CURSOR_AGENT_CREATE_REQUESTED" &&
      rejectedWorkOrderId &&
      e.workOrderId &&
      e.workOrderId !== rejectedWorkOrderId
    ) {
      return true;
    }
  }
  return false;
}

function extractRejectedRunId(
  state: ProjectState,
  events: RunLedgerEvent[],
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (
      e.agentId === state.activeAgent?.agentId &&
      typeof e.payload?.runId === "string"
    ) {
      return e.payload.runId;
    }
  }
  return null;
}

function deny(input: {
  code: RecoverInvalidReportCode;
  summary: string;
  stateRevisionBefore: number | null;
  runtimeStateBefore: string | null;
  rejectedAgentId: string | null;
  rejectedRunId: string | null;
  rejectedWorkOrderId: string | null;
  metrics: {
    cursorCallCount: number;
    openaiCallCount: number;
    bellhopProductMutationCount: number;
    futureRetryAutomaticallyLaunched: boolean;
  };
  artifactPaths: Record<string, string>;
  runDir: string;
  state: ProjectState | null;
}): RecoverInvalidReportResult {
  writeJson(path.join(input.runDir, "recovery-result.json"), {
    ok: false,
    code: input.code,
    summary: input.summary,
    deniedAt: nowIso(),
  });
  input.artifactPaths.recoveryResult = path.join(
    input.runDir,
    "recovery-result.json",
  );
  return {
    ok: false,
    code: input.code,
    summary: input.summary,
    terminalVerdict: "RADIO_INVALID_REPORT_RECOVERY_DENIED",
    stateRevisionBefore: input.stateRevisionBefore,
    stateRevisionAfter: input.stateRevisionBefore,
    runtimeStateBefore: input.runtimeStateBefore,
    runtimeStateAfter: input.runtimeStateBefore,
    rejectedAgentId: input.rejectedAgentId,
    rejectedRunId: input.rejectedRunId,
    rejectedWorkOrderId: input.rejectedWorkOrderId,
    cursorCallCount: input.metrics.cursorCallCount,
    openaiCallCount: input.metrics.openaiCallCount,
    bellhopProductMutationCount: input.metrics.bellhopProductMutationCount,
    futureRetryAutomaticallyLaunched:
      input.metrics.futureRetryAutomaticallyLaunched,
    state: input.state,
    artifactPaths: input.artifactPaths,
  };
}
