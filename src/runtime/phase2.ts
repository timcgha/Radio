/**
 * Phase 2 pipeline:
 * RAW CURSOR RESULT
 * → STRICT COMPLETION-REPORT EXTRACTION
 * → CANONICAL SCHEMA VALIDATION
 * → WORK-ORDER / AGENT / SOURCE BINDING
 * → DETERMINISTIC EVIDENCE RECONCILIATION
 * → VERIFYING → REVIEWING
 * → BOUNDED SOL CONTINUATION
 * → ONE GPT-5.6 SOL NEXT-ACTION DECISION
 * → CANONICAL DECISION VALIDATION
 * → DETERMINISTIC POLICY
 * → NEXT ACTION READY
 * → STOP
 *
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
} from "../cursor/api-client.js";
import { extractCompletionReport } from "../cursor/completion-parser.js";
import { validateCompletionReport } from "../cursor/completion-validator.js";
import { buildContinuationContext } from "../orchestrator/continuation-context.js";
import { callSol } from "../orchestrator/sol-adapter.js";
import { evaluatePolicy } from "../policy/engine.js";
import { computeStateFingerprint } from "../state/fingerprint.js";
import { appendLedgerEvent } from "../state/ledger.js";
import {
  persistProjectState,
  transitionRuntimeState,
} from "../state/mutate.js";
import { loadBellhopBrain, loadProjectState } from "../state/store.js";
import type {
  CursorWorkOrder,
  DecisionEnvelope,
  OrchestratorDecision,
  Phase2TerminalVerdict,
  PolicyEvaluation,
  ProjectState,
  RadioTerminalVerdict,
} from "../types.js";
import { newId, nowIso, readJsonFile, resolveRepoPath } from "../util/io.js";

function ensureLedgerFile(ledgerPath: string): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  if (!fs.existsSync(ledgerPath)) {
    fs.writeFileSync(ledgerPath, "", "utf8");
  }
}

export interface Phase2Config {
  projectId: string;
  workstreamId: string;
  transactionId: string;
  model: string;
  mode: "live" | "fixture";
  /** Deterministic next-decision fixture (no OpenAI). */
  nextDecisionFixturePath?: string;
  /** Raw Cursor result text, or load from path / retrieve read-only. */
  rawResultText?: string;
  rawResultPath?: string;
  workOrderPath?: string;
  workOrder?: CursorWorkOrder;
  statePath?: string;
  ledgerPath?: string;
  /** Phase 1 agent/run identity for replay / binding. */
  cursorAgentId?: string | null;
  cursorRunId?: string | null;
  /** Read-only Cursor retrieval of an already completed run (no POST). */
  allowReadOnlyCursorRetrieval?: boolean;
  /** Injected client for tests. Must not be used to create agents in Phase 2. */
  cursorClient?: CursorApiClient;
  /** Isolate fixture from checked-in PROJECT-STATE.json */
  isolateState?: boolean;
  /** Count external create/follow-up attempts (must remain 0). */
  metrics?: Phase2Metrics;
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
  workOutcome: string | null;
  runtimeState: string;
  stateRevision: number;
  decision: OrchestratorDecision | null;
  policy: PolicyEvaluation | null;
  cursorCreateCalls: number;
  cursorFollowUpCalls: number;
  solContinuationCalls: number;
  artifactPaths: Record<string, string>;
  state: ProjectState;
  /** Cleared activeAgent attribution preserved here when state clears it. */
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
 * Run Phase 2 ingestion + validation + Sol continuation. Never executes next action.
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

  if (config.mode === "fixture" || config.isolateState) {
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

  const workOrder = resolveWorkOrder(config, runDir);
  const cursorAgentId =
    config.cursorAgentId ??
    (typeof state.activeAgent?.agentId === "string"
      ? state.activeAgent.agentId
      : null);
  let cursorRunId = config.cursorRunId ?? null;

  // --- Resolve raw result (local artifact or read-only Cursor GET) ---
  const rawResultText = await resolveRawResult({
    config,
    cursorAgentId,
    cursorRunId,
    metrics,
  });
  writeText(path.join(runDir, "raw-cursor-result.txt"), rawResultText);
  // Compatibility alias with Phase 1 naming
  writeText(path.join(runDir, "cursor-result.txt"), rawResultText);

  const artifactPaths: Record<string, string> = {
    rawCursorResult: path.join(runDir, "raw-cursor-result.txt"),
    cursorResult: path.join(runDir, "cursor-result.txt"),
  };

  const preservedAgentAttribution = {
    agentId: cursorAgentId,
    runId: cursorRunId,
    workOrderId: workOrder.workOrderId,
  };

  // Persist attribution early so it survives even invalid-report paths.
  writeJson(path.join(runDir, "agent-attribution.json"), {
    cursorAgentId,
    cursorRunId,
    workOrderId: workOrder.workOrderId,
    transactionId: workOrder.transactionId,
    preservedAt: nowIso(),
  });
  artifactPaths.agentAttribution = path.join(runDir, "agent-attribution.json");

  // Runtime must be VERIFYING for Phase 2 continuation of Phase 1.
  if (state.radioRuntime.state !== "VERIFYING") {
    const blocked = finishBlocked({
      runId,
      runDir,
      state,
      fingerprint,
      artifactPaths,
      metrics,
      preservedAgentAttribution,
      verdict: "RADIO_PHASE2_BLOCKED",
      reason: `Phase 2 requires radioRuntime.state=VERIFYING; found ${state.radioRuntime.state}`,
      reportValid: false,
      workOutcome: null,
    });
    return blocked;
  }

  // --- Extract ---
  const extracted = extractCompletionReport(rawResultText);
  writeJson(path.join(runDir, "completion-extraction.json"), extracted);
  artifactPaths.completionExtraction = path.join(
    runDir,
    "completion-extraction.json",
  );

  if (!extracted.ok || !extracted.report) {
    appendLedgerEvent({
      ledgerPath,
      eventType: "CURSOR_REPORT_SCHEMA_REJECTED",
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      workOrderId: workOrder.workOrderId,
      decisionId: workOrder.decisionId,
      agentId: cursorAgentId,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: `phase2-extract-fail:${workOrder.workOrderId}`,
      severity: "ERROR",
      summary: extracted.summary,
      payload: { code: extracted.code, phase: 2 },
    });
    writeJson(path.join(runDir, "completion-validation.json"), {
      ok: false,
      code: "REPORT_INVALID",
      extractCode: extracted.code,
      summary: extracted.summary,
      reportValid: false,
    });
    artifactPaths.completionValidation = path.join(
      runDir,
      "completion-validation.json",
    );
    writePhase2Summary(runDir, artifactPaths, {
      terminalVerdict: "RADIO_PHASE2_REPORT_INVALID",
      reportValid: false,
      runtimeState: state.radioRuntime.state,
      solContinuationCalls: 0,
    });
    return {
      runId,
      terminalVerdict: "RADIO_PHASE2_REPORT_INVALID",
      reportValid: false,
      workOutcome: null,
      runtimeState: state.radioRuntime.state,
      stateRevision: state.stateRevision,
      decision: null,
      policy: null,
      cursorCreateCalls: metrics.cursorCreateCalls,
      cursorFollowUpCalls: metrics.cursorFollowUpCalls,
      solContinuationCalls: metrics.solContinuationCalls,
      artifactPaths,
      state,
      preservedAgentAttribution,
    };
  }

  writeJson(path.join(runDir, "completion-report.json"), extracted.report);
  artifactPaths.completionReport = path.join(runDir, "completion-report.json");

  // --- Validate + bind + reconcile ---
  const validation = validateCompletionReport(extracted.report, {
    state,
    workOrder,
    expectedAgentId: cursorAgentId,
    expectedRunId: cursorRunId,
  });
  writeJson(path.join(runDir, "completion-validation.json"), validation);
  artifactPaths.completionValidation = path.join(
    runDir,
    "completion-validation.json",
  );

  if (!validation.ok) {
    const eventType =
      validation.code === "SCHEMA_INVALID"
        ? "CURSOR_REPORT_SCHEMA_REJECTED"
        : "RADIO_ERROR";
    appendLedgerEvent({
      ledgerPath,
      eventType,
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      workOrderId: workOrder.workOrderId,
      decisionId: workOrder.decisionId,
      agentId: cursorAgentId,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: `phase2-validate-fail:${workOrder.workOrderId}:${validation.code}`,
      severity: "ERROR",
      summary: validation.summary,
      payload: { code: validation.code, errors: validation.errors, phase: 2 },
    });

    const verdict =
      validation.code === "IDENTITY_BINDING_FAILED" ||
      validation.code === "EVIDENCE_INCONSISTENT"
        ? "RADIO_PHASE2_RECONCILIATION_BLOCKED"
        : "RADIO_PHASE2_REPORT_INVALID";

    writeJson(path.join(runDir, "completion-reconciliation.json"), {
      ok: false,
      code: validation.code,
      sourceIntegrity: validation.sourceIntegrity,
      errors: validation.errors,
      runtimeStateUnchanged: state.radioRuntime.state,
    });
    artifactPaths.completionReconciliation = path.join(
      runDir,
      "completion-reconciliation.json",
    );
    writePhase2Summary(runDir, artifactPaths, {
      terminalVerdict: verdict,
      reportValid: false,
      runtimeState: state.radioRuntime.state,
      solContinuationCalls: 0,
    });

    return {
      runId,
      terminalVerdict: verdict,
      reportValid: false,
      workOutcome: validation.workOutcomeDetail,
      runtimeState: state.radioRuntime.state,
      stateRevision: state.stateRevision,
      decision: null,
      policy: null,
      cursorCreateCalls: metrics.cursorCreateCalls,
      cursorFollowUpCalls: metrics.cursorFollowUpCalls,
      solContinuationCalls: metrics.solContinuationCalls,
      artifactPaths,
      state,
      preservedAgentAttribution,
    };
  }

  // Valid report — ledger CURSOR_REPORT_VALIDATED (distinct from Phase 1 RECEIVED).
  appendLedgerEvent({
    ledgerPath,
    eventType: "CURSOR_REPORT_VALIDATED",
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    workOrderId: workOrder.workOrderId,
    decisionId: workOrder.decisionId,
    agentId: cursorAgentId,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: `phase2-report-validated:${workOrder.workOrderId}`,
    severity: "INFO",
    summary: "Completion report schema+identity+evidence validated",
    payload: {
      reportValid: true,
      workOutcome: validation.workOutcome,
      workOutcomeDetail: validation.workOutcomeDetail,
      sourceIntegrity: validation.sourceIntegrity,
      cursorRunId,
      phase: 2,
    },
  });

  // --- State reconciliation: VERIFYING → REVIEWING; align transaction status ---
  const revisionBefore = state.stateRevision;
  state = transitionRuntimeState(state, "REVIEWING", "CURSOR_REPORT_VALIDATED");
  if (state.currentTransaction) {
    state = {
      ...state,
      currentTransaction: {
        ...state.currentTransaction,
        status: "REVIEWING",
      },
    };
  }
  // Preserve completed agent attribution in artifacts; clear activeAgent so
  // future legal launches are not blocked by a finished worker (policy P3).
  const completedAgent = state.activeAgent;
  writeJson(path.join(runDir, "completed-agent-snapshot.json"), {
    activeAgent: completedAgent,
    cursorRunId,
    clearedAfterValidation: true,
    clearedAt: nowIso(),
  });
  artifactPaths.completedAgentSnapshot = path.join(
    runDir,
    "completed-agent-snapshot.json",
  );
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
    agentId: cursorAgentId,
    stateRevisionBefore: revisionBefore,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: `phase2-state-reviewing:${workOrder.workOrderId}:${state.stateRevision}`,
    severity: "INFO",
    summary: "VERIFYING → REVIEWING after validated completion report; transaction status reconciled; completed agent cleared after durable attribution",
    payload: {
      runtimeState: state.radioRuntime.state,
      transactionStatus: state.currentTransaction?.status ?? null,
      preservedAgentId: cursorAgentId,
      preservedRunId: cursorRunId,
      phase: 2,
    },
  });

  writeJson(path.join(runDir, "completion-reconciliation.json"), {
    ok: true,
    reportValid: true,
    workOutcome: validation.workOutcome,
    workOutcomeDetail: validation.workOutcomeDetail,
    sourceIntegrity: validation.sourceIntegrity,
    runtimeStateBefore: "VERIFYING",
    runtimeStateAfter: state.radioRuntime.state,
    transactionStatusAfter: state.currentTransaction?.status ?? null,
    stateRevision: state.stateRevision,
    activeAgentClearedAfterAttribution: true,
    preservedAgentId: cursorAgentId,
    preservedRunId: cursorRunId,
  });
  artifactPaths.completionReconciliation = path.join(
    runDir,
    "completion-reconciliation.json",
  );

  // --- Bounded continuation context + exactly one Sol call ---
  const brain = loadBellhopBrain();
  const { context, artifact: continuationArtifact } = buildContinuationContext({
    brain: { ...brain, state, fingerprint },
    state,
    fingerprint,
    workOrder,
    validation,
    report: extracted.report,
    cursorAgentId,
    cursorRunId,
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
    agentId: cursorAgentId,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: `phase2-sol-request:${workOrder.workOrderId}:${state.stateRevision}`,
    severity: "INFO",
    summary: "Phase 2 Sol continuation decision requested",
    payload: { phase: 2, runtimeState: state.radioRuntime.state },
  });

  let sol;
  try {
    sol = await callSol({
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
    appendLedgerEvent({
      ledgerPath,
      eventType: "RADIO_ERROR",
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      workOrderId: workOrder.workOrderId,
      decisionId: null,
      agentId: cursorAgentId,
      stateRevisionBefore: state.stateRevision,
      stateRevisionAfter: state.stateRevision,
      stateFingerprint: fingerprint,
      idempotencyKey: `phase2-sol-error:${workOrder.workOrderId}`,
      severity: "ERROR",
      summary: err instanceof Error ? err.message : String(err),
      payload: { phase: 2 },
    });
    writePhase2Summary(runDir, artifactPaths, {
      terminalVerdict: "RADIO_PHASE2_BLOCKED",
      reportValid: true,
      runtimeState: state.radioRuntime.state,
      solContinuationCalls: metrics.solContinuationCalls,
    });
    return {
      runId,
      terminalVerdict: "RADIO_PHASE2_BLOCKED",
      reportValid: true,
      workOutcome: validation.workOutcomeDetail,
      runtimeState: state.radioRuntime.state,
      stateRevision: state.stateRevision,
      decision: null,
      policy: null,
      cursorCreateCalls: metrics.cursorCreateCalls,
      cursorFollowUpCalls: metrics.cursorFollowUpCalls,
      solContinuationCalls: metrics.solContinuationCalls,
      artifactPaths,
      state,
      preservedAgentAttribution,
    };
  }

  writeJson(path.join(runDir, "next-decision.json"), sol.decision);
  artifactPaths.nextDecision = path.join(runDir, "next-decision.json");

  const envelope: DecisionEnvelope = {
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
      ...sol.schemaCompatNotes,
    ],
  };
  writeJson(path.join(runDir, "next-decision-envelope.json"), envelope);
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
    agentId: cursorAgentId,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: fingerprint,
    idempotencyKey: `phase2-sol-received:${sol.decision.decisionId}`,
    severity: "INFO",
    summary: `Sol continuation decision: ${sol.decision.decision}`,
    payload: {
      decision: sol.decision.decision,
      phase: 2,
      executed: false,
    },
  });

  const policy = evaluatePolicy({
    decision: sol.decision,
    state,
    envelope,
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
    agentId: cursorAgentId,
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

  // HARD BOUNDARY: never execute next action in Phase 2.
  assertNoPhase3Execution(metrics);

  writePhase2Summary(runDir, artifactPaths, {
    terminalVerdict: "RADIO_PHASE2_NEXT_ACTION_READY",
    reportValid: true,
    workOutcome: validation.workOutcome,
    workOutcomeDetail: validation.workOutcomeDetail,
    runtimeState: state.radioRuntime.state,
    nextDecision: sol.decision.decision,
    policyResult: policy.result,
    solContinuationCalls: metrics.solContinuationCalls,
    cursorCreateCalls: metrics.cursorCreateCalls,
  });

  return {
    runId,
    terminalVerdict: "RADIO_PHASE2_NEXT_ACTION_READY",
    reportValid: true,
    workOutcome: validation.workOutcomeDetail,
    runtimeState: state.radioRuntime.state,
    stateRevision: state.stateRevision,
    decision: sol.decision,
    policy,
    cursorCreateCalls: metrics.cursorCreateCalls,
    cursorFollowUpCalls: metrics.cursorFollowUpCalls,
    solContinuationCalls: metrics.solContinuationCalls,
    artifactPaths,
    state,
    preservedAgentAttribution,
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

function resolveWorkOrder(
  config: Phase2Config,
  runDir: string,
): CursorWorkOrder {
  if (config.workOrder) {
    writeJson(path.join(runDir, "work-order.json"), config.workOrder);
    return config.workOrder;
  }
  const woPath =
    config.workOrderPath ??
    resolveRepoPath("fixtures", "phase2", "bellhop-phase1-work-order.json");
  const workOrder = readJsonFile<CursorWorkOrder>(woPath);
  writeJson(path.join(runDir, "work-order.json"), workOrder);
  return workOrder;
}

async function resolveRawResult(input: {
  config: Phase2Config;
  cursorAgentId: string | null;
  cursorRunId: string | null;
  metrics: Phase2Metrics;
}): Promise<string> {
  const { config, cursorAgentId, cursorRunId } = input;
  if (typeof config.rawResultText === "string") {
    return config.rawResultText;
  }
  if (config.rawResultPath) {
    return fs.readFileSync(config.rawResultPath, "utf8");
  }
  if (config.mode === "fixture") {
    const fixturePath = resolveRepoPath(
      "fixtures",
      "phase2",
      "bellhop-blocked-source-raw-result.txt",
    );
    return fs.readFileSync(fixturePath, "utf8");
  }

  // Live Phase 2: optional read-only retrieval of completed run.
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

    if (isHttpCursorApiClient(client) || client.radioClientKind === "http") {
      // Read-only GET only — never createAgent / never follow-up.
      const run = await client.getRun(cursorAgentId, cursorRunId);
      return typeof run.result === "string" ? run.result : "";
    }
    // Test double path
    const run = await client.getRun(cursorAgentId, cursorRunId);
    return typeof run.result === "string" ? run.result : "";
  }

  throw new Error(
    "Phase 2 requires rawResultText, rawResultPath, fixture mode, or read-only Cursor retrieval credentials",
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
  workOutcome: string | null;
}): Phase2Result {
  writeJson(path.join(input.runDir, "phase2-blocked.json"), {
    reason: input.reason,
    verdict: input.verdict,
  });
  writePhase2Summary(input.runDir, input.artifactPaths, {
    terminalVerdict: input.verdict,
    reportValid: input.reportValid,
    runtimeState: input.state.radioRuntime.state,
    solContinuationCalls: input.metrics.solContinuationCalls,
    reason: input.reason,
  });
  return {
    runId: input.runId,
    terminalVerdict: input.verdict,
    reportValid: input.reportValid,
    workOutcome: input.workOutcome,
    runtimeState: input.state.radioRuntime.state,
    stateRevision: input.state.stateRevision,
    decision: null,
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
