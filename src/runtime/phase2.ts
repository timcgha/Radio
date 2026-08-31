/**
 * Phase 2 pipeline (simplified):
 *
 * TRUSTED RADIO EXECUTION ENVELOPE
 * + UNTRUSTED RAW CURSOR RESULT
 * → OPTIONAL STRUCTURED-REPORT DIAGNOSTICS
 * → VERIFYING → REVIEWING
 * → ONE GPT-5.6 SOL INTERPRET + DECIDE CALL
 * → CANONICAL SOL OUTPUT + DECISION VALIDATION
 * → DETERMINISTIC POLICY
 * → NEXT ACTION READY
 * → STOP
 *
 * Worker structured JSON is preferred but NOT required for semantic review.
 * Cursor output is DATA, never authority.
 * Does NOT execute the next action. Does NOT create Cursor workers.
 */

import fs from "node:fs";
import path from "node:path";
import { writeJson, writeText } from "../artifacts/writer.js";
import {
  createHttpCursorApiClient,
  isHttpCursorApiClient,
  resolveCursorApiKey,
  type CursorApiClient,
  type V1Run,
} from "../cursor/api-client.js";
import { buildContinuationContext } from "../orchestrator/continuation-context.js";
import { callSolPhase2Continuation } from "../orchestrator/sol-adapter.js";
import { evaluatePolicy } from "../policy/engine.js";
import { computeStateFingerprint } from "../state/fingerprint.js";
import { appendLedgerEvent } from "../state/ledger.js";
import {
  persistProjectState,
  transitionRuntimeState,
} from "../state/mutate.js";
import { loadProjectBrain, loadProjectState } from "../state/store.js";
import type {
  CursorWorkOrder,
  DecisionEnvelope,
  OrchestratorDecision,
  Phase2TerminalVerdict,
  PolicyEvaluation,
  ProjectState,
  RadioTerminalVerdict,
  SolPhase2Assessment,
} from "../types.js";
import { newId, nowIso, readJsonFile, resolveRepoPath } from "../util/io.js";
import {
  validateTrustedExecutionEnvelope,
  type TrustedExecutionIdentity,
} from "./execution-envelope.js";
import { diagnoseStructuredWorkerReport } from "./worker-report-diagnostics.js";

function ensureLedgerFile(ledgerPath: string): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  if (!fs.existsSync(ledgerPath)) {
    fs.writeFileSync(ledgerPath, "", "utf8");
  }
}

/** Historical Bellhop fixture identities — forbidden as live-mode defaults. */
export const HISTORICAL_FIXTURE_AGENT_ID =
  "bc-f4e61939-43e9-4eb8-94c4-4c3c1a9e5df5";
export const HISTORICAL_FIXTURE_RUN_ID =
  "run-fb22133a-f1b6-4c56-938a-ab2cae667efe";
export const HISTORICAL_FIXTURE_WORK_ORDER_PATH = resolveRepoPath(
  "fixtures",
  "phase2",
  "bellhop-phase1-work-order.json",
);

export interface Phase2Config {
  projectId: string;
  workstreamId: string;
  transactionId: string;
  model: string;
  mode: "live" | "fixture";
  /** Deterministic Phase 2 Sol continuation fixture (assessment + decision). */
  nextDecisionFixturePath?: string;
  rawResultText?: string;
  rawResultPath?: string;
  workOrderPath?: string;
  workOrder?: CursorWorkOrder;
  statePath?: string;
  ledgerPath?: string;
  cursorAgentId?: string | null;
  cursorRunId?: string | null;
  allowReadOnlyCursorRetrieval?: boolean;
  cursorClient?: CursorApiClient;
  isolateState?: boolean;
  /**
   * When true, mutate the caller-provided statePath/ledgerPath in place.
   * Used by Phase 3 to compose Phase 2 without copying into a fresh sandbox.
   * Still never touches canonical checked-in PROJECT-STATE when callers pass
   * an isolated working copy.
   */
  reuseCallerState?: boolean;
  metrics?: Phase2Metrics;
  /** Optional explicit revision binding for stale-state fail-closed tests. */
  expectedStateRevision?: number | null;
  /** Injectable Sol Phase 2 continuation call (tests). */
  solPhase2Call?: typeof callSolPhase2Continuation;
}

export interface Phase2Metrics {
  cursorCreateCalls: number;
  cursorFollowUpCalls: number;
  remediationCalls: number;
  specialistCalls: number;
  solContinuationCalls: number;
}

export interface Phase2Result {
  runId: string;
  terminalVerdict: Phase2TerminalVerdict | RadioTerminalVerdict;
  reportValid: boolean;
  structuredWorkerReportStatus: string | null;
  workOutcome: string | null;
  runtimeState: string;
  stateRevision: number;
  decision: OrchestratorDecision | null;
  assessment: SolPhase2Assessment | null;
  policy: PolicyEvaluation | null;
  cursorCreateCalls: number;
  cursorFollowUpCalls: number;
  solContinuationCalls: number;
  artifactPaths: Record<string, string>;
  state: ProjectState;
  preservedAgentAttribution: {
    agentId: string | null;
    runId: string | null;
    workOrderId: string | null;
  };
}

const DEFAULT_METRICS = (): Phase2Metrics => ({
  cursorCreateCalls: 0,
  cursorFollowUpCalls: 0,
  remediationCalls: 0,
  specialistCalls: 0,
  solContinuationCalls: 0,
});

/**
 * Run Phase 2: trusted envelope → raw evidence → Sol interpret+decide → policy.
 * Never executes next action.
 */
export async function runPhase2(
  config: Phase2Config,
): Promise<Phase2Result> {
  const metrics = config.metrics ?? DEFAULT_METRICS();
  const runId = newId("run");
  const runDir = resolveRepoPath("artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  let statePath =
    config.statePath ??
    resolveRepoPath("projects", config.projectId, "PROJECT-STATE.json");
  let ledgerPath =
    config.ledgerPath ??
    resolveRepoPath("projects", config.projectId, "RUN-LEDGER.jsonl");

  if (config.reuseCallerState) {
    if (!config.statePath || !config.ledgerPath) {
      throw new Error(
        "Phase 2 reuseCallerState requires explicit statePath and ledgerPath",
      );
    }
    // Mutate caller working copies in place (Phase 3 composition).
  } else if (config.mode === "fixture" || config.isolateState) {
    const workingState = path.join(runDir, "PROJECT-STATE.working.json");
    fs.copyFileSync(statePath, workingState);
    statePath = workingState;
    ledgerPath = path.join(runDir, "RUN-LEDGER.jsonl");
  }

  ensureLedgerFile(ledgerPath);

  const loaded = loadProjectState({
    projectId: config.projectId,
    statePath,
  });
  let state = loaded.state;
  let fingerprint = loaded.fingerprint;

  const workOrder = resolveWorkOrder(config, state, runDir);
  const cursorAgentId = resolveAgentId(config, state);
  const cursorRunId = resolveRunId(config, state);

  const preservedAgentAttribution = {
    agentId: cursorAgentId,
    runId: cursorRunId,
    workOrderId: workOrder.workOrderId,
  };

  writeJson(path.join(runDir, "agent-attribution.json"), {
    cursorAgentId,
    cursorRunId,
    workOrderId: workOrder.workOrderId,
    transactionId: workOrder.transactionId,
    source: "radio-owned-execution-identity",
    preservedAt: nowIso(),
  });

  const artifactPaths: Record<string, string> = {
    agentAttribution: path.join(runDir, "agent-attribution.json"),
  };

  // --- Resolve raw result (local or read-only Cursor GET) ---
  let cursorRun: V1Run | null = null;
  let rawResultText: string;
  try {
    const resolved = await resolveRawResult({
      config,
      cursorAgentId,
      cursorRunId,
      metrics,
    });
    rawResultText = resolved.text;
    cursorRun = resolved.cursorRun;
  } catch (err) {
    return finishBlocked({
      runId,
      runDir,
      state,
      fingerprint,
      artifactPaths,
      metrics,
      preservedAgentAttribution,
      verdict: "RADIO_PHASE2_BLOCKED",
      reason: err instanceof Error ? err.message : String(err),
      reportValid: false,
      structuredWorkerReportStatus: null,
      workOutcome: null,
    });
  }

  writeText(path.join(runDir, "raw-cursor-result.txt"), rawResultText);
  writeText(path.join(runDir, "cursor-result.txt"), rawResultText);
  artifactPaths.rawCursorResult = path.join(runDir, "raw-cursor-result.txt");
  artifactPaths.cursorResult = path.join(runDir, "cursor-result.txt");
  if (cursorRun) {
    writeJson(path.join(runDir, "cursor-run-readonly.json"), cursorRun);
    artifactPaths.cursorRunReadonly = path.join(
      runDir,
      "cursor-run-readonly.json",
    );
  }

  // --- Trusted execution envelope (fail closed BEFORE Sol) ---
  const envelope = validateTrustedExecutionEnvelope({
    state,
    fingerprint,
    selectedAgentId: cursorAgentId,
    selectedRunId: cursorRunId,
    workOrder,
    rawResultText,
    cursorRun,
    expectedStateRevision: config.expectedStateRevision ?? null,
  });
  writeJson(path.join(runDir, "execution-envelope.json"), envelope);
  artifactPaths.executionEnvelope = path.join(
    runDir,
    "execution-envelope.json",
  );

  if (!envelope.ok || !envelope.identity) {
    appendLedgerEvent({
      ledgerPath,
      eventType: "RADIO_ERROR",
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      workOrderId: workOrder.workOrderId,
      decisionId: workOrder.decisionId,
      agentId: cursorAgentId,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: `phase2-envelope-fail:${workOrder.workOrderId}:${envelope.code}`,
      severity: "ERROR",
      summary: envelope.summary,
      summaryArtifactRef: artifactPaths.executionEnvelope,
      payload: { code: envelope.code, errors: envelope.errors, phase: 2 },
    });
    return finishBlocked({
      runId,
      runDir,
      state,
      fingerprint,
      artifactPaths,
      metrics,
      preservedAgentAttribution,
      verdict: "RADIO_PHASE2_BLOCKED",
      reason: envelope.summary,
      reportValid: false,
      structuredWorkerReportStatus: null,
      workOutcome: null,
    });
  }

  const trustedIdentity = envelope.identity;

  // --- Optional structured-report diagnostics (NON-BLOCKING for Sol) ---
  const diagnostics = diagnoseStructuredWorkerReport(rawResultText, {
    state,
    workOrder,
    expectedAgentId: trustedIdentity.agentId,
    expectedRunId: trustedIdentity.runId,
  });
  writeJson(path.join(runDir, "completion-extraction.json"), diagnostics.extract);
  artifactPaths.completionExtraction = path.join(
    runDir,
    "completion-extraction.json",
  );
  writeJson(path.join(runDir, "structured-worker-report-diagnostics.json"), {
    status: diagnostics.status,
    reportValid: diagnostics.reportValid,
    diagnosticCodes: diagnostics.diagnosticCodes,
    summary: diagnostics.summary,
    validation: diagnostics.validation,
    note: "Worker report format is diagnostic only; does not block Sol continuation.",
  });
  artifactPaths.structuredWorkerReportDiagnostics = path.join(
    runDir,
    "structured-worker-report-diagnostics.json",
  );

  if (diagnostics.parsedReport) {
    writeJson(path.join(runDir, "completion-report.json"), diagnostics.parsedReport);
    artifactPaths.completionReport = path.join(runDir, "completion-report.json");
  }
  if (diagnostics.validation) {
    writeJson(
      path.join(runDir, "completion-validation.json"),
      diagnostics.validation,
    );
    artifactPaths.completionValidation = path.join(
      runDir,
      "completion-validation.json",
    );
  } else {
    writeJson(path.join(runDir, "completion-validation.json"), {
      ok: false,
      code: diagnostics.extract.code,
      summary: diagnostics.summary,
      reportValid: false,
      note: "Extract failed; treated as diagnostic only",
    });
    artifactPaths.completionValidation = path.join(
      runDir,
      "completion-validation.json",
    );
  }

  // Persist full diagnostic detail in artifacts; ledger gets bounded summary only.
  const diagnosticDetailPath = path.join(
    runDir,
    "structured-report-diagnostic-detail.json",
  );
  writeJson(diagnosticDetailPath, {
    status: diagnostics.status,
    extract: diagnostics.extract,
    validation: diagnostics.validation,
    diagnosticCodes: diagnostics.diagnosticCodes,
    summary: diagnostics.summary,
  });
  artifactPaths.structuredReportDiagnosticDetail = diagnosticDetailPath;

  if (diagnostics.reportValid) {
    appendLedgerEvent({
      ledgerPath,
      eventType: "CURSOR_REPORT_VALIDATED",
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      workOrderId: workOrder.workOrderId,
      decisionId: workOrder.decisionId,
      agentId: trustedIdentity.agentId,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: `phase2-report-validated:${workOrder.workOrderId}`,
      severity: "INFO",
      summary: "Structured worker report VALID (supplemental evidence for Sol)",
      payload: {
        reportValid: true,
        structuredWorkerReportStatus: diagnostics.status,
        workOutcome: diagnostics.validation?.workOutcome ?? null,
        cursorRunId: trustedIdentity.runId,
        phase: 2,
      },
    });
  } else {
    appendLedgerEvent({
      ledgerPath,
      eventType: "CURSOR_REPORT_SCHEMA_REJECTED",
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      workOrderId: workOrder.workOrderId,
      decisionId: workOrder.decisionId,
      agentId: trustedIdentity.agentId,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: `phase2-report-diag:${workOrder.workOrderId}:${diagnostics.status}`,
      severity: "WARNING",
      summary: `Structured worker report ${diagnostics.status}; Sol continuation proceeds with raw untrusted evidence`,
      summaryArtifactRef: diagnosticDetailPath,
      payload: {
        reportValid: false,
        structuredWorkerReportStatus: diagnostics.status,
        diagnosticCodes: diagnostics.diagnosticCodes,
        blocking: false,
        phase: 2,
      },
    });
  }

  // --- VERIFYING → REVIEWING after trusted envelope + raw acquisition ---
  const revisionBefore = state.stateRevision;
  state = transitionRuntimeState(
    state,
    "REVIEWING",
    "TRUSTED_EXECUTION_ENVELOPE_VERIFIED",
  );
  if (state.currentTransaction) {
    state = {
      ...state,
      currentTransaction: {
        ...state.currentTransaction,
        status: "REVIEWING",
      },
    };
  }

  const completedAgent = state.activeAgent;
  writeJson(path.join(runDir, "completed-agent-snapshot.json"), {
    activeAgent: completedAgent,
    cursorRunId: trustedIdentity.runId,
    clearedAfterEnvelopeVerification: true,
    structuredWorkerReportStatus: diagnostics.status,
    clearedAt: nowIso(),
  });
  artifactPaths.completedAgentSnapshot = path.join(
    runDir,
    "completed-agent-snapshot.json",
  );
  // Preserve Radio-owned identity in attribution artifact before clearing.
  state = { ...state, activeAgent: null };

  const persisted = persistProjectState({
    state,
    path: statePath,
    expectedRevision: revisionBefore,
  });
  state = persisted.state;
  fingerprint = persisted.fingerprint;

  appendLedgerEvent({
    ledgerPath,
    eventType: "PROJECT_STATE_UPDATED",
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    workOrderId: workOrder.workOrderId,
    decisionId: workOrder.decisionId,
    agentId: trustedIdentity.agentId,
    stateRevisionBefore: revisionBefore,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: `phase2-state-reviewing:${workOrder.workOrderId}:${state.stateRevision}`,
    severity: "INFO",
    summary:
      "VERIFYING → REVIEWING after trusted execution envelope + raw result; structured report validity not required",
    payload: {
      runtimeState: state.radioRuntime.state,
      transactionStatus: state.currentTransaction?.status ?? null,
      preservedAgentId: trustedIdentity.agentId,
      preservedRunId: trustedIdentity.runId,
      structuredWorkerReportStatus: diagnostics.status,
      phase: 2,
    },
  });

  writeJson(path.join(runDir, "completion-reconciliation.json"), {
    ok: true,
    trustedEnvelopeOk: true,
    reportValid: diagnostics.reportValid,
    structuredWorkerReportStatus: diagnostics.status,
    workOutcome: diagnostics.validation?.workOutcome ?? null,
    workOutcomeDetail: diagnostics.validation?.workOutcomeDetail ?? null,
    sourceIntegrity: diagnostics.validation?.sourceIntegrity ?? null,
    runtimeStateBefore: "VERIFYING",
    runtimeStateAfter: state.radioRuntime.state,
    transactionStatusAfter: state.currentTransaction?.status ?? null,
    stateRevision: state.stateRevision,
    activeAgentClearedAfterAttribution: true,
    preservedAgentId: trustedIdentity.agentId,
    preservedRunId: trustedIdentity.runId,
  });
  artifactPaths.completionReconciliation = path.join(
    runDir,
    "completion-reconciliation.json",
  );

  // --- Bounded context + exactly one Sol interpret+decide call ---
  const brain = loadProjectBrain(config.projectId);
  const { context, artifact: continuationArtifact } = buildContinuationContext({
    brain: { ...brain, state, fingerprint },
    state,
    fingerprint,
    workOrder,
    trustedIdentity,
    diagnostics,
    rawResultText,
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
  });
  writeJson(path.join(runDir, "continuation-context.json"), continuationArtifact);
  artifactPaths.continuationContext = path.join(
    runDir,
    "continuation-context.json",
  );

  metrics.solContinuationCalls += 1;
  if (metrics.solContinuationCalls !== 1) {
    throw new Error("Phase 2 permits exactly one Sol continuation call");
  }

  appendLedgerEvent({
    ledgerPath,
    eventType: "SOL_DECISION_REQUESTED",
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    workOrderId: workOrder.workOrderId,
    decisionId: null,
    agentId: trustedIdentity.agentId,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: `phase2-sol-request:${workOrder.workOrderId}:${state.stateRevision}`,
    severity: "INFO",
    summary: "Phase 2 Sol interpret+decide continuation requested",
    payload: {
      phase: 2,
      runtimeState: state.radioRuntime.state,
      structuredWorkerReportStatus: diagnostics.status,
    },
  });

  let sol;
  const solPhase2Call = config.solPhase2Call ?? callSolPhase2Continuation;
  try {
    sol = await solPhase2Call({
      context,
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      currentRuntimeState: state.radioRuntime.state,
      model: config.model,
      mode: config.mode,
      fixturePath: config.nextDecisionFixturePath,
    });
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    const solErrorPath = path.join(runDir, "sol-continuation-error.json");
    writeJson(solErrorPath, { error: errText, at: nowIso() });
    artifactPaths.solContinuationError = solErrorPath;
    appendLedgerEvent({
      ledgerPath,
      eventType: "RADIO_ERROR",
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      workOrderId: workOrder.workOrderId,
      decisionId: null,
      agentId: trustedIdentity.agentId,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: `phase2-sol-error:${workOrder.workOrderId}`,
      severity: "ERROR",
      summary: errText,
      summaryArtifactRef: solErrorPath,
      payload: { phase: 2 },
    });
    writePhase2Summary(runDir, artifactPaths, {
      terminalVerdict: "RADIO_PHASE2_BLOCKED",
      reportValid: diagnostics.reportValid,
      structuredWorkerReportStatus: diagnostics.status,
      runtimeState: state.radioRuntime.state,
      solContinuationCalls: metrics.solContinuationCalls,
    });
    return {
      runId,
      terminalVerdict: "RADIO_PHASE2_BLOCKED",
      reportValid: diagnostics.reportValid,
      structuredWorkerReportStatus: diagnostics.status,
      workOutcome: diagnostics.validation?.workOutcomeDetail ?? null,
      runtimeState: state.radioRuntime.state,
      stateRevision: state.stateRevision,
      decision: null,
      assessment: null,
      policy: null,
      cursorCreateCalls: metrics.cursorCreateCalls,
      cursorFollowUpCalls: metrics.cursorFollowUpCalls,
      solContinuationCalls: metrics.solContinuationCalls,
      artifactPaths,
      state,
      preservedAgentAttribution,
    };
  }

  writeJson(path.join(runDir, "sol-assessment.json"), {
    ...sol.assessment,
    classification: "MODEL_INTERPRETATION_OF_UNTRUSTED_WORKER_EVIDENCE",
    notValidatedWorkerTruth: true,
  });
  artifactPaths.solAssessment = path.join(runDir, "sol-assessment.json");
  writeJson(path.join(runDir, "sol-continuation.json"), sol.continuation);
  artifactPaths.solContinuation = path.join(runDir, "sol-continuation.json");
  writeJson(path.join(runDir, "next-decision.json"), sol.decision);
  artifactPaths.nextDecision = path.join(runDir, "next-decision.json");

  const decisionEnvelope: DecisionEnvelope = {
    schemaVersion: "phase0-1.0",
    decisionId: sol.decision.decisionId,
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    stateRevision: state.stateRevision,
    requestFingerprint: fingerprint,
    model: sol.model,
    mode: sol.mode,
    generatedAt: nowIso(),
    cursorExecutionEnabled: false,
    notes: [
      "Phase 2 continuation decision — not executed.",
      "Fingerprint bound to post-REVIEWING state revision.",
      "Sol assessment is model interpretation of untrusted worker evidence.",
      ...sol.schemaCompatNotes,
    ],
  };
  writeJson(path.join(runDir, "next-decision-envelope.json"), decisionEnvelope);
  artifactPaths.nextDecisionEnvelope = path.join(
    runDir,
    "next-decision-envelope.json",
  );

  appendLedgerEvent({
    ledgerPath,
    eventType: "SOL_DECISION_RECEIVED",
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    workOrderId: workOrder.workOrderId,
    decisionId: sol.decision.decisionId,
    agentId: trustedIdentity.agentId,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: `phase2-sol-received:${sol.decision.decisionId}`,
    severity: "INFO",
    summary: `Sol continuation decision: ${sol.decision.decision} (assessment=${sol.assessment.resultClass})`,
    payload: {
      decision: sol.decision.decision,
      assessmentResultClass: sol.assessment.resultClass,
      structuredWorkerReportStatus: diagnostics.status,
      phase: 2,
      executed: false,
    },
  });

  const policy = evaluatePolicy({
    decision: sol.decision,
    state,
    envelope: decisionEnvelope,
    currentFingerprint: fingerprint,
  });
  writeJson(path.join(runDir, "next-policy-evaluation.json"), policy);
  artifactPaths.nextPolicyEvaluation = path.join(
    runDir,
    "next-policy-evaluation.json",
  );

  appendLedgerEvent({
    ledgerPath,
    eventType: "POLICY_EVALUATION_COMPLETED",
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    workOrderId: workOrder.workOrderId,
    decisionId: sol.decision.decisionId,
    agentId: trustedIdentity.agentId,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: `phase2-policy:${sol.decision.decisionId}`,
    severity: "INFO",
    summary: `Phase 2 policy result: ${policy.result} (${policy.primaryCode})`,
    payload: {
      result: policy.result,
      primaryCode: policy.primaryCode,
      executionPermitted: policy.executionPermitted,
      phase: 2,
      nextActionExecuted: false,
      cursorCreateCalls: metrics.cursorCreateCalls,
    },
  });

  assertNoPhase3Execution(metrics);

  writePhase2Summary(runDir, artifactPaths, {
    terminalVerdict: "RADIO_PHASE2_NEXT_ACTION_READY",
    reportValid: diagnostics.reportValid,
    structuredWorkerReportStatus: diagnostics.status,
    workOutcome: diagnostics.validation?.workOutcome ?? null,
    workOutcomeDetail: diagnostics.validation?.workOutcomeDetail ?? null,
    assessmentResultClass: sol.assessment.resultClass,
    runtimeState: state.radioRuntime.state,
    nextDecision: sol.decision.decision,
    policyResult: policy.result,
    solContinuationCalls: metrics.solContinuationCalls,
    cursorCreateCalls: metrics.cursorCreateCalls,
  });

  return {
    runId,
    terminalVerdict: "RADIO_PHASE2_NEXT_ACTION_READY",
    reportValid: diagnostics.reportValid,
    structuredWorkerReportStatus: diagnostics.status,
    workOutcome: diagnostics.validation?.workOutcomeDetail ?? null,
    runtimeState: state.radioRuntime.state,
    stateRevision: state.stateRevision,
    decision: sol.decision,
    assessment: sol.assessment,
    policy,
    cursorCreateCalls: metrics.cursorCreateCalls,
    cursorFollowUpCalls: metrics.cursorFollowUpCalls,
    solContinuationCalls: metrics.solContinuationCalls,
    artifactPaths,
    state,
    preservedAgentAttribution: {
      agentId: trustedIdentity.agentId,
      runId: trustedIdentity.runId,
      workOrderId: trustedIdentity.workOrderId,
    },
  };
}

function assertNoPhase3Execution(metrics: Phase2Metrics): void {
  if (metrics.cursorCreateCalls !== 0) {
    throw new Error("Phase 2 violated boundary: Cursor create was attempted");
  }
  if (metrics.cursorFollowUpCalls !== 0) {
    throw new Error("Phase 2 violated boundary: Cursor follow-up was attempted");
  }
  if (metrics.remediationCalls !== 0) {
    throw new Error("Phase 2 violated boundary: remediation was attempted");
  }
  if (metrics.specialistCalls !== 0) {
    throw new Error("Phase 2 violated boundary: specialist call was attempted");
  }
}

function resolveAgentId(
  config: Phase2Config,
  state: ProjectState,
): string | null {
  if (typeof config.cursorAgentId === "string" && config.cursorAgentId.trim()) {
    return config.cursorAgentId.trim();
  }
  if (typeof state.activeAgent?.agentId === "string") {
    return state.activeAgent.agentId;
  }
  return null;
}

function resolveRunId(
  config: Phase2Config,
  state: ProjectState,
): string | null {
  if (typeof config.cursorRunId === "string" && config.cursorRunId.trim()) {
    return config.cursorRunId.trim();
  }
  if (
    typeof state.activeAgent?.runId === "string" &&
    state.activeAgent.runId.trim()
  ) {
    return state.activeAgent.runId.trim();
  }
  return null;
}

/**
 * Resolve work order without silently substituting historical fixture IDs in live mode.
 */
export function resolveWorkOrder(
  config: Phase2Config,
  state: ProjectState,
  runDir: string,
): CursorWorkOrder {
  if (config.workOrder) {
    writeJson(path.join(runDir, "work-order.json"), config.workOrder);
    return config.workOrder;
  }
  if (config.workOrderPath) {
    const workOrder = readJsonFile<CursorWorkOrder>(config.workOrderPath);
    writeJson(path.join(runDir, "work-order.json"), workOrder);
    return workOrder;
  }

  if (config.mode === "fixture") {
    const workOrder = readJsonFile<CursorWorkOrder>(
      HISTORICAL_FIXTURE_WORK_ORDER_PATH,
    );
    writeJson(path.join(runDir, "work-order.json"), workOrder);
    return workOrder;
  }

  // Live mode: never fall back to historical fixture work order.
  const envPath = process.env.RADIO_PHASE2_WORK_ORDER_PATH?.trim();
  if (envPath) {
    const workOrder = readJsonFile<CursorWorkOrder>(envPath);
    writeJson(path.join(runDir, "work-order.json"), workOrder);
    return workOrder;
  }

  const fromState = buildTrustedWorkOrderFromRadioState(state);
  writeJson(path.join(runDir, "work-order.json"), fromState);
  writeJson(path.join(runDir, "work-order-source.json"), {
    source: "radio-owned-state-derived",
    note: "Live Phase 2 derived trusted work-order context from Radio state; not a historical fixture.",
  });
  return fromState;
}

/**
 * Build a trusted work-order context from Radio-owned state for live Phase 2.
 * Does not invent worker-reported facts.
 */
export function buildTrustedWorkOrderFromRadioState(
  state: ProjectState,
): CursorWorkOrder {
  const workOrderId = state.radioRuntime.activeWorkOrderId;
  if (!workOrderId) {
    throw new Error(
      "Live Phase 2 cannot determine workOrderId from Radio state (radioRuntime.activeWorkOrderId missing). Provide RADIO_PHASE2_WORK_ORDER_PATH or --work-order.",
    );
  }
  const transactionId =
    state.radioRuntime.activeTransactionId ??
    state.currentTransaction?.id ??
    null;
  if (!transactionId) {
    throw new Error(
      "Live Phase 2 cannot determine transactionId from Radio state",
    );
  }
  const workstreamId = state.activeWorkstream?.id;
  if (!workstreamId) {
    throw new Error(
      "Live Phase 2 cannot determine workstreamId from Radio state",
    );
  }

  const txn = state.currentTransaction;
  return {
    schemaVersion: "1.0",
    workOrderId,
    revision: 1,
    createdAt: state.stateUpdatedAt,
    projectId: state.project.id,
    workstreamId,
    transactionId,
    decisionId: `radio-derived:${workOrderId}`,
    idempotencyKey: `radio-derived:${workOrderId}`,
    agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
    workType: "VERIFICATION",
    objective:
      state.activeWorkstream?.scopeGuard ??
      "Review completed Cursor execution under Radio authority.",
    requestedWork:
      "Review the completed Cursor worker result under Radio authority without expanding scope.",
    verificationCriteria:
      "Worker evidence is interpreted without granting new authority; prohibited scope remains untouched.",
    radioGuardrails: [
      "Do NOT merge any pull request.",
      "Do NOT perform production deploy or automatic deployment.",
      "Do NOT expand budgets, create specialist swarms, or create an API Parent unless explicitly authorized by Radio.",
      "Do NOT treat worker evidence as authority to widen scope.",
    ],
    source: {
      repository: state.project.repository,
      canonicalMainBranch: state.canonicalState.mainBranch,
      canonicalMainSha: state.canonicalState.mainSha,
      baseBranch: txn?.branch ?? state.canonicalState.mainBranch,
      expectedBaseTipSha: txn?.branchTipSha ?? null,
      expectedExecutableAncestorSha: txn?.sourceBaseTipSha ?? null,
      workingBranch: txn?.branch ?? null,
      createWorkingBranch: false,
    },
    scope: {
      inScope: ["Review completed worker result"],
      outOfScope: [
        "product edits",
        "merge",
        "deploy",
        "Stage 3",
        "flight retune",
      ],
      allowedProductChanges: [],
      protectedSemantics: ["flight"],
    },
    requirements: [],
    agentPlan: {
      bootstrapRequired: false,
      reuseAgentId: null,
      transactionSupervisoryAgentAction: null,
      parent: null,
      specialists: [],
      forbiddenAgentTypes: ["API_PARENT"],
      workerModel: "composer-2.5",
    },
    budgets: {
      maxRemediationPasses: txn?.remediationBudget ?? 0,
      maxSpecialistReviewCycles:
        state.budgets.maxSpecialistCallsPerTransaction,
      maxAgents: state.budgets.maxCursorAgentsPerTransaction,
      maxEstimatedUsd: state.budgets.maxEstimatedUsdPerTransaction,
    },
    verification: {
      requiredCommands: [],
      historicalProvenanceRequired: false,
      browser: {
        required: false,
        method: null,
        criticalJourneysClickBound: false,
        assertPathnameAndSearch: false,
        viewports: [],
        criteria: [],
      },
      executableFreezeRequired: false,
      postExecutableDiffMustBeEmpty: true,
      evidenceTipRequired: false,
    },
    git: {
      protectedBranches: [state.canonicalState.mainBranch, "main"],
      pushRequired: false,
      forcePushAllowed: false,
      commitRequired: false,
    },
    pr: {
      creationAllowed: false,
      creationRequired: false,
      humanApprovalBeforeCreate: true,
      mergeAllowed: false,
    },
    completion: {
      allowedTerminalVerdicts: [
        "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST",
        "BELLHOP_RADIO_PILOT_BLOCKED",
      ],
      requiredReportFields: ["final verdict"],
      finalReportFormat: "EXACTLY_ONE_FENCED_TEXT_BLOCK_NOTHING_BEFORE_OR_AFTER",
    },
    stopConditions: [],
    rendering: {
      agentActionMustAppearNearTop: true,
      includeStructuredIdentity: true,
      includeSourcePins: true,
      includeScope: true,
      includeBudgets: true,
      includeStopConditions: true,
      includeCompletionContract: true,
    },
  };
}

async function resolveRawResult(input: {
  config: Phase2Config;
  cursorAgentId: string | null;
  cursorRunId: string | null;
  metrics: Phase2Metrics;
}): Promise<{ text: string; cursorRun: V1Run | null }> {
  const { config, cursorAgentId, cursorRunId } = input;
  if (typeof config.rawResultText === "string") {
    return { text: config.rawResultText, cursorRun: null };
  }
  if (config.rawResultPath) {
    return {
      text: fs.readFileSync(config.rawResultPath, "utf8"),
      cursorRun: null,
    };
  }
  if (config.mode === "fixture") {
    // Primary fixture demonstrates SCHEMA_INVALID path (architectural simplification).
    const fixturePath = resolveRepoPath(
      "fixtures",
      "phase2",
      "bellhop-schema-invalid-raw-result.txt",
    );
    return {
      text: fs.readFileSync(fixturePath, "utf8"),
      cursorRun: null,
    };
  }

  if (
    config.allowReadOnlyCursorRetrieval &&
    cursorAgentId &&
    cursorRunId
  ) {
    const client =
      config.cursorClient ??
      (() => {
        const key = resolveCursorApiKey();
        if (!key) {
          throw new Error(
            "CURSOR_API_KEY required for read-only Phase 2 run retrieval",
          );
        }
        return createHttpCursorApiClient({ apiKey: key });
      })();

    void isHttpCursorApiClient;
    const run = await client.getRun(cursorAgentId, cursorRunId);
    return {
      text: typeof run.result === "string" ? run.result : "",
      cursorRun: run,
    };
  }

  throw new Error(
    "Phase 2 requires rawResultText, rawResultPath, fixture mode, or read-only Cursor retrieval with agentId+runId",
  );
}

function finishBlocked(input: {
  runId: string;
  runDir: string;
  state: ProjectState;
  fingerprint: string;
  artifactPaths: Record<string, string>;
  metrics: Phase2Metrics;
  preservedAgentAttribution: Phase2Result["preservedAgentAttribution"];
  verdict: Phase2TerminalVerdict;
  reason: string;
  reportValid: boolean;
  structuredWorkerReportStatus: string | null;
  workOutcome: string | null;
}): Phase2Result {
  writeJson(path.join(input.runDir, "phase2-blocked.json"), {
    reason: input.reason,
    verdict: input.verdict,
  });
  writePhase2Summary(input.runDir, input.artifactPaths, {
    terminalVerdict: input.verdict,
    reportValid: input.reportValid,
    structuredWorkerReportStatus: input.structuredWorkerReportStatus,
    runtimeState: input.state.radioRuntime.state,
    solContinuationCalls: input.metrics.solContinuationCalls,
    reason: input.reason,
  });
  return {
    runId: input.runId,
    terminalVerdict: input.verdict,
    reportValid: input.reportValid,
    structuredWorkerReportStatus: input.structuredWorkerReportStatus,
    workOutcome: input.workOutcome,
    runtimeState: input.state.radioRuntime.state,
    stateRevision: input.state.stateRevision,
    decision: null,
    assessment: null,
    policy: null,
    cursorCreateCalls: input.metrics.cursorCreateCalls,
    cursorFollowUpCalls: input.metrics.cursorFollowUpCalls,
    solContinuationCalls: input.metrics.solContinuationCalls,
    artifactPaths: input.artifactPaths,
    state: input.state,
    preservedAgentAttribution: input.preservedAgentAttribution,
  };
}

function writePhase2Summary(
  runDir: string,
  artifactPaths: Record<string, string>,
  summary: Record<string, unknown>,
): void {
  const p = path.join(runDir, "phase2-summary.json");
  writeJson(p, {
    ...summary,
    nextActionExecuted: false,
    phase: 2,
    generatedAt: nowIso(),
  });
  artifactPaths.phase2Summary = p;
}

/** Planning-seed path for Phase 0/1 regression isolation. */
export function bellhopPlanningSeedPath(): string {
  return resolveRepoPath("fixtures", "state", "bellhop-planning-seed.json");
}

export { ensureLedgerFile, computeStateFingerprint };
export type { TrustedExecutionIdentity };
