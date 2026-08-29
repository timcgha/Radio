/**
 * Phase 3 — minimal autonomous EXECUTE / OBSERVE / DECIDE loop.
 *
 * Thin composition around Phase 0–2:
 *   decide/policy/work-order (Phase 0)
 *   → transmit one Cursor action (Phase 1)
 *   → interpret + decide (Phase 2)
 *   → if legally executable and within objective budgets: repeat
 *   → else stop at human gate / blocker / completion / budget
 *
 * THE LLM REASONS; RADIO ENFORCES.
 * THE OBJECTIVE IS THE UNIT OF WORK; AGENT SESSIONS ARE IMPLEMENTATION DETAILS.
 * FAILURES ARE NORMAL LOOP OUTCOMES.
 *
 * Does NOT authorize Bellhop Stage 3. Does NOT call live APIs in fixture mode.
 */

import fs from "node:fs";
import path from "node:path";
import { writeJson, writeText } from "../artifacts/writer.js";
import type { CursorApiClient } from "../cursor/api-client.js";
import { renderCursorPrompt } from "../cursor/prompt-renderer.js";
import { buildCursorWorkOrder } from "../cursor/work-order-builder.js";
import { callSol } from "../orchestrator/sol-adapter.js";
import { evaluatePolicy } from "../policy/engine.js";
import { computeStateFingerprint } from "../state/fingerprint.js";
import {
  appendLedgerEvent,
  findLedgerEventByIdempotency,
} from "../state/ledger.js";
import {
  persistProjectState,
  transitionRuntimeState,
} from "../state/mutate.js";
import { loadBellhopBrain, loadProjectState } from "../state/store.js";
import type {
  DecisionEnvelope,
  ObjectiveAuthority,
  OrchestratorDecision,
  Phase3StatusSummary,
  Phase3TerminalVerdict,
  PolicyEvaluation,
  ProjectState,
} from "../types.js";
import { newId, nowIso, readJsonFile, resolveRepoPath } from "../util/io.js";
import {
  assertNoForeignApprovalReuse,
  checkObjectiveAuthorityForDecision,
  consumeObjectiveAuthority,
  loadObjectiveAuthority,
  persistObjectiveAuthority,
  recordCursorAgentUsed,
  recordIterationUsed,
} from "./objective-authority.js";
import { createPhase3FixtureCursorClient } from "./phase3-fixture-client.js";
import { buildPhase3StatusSummary } from "./phase3-status.js";
import { runPhase2 } from "./phase2.js";
import { ensureLedgerFile, transmitCursorWorkOrder } from "./transmitter.js";

export interface Phase3LoopConfig {
  projectId: string;
  workstreamId: string;
  transactionId: string;
  model: string;
  mode: "live" | "fixture";
  objectiveAuthorityPath: string;
  /** Isolated working PROJECT-STATE (never canonical checked-in path in fixtures). */
  statePath: string;
  ledgerPath: string;
  initialDecision?: OrchestratorDecision;
  initialDecisionFixturePath?: string;
  /** Sol continuation fixtures, one per completed execution (fixture mode). */
  continuationDecisionFixturePaths?: string[];
  /** Raw result texts, one per logical Cursor launch (fixture mode). */
  cursorRawResultSequence?: string[];
  cursorClient?: CursorApiClient;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  runDir?: string;
  /** Prior approvals that must not authorize this objective. */
  foreignApprovalIds?: string[];
  /** Optional resume: existing Phase 3 checkpoint directory. */
  resumeRunDir?: string;
}

export interface Phase3LoopResult {
  runId: string;
  terminalVerdict: Phase3TerminalVerdict;
  runtimeState: string;
  stateRevision: number;
  iterations: number;
  cursorExecutionCount: number;
  solDecisionCount: number;
  transportReconcileCount: number;
  logicalRetryCount: number;
  status: Phase3StatusSummary;
  authority: ObjectiveAuthority;
  state: ProjectState;
  lastDecision: OrchestratorDecision | null;
  lastPolicy: PolicyEvaluation | null;
  artifactPaths: Record<string, string>;
  stopReason: string;
  canonicalBellhopStateTouched: false;
}

interface Phase3Checkpoint {
  schemaVersion: "phase3-checkpoint-1.0";
  runId: string;
  objectiveId: string;
  pendingDecision: OrchestratorDecision | null;
  pendingDecisionEnvelope: DecisionEnvelope | null;
  continuationFixtureIndex: number;
  rawResultFixtureIndex: number;
  iterations: number;
  cursorExecutionCount: number;
  solDecisionCount: number;
  transportReconcileCount: number;
  logicalRetryCount: number;
  lastAgentId: string | null;
  lastRunId: string | null;
  lastWorkOrderId: string | null;
  lastMeaningfulEvent: string | null;
  updatedAt: string;
}

export function phase3PlanningSeedPath(): string {
  return resolveRepoPath("fixtures", "state", "phase3-planning-seed.json");
}

export function phase3DefaultObjectivePath(): string {
  return resolveRepoPath(
    "fixtures",
    "phase3",
    "objective-authority.json",
  );
}

/**
 * Run the Phase 3 autonomous loop around existing Phase 0–2 components.
 */
export async function runPhase3Loop(
  config: Phase3LoopConfig,
): Promise<Phase3LoopResult> {
  if (config.mode === "live") {
    // Real entrypoint exists but this implementation transaction must not
    // execute live Phase 3 / Stage 3. Callers should refuse before invoking.
    throw new Error(
      "RADIO_PHASE3_LIVE_REFUSED: live Phase 3 execution is not authorized in this transaction",
    );
  }

  const runId = config.resumeRunDir
    ? path.basename(config.resumeRunDir)
    : newId("run");
  const runDir =
    config.resumeRunDir ??
    config.runDir ??
    resolveRepoPath("artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  const statePath = config.statePath;
  const ledgerPath = config.ledgerPath;
  ensureLedgerFile(ledgerPath);

  // Hard isolation: refuse if state path is the canonical Bellhop file.
  const canonicalState = resolveRepoPath(
    "projects",
    "bellhop",
    "PROJECT-STATE.json",
  );
  if (path.resolve(statePath) === path.resolve(canonicalState)) {
    throw new Error(
      "PHASE3_FIXTURE_ISOLATION: refusing to mutate canonical projects/bellhop/PROJECT-STATE.json",
    );
  }

  let authority = loadObjectiveAuthority(config.objectiveAuthorityPath);
  const authorityWorkingPath = path.join(runDir, "objective-authority.json");
  if (!fs.existsSync(authorityWorkingPath)) {
    persistObjectiveAuthority(authorityWorkingPath, authority);
  } else if (config.resumeRunDir) {
    authority = loadObjectiveAuthority(authorityWorkingPath);
  } else {
    persistObjectiveAuthority(authorityWorkingPath, authority);
  }

  let loaded = loadProjectState({
    projectId: config.projectId,
    statePath,
  });
  let state = loaded.state;
  let fingerprint = loaded.fingerprint;

  // Foreign approval reuse guard (e.g. Stage 2 playtest approval).
  const pendingApprovalId = extractPendingApprovalId(state);
  const foreignCheck = assertNoForeignApprovalReuse({
    objectiveApprovalId: authority.approvalId,
    candidateApprovalId: pendingApprovalId,
  });
  if (
    pendingApprovalId &&
    pendingApprovalId !== authority.approvalId &&
    state.pendingHumanDecision &&
    isPendingUnconsumed(state)
  ) {
    // Unconsumed foreign approval present — must not silently authorize Phase 3.
    // We allow the loop to proceed only using the objective's own approvalId;
    // foreign approvals are ignored for authorization (recorded in artifacts).
    writeJson(path.join(runDir, "foreign-approval-guard.json"), {
      foreignApprovalId: pendingApprovalId,
      objectiveApprovalId: authority.approvalId,
      reused: false,
      check: foreignCheck,
    });
  }

  let checkpoint = loadOrInitCheckpoint({
    runDir,
    runId,
    authority,
    resume: Boolean(config.resumeRunDir),
  });

  const continuationFixtures = [
    ...(config.continuationDecisionFixturePaths ?? []),
  ];
  const rawResults = [...(config.cursorRawResultSequence ?? [])];

  const cursorClient =
    config.cursorClient ??
    createPhase3FixtureCursorClient(
      rawResults.map((rawResult, i) => ({
        rawResult,
        agentId: `bc-phase3-loop-${String(i + 1).padStart(4, "0")}`,
        runId: `run-phase3-loop-${String(i + 1).padStart(4, "0")}`,
      })),
    );

  let lastDecision: OrchestratorDecision | null = checkpoint.pendingDecision;
  let lastPolicy: PolicyEvaluation | null = null;
  let lastEnvelope: DecisionEnvelope | null =
    checkpoint.pendingDecisionEnvelope;
  let stopReason = "";
  let terminalVerdict: Phase3TerminalVerdict = "RADIO_PHASE3_BLOCKED";
  const artifactPaths: Record<string, string> = {
    objectiveAuthority: authorityWorkingPath,
    checkpoint: path.join(runDir, "phase3-checkpoint.json"),
  };

  // Seed initial decision if none pending.
  if (!lastDecision) {
    if (config.initialDecision) {
      lastDecision = config.initialDecision;
      lastEnvelope = {
        schemaVersion: "phase0-1.0",
        decisionId: config.initialDecision.decisionId,
        projectId: config.projectId,
        workstreamId: config.workstreamId,
        transactionId: config.transactionId,
        stateRevision: state.stateRevision,
        requestFingerprint: fingerprint,
        model: config.model,
        mode: "fixture",
        generatedAt: nowIso(),
        cursorExecutionEnabled: false,
        notes: ["Phase 3 initial decision (injected)"],
      };
    } else {
      const initial = await loadInitialDecision(config, state, fingerprint);
      lastDecision = initial.decision;
      lastEnvelope = initial.envelope;
    }
    checkpoint.pendingDecision = lastDecision;
    checkpoint.pendingDecisionEnvelope = lastEnvelope;
    checkpoint.solDecisionCount += 1;
    checkpoint.lastMeaningfulEvent = "INITIAL_DECISION_READY";
    saveCheckpoint(runDir, checkpoint);
  }

  // Main autonomous loop.
  while (true) {
    loaded = loadProjectState({ projectId: config.projectId, statePath });
    state = loaded.state;
    fingerprint = loaded.fingerprint;

    if (!lastDecision || !lastEnvelope) {
      terminalVerdict = "RADIO_PHASE3_INVALID_SOL_DECISION";
      stopReason = "No pending decision available";
      break;
    }

    // Stale fingerprint / envelope binding
    if (lastEnvelope.requestFingerprint !== fingerprint) {
      // Rebuild envelope against current fingerprint only when revision matches
      // the envelope's recorded revision; otherwise fail closed.
      if (lastEnvelope.stateRevision !== state.stateRevision) {
        terminalVerdict = "RADIO_PHASE3_INVALID_SOL_DECISION";
        stopReason = "Pending decision is stale relative to state revision";
        break;
      }
      lastEnvelope = {
        ...lastEnvelope,
        requestFingerprint: fingerprint,
      };
    }

    const policy = evaluatePolicy({
      decision: lastDecision,
      state,
      envelope: lastEnvelope,
      currentFingerprint: fingerprint,
    });
    lastPolicy = policy;
    writeJson(
      path.join(runDir, `policy-evaluation-iter-${checkpoint.iterations + 1}.json`),
      policy,
    );

    const isLogicalRetry = checkpoint.cursorExecutionCount > 0;
    const authorityCheck = checkObjectiveAuthorityForDecision({
      authority,
      decision: lastDecision,
      foreignApprovalIds: config.foreignApprovalIds ?? [pendingApprovalId].filter(
        (x): x is string => Boolean(x),
      ),
      isLogicalRetry:
        isLogicalRetry && lastDecision.decision === "LAUNCH_CURSOR",
    });
    writeJson(
      path.join(
        runDir,
        `authority-check-iter-${checkpoint.iterations + 1}.json`,
      ),
      authorityCheck,
    );

    // Terminal / gate handling BEFORE any external write.
    if (lastDecision.decision === "REQUEST_HUMAN_APPROVAL") {
      state = applyHumanGate(state, lastDecision);
      const persisted = persistProjectState({
        state,
        path: statePath,
        expectedRevision: state.stateRevision,
      });
      state = persisted.state;
      fingerprint = persisted.fingerprint;
      authority = consumeObjectiveAuthority(authority);
      persistObjectiveAuthority(authorityWorkingPath, authority);
      terminalVerdict = "RADIO_PHASE3_READY_FOR_HUMAN";
      stopReason = "Human judgment required; stopping before further execution";
      checkpoint.lastMeaningfulEvent = "HUMAN_GATE";
      // Preferred successful autonomous-loop terminal when ≥2 iterations completed.
      if (checkpoint.cursorExecutionCount >= 2) {
        terminalVerdict = "RADIO_PHASE3_AUTONOMOUS_LOOP_READY";
        stopReason =
          "Autonomous loop completed ≥2 iterations and stopped at human gate";
      }
      break;
    }

    if (lastDecision.decision === "ACCEPT_WORKSTREAM") {
      state = applyAccept(state, lastDecision);
      const persisted = persistProjectState({
        state,
        path: statePath,
        expectedRevision: state.stateRevision,
      });
      state = persisted.state;
      authority = consumeObjectiveAuthority(authority);
      persistObjectiveAuthority(authorityWorkingPath, authority);
      terminalVerdict = "RADIO_PHASE3_OBJECTIVE_COMPLETE";
      stopReason = "Objective accepted";
      if (checkpoint.cursorExecutionCount >= 2) {
        terminalVerdict = "RADIO_PHASE3_AUTONOMOUS_LOOP_READY";
      }
      break;
    }

    if (lastDecision.decision === "BLOCK_WORKSTREAM") {
      state = applyBlock(state, lastDecision);
      const persisted = persistProjectState({
        state,
        path: statePath,
        expectedRevision: state.stateRevision,
      });
      state = persisted.state;
      authority = consumeObjectiveAuthority(authority);
      persistObjectiveAuthority(authorityWorkingPath, authority);
      terminalVerdict = "RADIO_PHASE3_BLOCKED";
      stopReason = "Workstream blocked";
      break;
    }

    if (
      lastDecision.decision === "NO_ACTION" ||
      lastDecision.decision === "WAIT"
    ) {
      terminalVerdict = "RADIO_PHASE3_BLOCKED";
      stopReason = `Decision ${lastDecision.decision} is non-executable in Phase 3 v1 loop`;
      break;
    }

    if (policy.result === "REQUIRE_HUMAN") {
      terminalVerdict = "RADIO_PHASE3_READY_FOR_HUMAN";
      stopReason = `Policy REQUIRE_HUMAN (${policy.primaryCode}) — stop before external write`;
      break;
    }

    if (policy.result === "REJECT") {
      terminalVerdict = "RADIO_PHASE3_POLICY_REJECTED";
      stopReason = `Policy REJECT (${policy.primaryCode}) — stop before external write`;
      break;
    }

    if (policy.result !== "ALLOW" || !policy.executionPermitted) {
      terminalVerdict = "RADIO_PHASE3_POLICY_REJECTED";
      stopReason = `Policy ${policy.result} does not permit execution`;
      break;
    }

    if (!authorityCheck.ok) {
      if (
        authorityCheck.code === "ITERATION_BUDGET_EXHAUSTED" ||
        authorityCheck.code === "CURSOR_AGENT_BUDGET_EXHAUSTED" ||
        authorityCheck.code === "RETRY_BUDGET_EXHAUSTED" ||
        authorityCheck.code === "TOKEN_BUDGET_EXHAUSTED" ||
        authorityCheck.code === "SPEND_BUDGET_EXHAUSTED"
      ) {
        terminalVerdict =
          authorityCheck.code === "ITERATION_BUDGET_EXHAUSTED"
            ? "RADIO_PHASE3_ITERATION_LIMIT_REACHED"
            : "RADIO_PHASE3_BUDGET_EXHAUSTED";
        stopReason = `${authorityCheck.code}: ${authorityCheck.summary}`;
      } else if (authorityCheck.code === "PROHIBITED_SCOPE") {
        terminalVerdict = "RADIO_PHASE3_POLICY_REJECTED";
        stopReason = authorityCheck.summary;
      } else {
        terminalVerdict = "RADIO_PHASE3_BLOCKED";
        stopReason = authorityCheck.summary;
      }
      break;
    }

    // Pre-check budgets again immediately before external write.
    if (authority.accounting.cursorAgentsUsed >= authority.maxCursorAgents) {
      terminalVerdict = "RADIO_PHASE3_BUDGET_EXHAUSTED";
      stopReason = "maxCursorAgents exhausted before external write";
      break;
    }
    if (authority.accounting.iterationsUsed >= authority.maxIterations) {
      terminalVerdict = "RADIO_PHASE3_ITERATION_LIMIT_REACHED";
      stopReason = "maxIterations exhausted before external write";
      break;
    }

    if (
      lastDecision.decision !== "LAUNCH_CURSOR" &&
      lastDecision.decision !== "REUSE_CURSOR"
    ) {
      terminalVerdict = "RADIO_PHASE3_BLOCKED";
      stopReason = `Unsupported Phase 3 execution decision: ${lastDecision.decision}`;
      break;
    }

    // Prepare runtime for launch: REVIEWING → PLANNING when Sol authorized continue.
    if (state.radioRuntime.state === "REVIEWING") {
      if (lastDecision.stateTransition.to === "PLANNING") {
        const revBefore = state.stateRevision;
        state = transitionRuntimeState(
          state,
          "PLANNING",
          "PHASE3_CONTINUE_AFTER_REVIEW",
        );
        if (state.currentTransaction) {
          state = {
            ...state,
            currentTransaction: {
              ...state.currentTransaction,
              status: "PLANNING",
            },
          };
        }
        if (state.activeWorkstream) {
          state = {
            ...state,
            activeWorkstream: {
              ...state.activeWorkstream,
              status: "PLANNING",
            },
          };
        }
        const persisted = persistProjectState({
          state,
          path: statePath,
          expectedRevision: revBefore,
        });
        state = persisted.state;
        fingerprint = persisted.fingerprint;
        // Refresh envelope fingerprint after mutation.
        lastEnvelope = {
          ...lastEnvelope,
          stateRevision: state.stateRevision,
          requestFingerprint: fingerprint,
        };
        // Re-validate policy against post-transition state with adjusted decision.from.
        lastDecision = {
          ...lastDecision,
          stateTransition: {
            ...lastDecision.stateTransition,
            from: "PLANNING",
            to: "IMPLEMENTING",
            reason: "Phase 3 prepared PLANNING for authorized Cursor launch",
          },
        };
        const rePolicy = evaluatePolicy({
          decision: lastDecision,
          state,
          envelope: lastEnvelope,
          currentFingerprint: fingerprint,
        });
        lastPolicy = rePolicy;
        if (rePolicy.result !== "ALLOW" || !rePolicy.executionPermitted) {
          terminalVerdict = "RADIO_PHASE3_POLICY_REJECTED";
          stopReason = `Post-transition policy ${rePolicy.result} (${rePolicy.primaryCode})`;
          break;
        }
      } else {
        terminalVerdict = "RADIO_PHASE3_BLOCKED";
        stopReason =
          "LAUNCH from REVIEWING requires stateTransition.to=PLANNING";
        break;
      }
    }

    // --- EXECUTE exactly one permitted action (Phase 1 transmitter) ---
    const workOrder = buildCursorWorkOrder({
      state,
      decision: lastDecision,
      policy: lastPolicy!,
    });
    const prompt = renderCursorPrompt(workOrder);
    writeJson(
      path.join(runDir, `work-order-iter-${checkpoint.cursorExecutionCount + 1}.json`),
      workOrder,
    );
    writeText(
      path.join(
        runDir,
        `cursor-prompt-iter-${checkpoint.cursorExecutionCount + 1}.txt`,
      ),
      prompt,
    );

    // Persist intent before external write (crash recovery).
    checkpoint.pendingDecision = lastDecision;
    checkpoint.pendingDecisionEnvelope = lastEnvelope;
    checkpoint.lastWorkOrderId = workOrder.workOrderId;
    checkpoint.lastMeaningfulEvent = "DISPATCH_INTENT_PERSISTED";
    saveCheckpoint(runDir, checkpoint);
    persistObjectiveAuthority(authorityWorkingPath, authority);

    const priorCreated = findLedgerEventByIdempotency(
      ledgerPath,
      workOrder.idempotencyKey,
      ["CURSOR_AGENT_CREATED"],
    );
    const wasTransportReconcile = Boolean(priorCreated);

    const iterRunDir = path.join(
      runDir,
      `exec-${checkpoint.cursorExecutionCount + 1}`,
    );
    fs.mkdirSync(iterRunDir, { recursive: true });

    const transmit = await transmitCursorWorkOrder({
      runId: `${runId}-exec-${checkpoint.cursorExecutionCount + 1}`,
      runDir: iterRunDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt,
      client: cursorClient,
      forceFixtureTransmit: true,
      explicitTransmitMode: false,
      externalCursorAllowed: false,
      pollIntervalMs: config.pollIntervalMs ?? 1,
      pollMaxAttempts: config.pollMaxAttempts ?? 5,
    });

    state = transmit.state;
    fingerprint = transmit.fingerprint;

    if (
      transmit.terminalVerdict !== "RADIO_PHASE1_RAW_RESULT_READY" &&
      transmit.terminalVerdict !== "RADIO_PHASE1_DISPATCH_COMPLETE"
    ) {
      terminalVerdict = "RADIO_PHASE3_INFRASTRUCTURE_BLOCKED";
      stopReason = `Transmit failed: ${transmit.terminalVerdict}`;
      break;
    }

    if (!wasTransportReconcile) {
      authority = recordCursorAgentUsed(authority, {
        logicalRetry: isLogicalRetry,
        usageTokens: transmit.usage?.totalUsage?.totalTokens ?? 0,
      });
      checkpoint.cursorExecutionCount += 1;
      if (isLogicalRetry) {
        checkpoint.logicalRetryCount += 1;
      }
    } else {
      checkpoint.transportReconcileCount += 1;
    }

    checkpoint.lastAgentId = transmit.agentId;
    checkpoint.lastRunId = transmit.runId;
    checkpoint.lastMeaningfulEvent = "CURSOR_RESULT_ACQUIRED";
    persistObjectiveAuthority(authorityWorkingPath, authority);
    saveCheckpoint(runDir, checkpoint);

    // --- OBSERVE + Sol interpret/decide (Phase 2) — exactly one Sol call ---
    const continuationPath =
      continuationFixtures[checkpoint.continuationFixtureIndex];
    if (!continuationPath) {
      terminalVerdict = "RADIO_PHASE3_INVALID_SOL_DECISION";
      stopReason = "No Sol continuation fixture remaining for completed execution";
      break;
    }

    const rawText =
      transmit.rawResultText ??
      rawResults[checkpoint.rawResultFixtureIndex] ??
      "";

    const phase2 = await runPhase2({
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      model: config.model,
      mode: "fixture",
      nextDecisionFixturePath: continuationPath,
      rawResultText: rawText,
      workOrder,
      statePath,
      ledgerPath,
      reuseCallerState: true,
      isolateState: false,
      cursorAgentId: transmit.agentId,
      cursorRunId: transmit.runId,
      allowReadOnlyCursorRetrieval: false,
    });

    checkpoint.continuationFixtureIndex += 1;
    checkpoint.rawResultFixtureIndex += 1;
    checkpoint.solDecisionCount += 1;
    checkpoint.iterations += 1;
    authority = recordIterationUsed(authority);
    persistObjectiveAuthority(authorityWorkingPath, authority);

    state = phase2.state;
    fingerprint = computeStateFingerprint(state);

    if (phase2.solContinuationCalls !== 1) {
      terminalVerdict = "RADIO_PHASE3_INVALID_SOL_DECISION";
      stopReason = "Phase 2 Sol call count must be exactly 1 per reviewed execution";
      break;
    }

    if (
      phase2.terminalVerdict !== "RADIO_PHASE2_NEXT_ACTION_READY" ||
      !phase2.decision ||
      !phase2.policy
    ) {
      terminalVerdict = "RADIO_PHASE3_BLOCKED";
      stopReason = `Phase 2 did not yield next action: ${phase2.terminalVerdict}`;
      break;
    }

    lastDecision = phase2.decision;
    lastPolicy = phase2.policy;
    lastEnvelope = {
      schemaVersion: "phase3-1.0" as DecisionEnvelope["schemaVersion"],
      decisionId: phase2.decision.decisionId,
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      stateRevision: state.stateRevision,
      requestFingerprint: fingerprint,
      model: config.model,
      mode: "fixture",
      generatedAt: nowIso(),
      cursorExecutionEnabled: false,
      notes: [
        "Phase 3 pending decision after Phase 2 interpret+decide",
        `priorAgentId=${transmit.agentId}`,
        `priorRunId=${transmit.runId}`,
      ],
    };
    // Fix schema version — DecisionEnvelope uses phase0-1.0
    lastEnvelope = {
      ...lastEnvelope,
      schemaVersion: "phase0-1.0",
    };

    checkpoint.pendingDecision = lastDecision;
    checkpoint.pendingDecisionEnvelope = lastEnvelope;
    checkpoint.lastMeaningfulEvent = "SOL_NEXT_DECISION_READY";
    saveCheckpoint(runDir, checkpoint);

    writeJson(
      path.join(runDir, `next-decision-iter-${checkpoint.iterations}.json`),
      lastDecision,
    );

    // Loop continues — evaluate next decision at top of while.
  }

  saveCheckpoint(runDir, checkpoint);
  persistObjectiveAuthority(authorityWorkingPath, authority);

  const status = buildPhase3StatusSummary({
    state,
    authority,
    terminalReason: terminalVerdict,
    lastMeaningfulEvent: checkpoint.lastMeaningfulEvent,
    humanQuestion:
      lastDecision?.humanApproval?.summary ??
      lastDecision?.humanApproval?.requestedAction ??
      null,
    previewOrResultLink:
      checkpoint.lastAgentId != null
        ? `https://cursor.com/agents/${checkpoint.lastAgentId}`
        : null,
  });
  writeJson(path.join(runDir, "phase3-status.json"), status);
  artifactPaths.phase3Status = path.join(runDir, "phase3-status.json");

  const summary = {
    runId,
    terminalVerdict,
    stopReason,
    iterations: checkpoint.iterations,
    cursorExecutionCount: checkpoint.cursorExecutionCount,
    solDecisionCount: checkpoint.solDecisionCount,
    transportReconcileCount: checkpoint.transportReconcileCount,
    logicalRetryCount: checkpoint.logicalRetryCount,
    runtimeState: state.radioRuntime.state,
    stateRevision: state.stateRevision,
    lastDecision: lastDecision?.decision ?? null,
    lastPolicy: lastPolicy?.result ?? null,
    canonicalBellhopStateTouched: false as const,
    liveOpenAiCalls: 0,
    liveCursorCalls: 0,
  };
  writeJson(path.join(runDir, "phase3-summary.json"), summary);
  artifactPaths.phase3Summary = path.join(runDir, "phase3-summary.json");

  appendLedgerEvent({
    ledgerPath,
    eventType: "RADIO_STOPPED",
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    workOrderId: checkpoint.lastWorkOrderId,
    decisionId: lastDecision?.decisionId ?? null,
    agentId: checkpoint.lastAgentId,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
    stateFingerprint: computeStateFingerprint(state),
    idempotencyKey: `phase3-stop:${runId}:${terminalVerdict}`,
    severity: "INFO",
    summary: `Phase 3 stopped: ${terminalVerdict} — ${stopReason}`,
    payload: summary,
  });

  return {
    runId,
    terminalVerdict,
    runtimeState: state.radioRuntime.state,
    stateRevision: state.stateRevision,
    iterations: checkpoint.iterations,
    cursorExecutionCount: checkpoint.cursorExecutionCount,
    solDecisionCount: checkpoint.solDecisionCount,
    transportReconcileCount: checkpoint.transportReconcileCount,
    logicalRetryCount: checkpoint.logicalRetryCount,
    status,
    authority,
    state,
    lastDecision,
    lastPolicy,
    artifactPaths,
    stopReason,
    canonicalBellhopStateTouched: false,
  };
}

async function loadInitialDecision(
  config: Phase3LoopConfig,
  state: ProjectState,
  fingerprint: string,
): Promise<{ decision: OrchestratorDecision; envelope: DecisionEnvelope }> {
  const fixturePath =
    config.initialDecisionFixturePath ??
    resolveRepoPath("fixtures", "decisions", "phase3-initial-launch.json");
  const brain = loadBellhopBrain();
  const sol = await callSol({
    context: {
      system: "phase3-fixture",
      user: "phase3-fixture",
      vocabulary: [],
      fingerprint,
      stateRevision: state.stateRevision,
    },
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    currentRuntimeState: state.radioRuntime.state,
    model: config.model,
    mode: "fixture",
    fixturePath,
  });
  void brain;
  const envelope: DecisionEnvelope = {
    schemaVersion: "phase0-1.0",
    decisionId: sol.decision.decisionId,
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    stateRevision: state.stateRevision,
    requestFingerprint: fingerprint,
    model: sol.model,
    mode: "fixture",
    generatedAt: nowIso(),
    cursorExecutionEnabled: false,
    notes: ["Phase 3 initial decision (fixture)"],
  };
  return { decision: sol.decision, envelope };
}

function applyHumanGate(
  state: ProjectState,
  decision: OrchestratorDecision,
): ProjectState {
  let next = transitionRuntimeState(
    state,
    "READY_FOR_HUMAN",
    "PHASE3_HUMAN_GATE",
  );
  next = {
    ...next,
    pendingHumanDecision: {
      approvalId: `ha-phase3-${decision.decisionId}`,
      type: decision.humanApproval?.approvalType ?? "OTHER",
      summary: decision.humanApproval?.summary ?? decision.reason,
      requestedAction:
        decision.humanApproval?.requestedAction ?? "HUMAN_REVIEW",
      risk: decision.humanApproval?.risk ?? "MEDIUM",
      choices: decision.humanApproval?.allowedChoices ?? ["APPROVE", "REJECT"],
      createdAt: nowIso(),
      stateRevisionBasis: state.stateRevision,
      consumed: false,
    },
  };
  if (next.activeWorkstream) {
    next = {
      ...next,
      activeWorkstream: {
        ...next.activeWorkstream,
        status: "READY_FOR_HUMAN",
      },
    };
  }
  if (next.currentTransaction) {
    next = {
      ...next,
      currentTransaction: {
        ...next.currentTransaction,
        status: "READY_FOR_HUMAN",
      },
    };
  }
  return next;
}

function applyAccept(
  state: ProjectState,
  decision: OrchestratorDecision,
): ProjectState {
  let next = transitionRuntimeState(
    state,
    decision.stateTransition.to === "ACCEPTED" ? "ACCEPTED" : "ACCEPTED",
    "PHASE3_OBJECTIVE_COMPLETE",
  );
  if (next.activeWorkstream) {
    next = {
      ...next,
      activeWorkstream: {
        ...next.activeWorkstream,
        status: "ACCEPTED",
        terminalVerdict: decision.terminal?.verdict ?? "OBJECTIVE_COMPLETE",
      },
    };
  }
  if (next.currentTransaction) {
    next = {
      ...next,
      currentTransaction: {
        ...next.currentTransaction,
        status: "ACCEPTED",
      },
    };
  }
  return next;
}

function applyBlock(
  state: ProjectState,
  decision: OrchestratorDecision,
): ProjectState {
  let next = transitionRuntimeState(state, "BLOCKED", "PHASE3_BLOCKED");
  if (next.activeWorkstream) {
    next = {
      ...next,
      activeWorkstream: {
        ...next.activeWorkstream,
        status: "BLOCKED",
        terminalVerdict: decision.terminal?.verdict ?? "BLOCKED",
      },
    };
  }
  if (next.currentTransaction) {
    next = {
      ...next,
      currentTransaction: {
        ...next.currentTransaction,
        status: "BLOCKED",
      },
    };
  }
  return next;
}

function extractPendingApprovalId(state: ProjectState): string | null {
  const pending = state.pendingHumanDecision;
  if (!pending || typeof pending !== "object") return null;
  const id = (pending as { approvalId?: unknown }).approvalId;
  return typeof id === "string" ? id : null;
}

function isPendingUnconsumed(state: ProjectState): boolean {
  const pending = state.pendingHumanDecision;
  if (!pending || typeof pending !== "object") return false;
  const consumed = (pending as { consumed?: unknown }).consumed;
  return consumed !== true;
}

function loadOrInitCheckpoint(input: {
  runDir: string;
  runId: string;
  authority: ObjectiveAuthority;
  resume: boolean;
}): Phase3Checkpoint {
  const checkpointPath = path.join(input.runDir, "phase3-checkpoint.json");
  if (input.resume && fs.existsSync(checkpointPath)) {
    return readJsonFile<Phase3Checkpoint>(checkpointPath);
  }
  const checkpoint: Phase3Checkpoint = {
    schemaVersion: "phase3-checkpoint-1.0",
    runId: input.runId,
    objectiveId: input.authority.objectiveId,
    pendingDecision: null,
    pendingDecisionEnvelope: null,
    continuationFixtureIndex: 0,
    rawResultFixtureIndex: 0,
    iterations: 0,
    cursorExecutionCount: 0,
    solDecisionCount: 0,
    transportReconcileCount: 0,
    logicalRetryCount: 0,
    lastAgentId: null,
    lastRunId: null,
    lastWorkOrderId: null,
    lastMeaningfulEvent: null,
    updatedAt: nowIso(),
  };
  saveCheckpoint(input.runDir, checkpoint);
  return checkpoint;
}

function saveCheckpoint(runDir: string, checkpoint: Phase3Checkpoint): void {
  checkpoint.updatedAt = nowIso();
  writeJson(path.join(runDir, "phase3-checkpoint.json"), checkpoint);
}
