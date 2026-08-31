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
import {
  createHttpCursorApiClient,
  isCursorExecutionEnabled,
  resolveCursorApiKey,
  type CursorApiClient,
  type HttpCursorApiClientOptions,
} from "../cursor/api-client.js";
import type { ResolveRemoteBranchTip } from "../cursor/source-ref.js";
import { renderCursorPrompt } from "../cursor/prompt-renderer.js";
import { buildCursorWorkOrder } from "../cursor/work-order-builder.js";
import { evaluateAcceptWorkstreamGate } from "./completion-acceptance-gate.js";
import {
  buildCompletionAcceptanceContextArtifact,
  type CompletionAcceptanceContextArtifact,
} from "./completion-acceptance-context.js";
import { diagnoseStructuredWorkerReport } from "./worker-report-diagnostics.js";
import { buildPhase3InitialContext } from "../orchestrator/phase3-initial-context.js";
import {
  callSol,
  callSolPhase2Continuation,
} from "../orchestrator/sol-adapter.js";
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
import { loadProjectBrain, loadProjectState } from "../state/store.js";
import type {
  CursorWorkOrder,
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
  validateObjectiveAuthorityForLiveEntry,
  validatePhase3ExecutionPrerequisites,
} from "./objective-authority.js";
import {
  leaseOwnerFingerprint,
  resolveObjectiveLeaseStore,
  type ObjectiveLeaseStore,
} from "./objective-lease.js";
import { prepareAcceptedBaselineForObjectiveStart } from "./phase3-objective-start.js";
import { alignStateBudgetsWithObjectiveAuthority } from "./cursor-agent-budget.js";
import { createPhase3FixtureCursorClient } from "./phase3-fixture-client.js";
import {
  assertLiveDecisionFreeOfFixtureSemantics,
  assertLiveModeDoesNotUseFixtureDecisionPath,
} from "./phase3-fixture-guard.js";
import { buildPhase3StatusSummary } from "./phase3-status.js";
import { runPhase2 } from "./phase2.js";
import {
  ensureLedgerFile,
  resolveCursorPollDefaults,
  transmitCursorWorkOrder,
} from "./transmitter.js";
import { resolveProjectConfig } from "../projects/registry.js";
import { requireRequestedWork } from "../policy/executable-scope.js";
import {
  resolveCursorWorkerModelPolicy,
} from "./cursor-worker-model.js";

/**
 * Resolve Phase 3 → Phase 1 transmit polling options.
 * Fixture / injected-mock clients keep fast deterministic timings.
 * Live HTTP Cursor path uses Phase 1 production-safe defaults.
 */
export function resolvePhase3TransmitPollOptions(input: {
  mode: "live" | "fixture";
  usingInjectedCursorClient: boolean;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
}): { pollIntervalMs: number; pollMaxAttempts: number } {
  const forceFixtureTransmit =
    input.mode === "fixture" || input.usingInjectedCursorClient;
  const defaults = resolveCursorPollDefaults(forceFixtureTransmit);
  return {
    pollIntervalMs: input.pollIntervalMs ?? defaults.pollIntervalMs,
    pollMaxAttempts: input.pollMaxAttempts ?? defaults.pollMaxAttempts,
  };
}

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
  /** Live Cursor create gate (mirrors Phase 1 transmit authorization). */
  externalCursorAllowed?: boolean;
  /** When false, live mode stops before external create if prerequisites fail. */
  skipLiveExecution?: boolean;
  /** Injectable Sol initial decision call (tests). */
  solCall?: typeof callSol;
  /** Injectable Sol Phase 2 continuation call (tests). */
  solPhase2Call?: typeof callSolPhase2Continuation;
  /**
   * Env for live credential / execution gates (tests).
   * Defaults to process.env. Never logged.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Injectable Phase 1 HTTP Cursor client factory (tests).
   * Defaults to createHttpCursorApiClient — no second client stack.
   */
  createCursorHttpClient?: (
    options: HttpCursorApiClientOptions,
  ) => CursorApiClient;
  /** Optional fetch override forwarded to createHttpCursorApiClient (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable remote branch tip resolver (tests / live isolation). */
  resolveRemoteBranchTip?: ResolveRemoteBranchTip;
  /** Injectable sleep for Cursor polling (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected global objective lease store (tests / shared coordination). */
  objectiveLeaseStore?: ObjectiveLeaseStore;
  /** Skip global lease (only for isolated unit tests that pre-date leases). */
  skipObjectiveLease?: boolean;
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
  /** Path to completion acceptance context for the most recent execution. */
  lastCompletionAcceptanceContextPath: string | null;
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
  const runIdCandidate = newId("run");
  const runDir =
    config.resumeRunDir ??
    config.runDir ??
    resolveRepoPath("artifacts", "runs", runIdCandidate);
  // Bind lease ownership to the durable run directory name so resume
  // (resumeRunDir) renews the same global lease instead of racing as a peer.
  const runId = path.basename(runDir);
  fs.mkdirSync(runDir, { recursive: true });

  const statePath = config.statePath;
  const ledgerPath = config.ledgerPath;
  ensureLedgerFile(ledgerPath);

  const canonicalState = resolveRepoPath(
    "projects",
    resolveProjectConfig(config.projectId).key,
    "PROJECT-STATE.json",
  );
  if (
    config.mode === "fixture" &&
    path.resolve(statePath) === path.resolve(canonicalState)
  ) {
    throw new Error(
      `PHASE3_FIXTURE_ISOLATION: refusing to mutate canonical projects/${resolveProjectConfig(config.projectId).key}/PROJECT-STATE.json`,
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

  if (config.mode === "live") {
    const liveEntry = validateObjectiveAuthorityForLiveEntry({
      authority,
      state,
      foreignApprovalIds: config.foreignApprovalIds,
    });
    writeJson(path.join(runDir, "live-entry-validation.json"), liveEntry);
    if (!liveEntry.ok) {
      throw new Error(`${liveEntry.code}: ${liveEntry.summary}`);
    }

    const runtime = state.radioRuntime.state;
    if (
      runtime === "ACCEPTED" ||
      (runtime === "IDLE" &&
        state.activeWorkstream?.id !== authority.workstreamId)
    ) {
      const prepared = prepareAcceptedBaselineForObjectiveStart({
        state,
        authority,
        statePath,
      });
      writeJson(path.join(runDir, "objective-start.json"), {
        ok: prepared.ok,
        code: prepared.code,
        summary: prepared.summary,
      });
      if (!prepared.ok) {
        throw new Error(`${prepared.code}: ${prepared.summary}`);
      }
      state = prepared.state;
      fingerprint = prepared.fingerprint;
    } else if (
      runtime === "PLANNING" &&
      (state.activeWorkstream?.id !== authority.workstreamId ||
        state.currentTransaction?.id !== authority.transactionId)
    ) {
      throw new Error(
        "WORKSTREAM_BINDING_INVALID: live Phase 3 state workstream/transaction must match objective authority",
      );
    }
  }

  // Align transaction Cursor-agent budget to the active objective for all modes.
  // Covers already-PLANNING seeds that skip ACCEPTED objective-start, and
  // ensures stale Stage-2 caps cannot throttle objective maxCursorAgents.
  {
    const aligned = alignStateBudgetsWithObjectiveAuthority(state, authority);
    if (aligned !== state) {
      const revBefore = state.stateRevision;
      const persisted = persistProjectState({
        state: aligned,
        path: statePath,
        expectedRevision: revBefore,
      });
      state = persisted.state;
      fingerprint = persisted.fingerprint;
    }
  }

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
    (config.mode === "fixture"
      ? createPhase3FixtureCursorClient(
          rawResults.map((rawResult, i) => ({
            rawResult,
            agentId: `bc-phase3-loop-${String(i + 1).padStart(4, "0")}`,
            runId: `run-phase3-loop-${String(i + 1).padStart(4, "0")}`,
          })),
        )
      : undefined);

  const usingInjectedCursorClient = config.cursorClient != null;
  const forceFixtureTransmit =
    config.mode === "fixture" || usingInjectedCursorClient;
  const externalCursorAllowed =
    config.mode === "live" &&
    !usingInjectedCursorClient &&
    config.externalCursorAllowed === true;

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

  // Global objective lease — BEFORE any Sol/Cursor work.
  // Separate cloud processes must not concurrently own the same ObjectiveAuthority.
  const leaseStore =
    config.objectiveLeaseStore ??
    resolveObjectiveLeaseStore({
      env: config.env,
    });
  const ownerFingerprint = leaseOwnerFingerprint({
    runId,
    workstreamId: authority.workstreamId,
    env: config.env,
  });
  let leaseHeld = false;
  if (!config.skipObjectiveLease) {
    const acquire = await leaseStore.tryAcquire({
      objectiveId: authority.objectiveId,
      approvalId: authority.approvalId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      runId,
      ownerFingerprint,
      agentId: checkpoint.lastAgentId,
      cursorRunId: checkpoint.lastRunId,
    });
    writeJson(path.join(runDir, "objective-lease.json"), {
      backend: leaseStore.backend,
      acquire,
      ownerFingerprint,
    });
    artifactPaths.objectiveLease = path.join(runDir, "objective-lease.json");
    if (!acquire.ok) {
      terminalVerdict = "RADIO_PHASE3_OBJECTIVE_ALREADY_LEASED";
      stopReason = `${acquire.code}: ${acquire.summary}`;
      const statusEarly = buildPhase3StatusSummary({
        state,
        authority,
        terminalReason: terminalVerdict,
        lastMeaningfulEvent: "OBJECTIVE_LEASE_DENIED",
      });
      writeJson(path.join(runDir, "phase3-status.json"), statusEarly);
      writeJson(path.join(runDir, "phase3-summary.json"), {
        runId,
        terminalVerdict,
        stopReason,
        liveSolCalls: 0,
        cursorCreates: 0,
        leaseBackend: leaseStore.backend,
      });
      return {
        runId,
        terminalVerdict,
        runtimeState: state.radioRuntime.state,
        stateRevision: state.stateRevision,
        iterations: checkpoint.iterations,
        cursorExecutionCount: checkpoint.cursorExecutionCount,
        solDecisionCount: 0,
        transportReconcileCount: checkpoint.transportReconcileCount,
        logicalRetryCount: checkpoint.logicalRetryCount,
        status: statusEarly,
        authority,
        state,
        lastDecision: null,
        lastPolicy: null,
        artifactPaths: {
          ...artifactPaths,
          phase3Status: path.join(runDir, "phase3-status.json"),
          phase3Summary: path.join(runDir, "phase3-summary.json"),
        },
        stopReason,
        canonicalBellhopStateTouched: false,
      };
    }
    leaseHeld = true;
  }

  const markLeaseTerminal = async () => {
    if (!leaseHeld || config.skipObjectiveLease) return;
    await leaseStore.markTerminal({
      objectiveId: authority.objectiveId,
      runId,
    });
  };

  const bindLeaseAgent = async (
    agentId: string | null,
    cursorRunId: string | null,
  ) => {
    if (!leaseHeld || config.skipObjectiveLease) return;
    await leaseStore.updateBinding({
      objectiveId: authority.objectiveId,
      runId,
      agentId,
      cursorRunId,
    });
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
      const initial = await loadInitialDecision(
        config,
        state,
        fingerprint,
        authority,
      );
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

    // Resumable WAITING_FOR_AGENT: reconcile the SAME Cursor run without new Sol/create.
    if (
      state.radioRuntime.state === "WAITING_FOR_AGENT" &&
      state.activeAgent?.agentId &&
      checkpoint.lastWorkOrderId
    ) {
      const workOrderPath = path.join(
        runDir,
        `work-order-iter-${Math.max(1, checkpoint.cursorExecutionCount)}.json`,
      );
      // Prefer exact iter file; fall back to scanning for lastWorkOrderId.
      let workOrder: CursorWorkOrder | null = null;
      if (fs.existsSync(workOrderPath)) {
        workOrder = readJsonFile<CursorWorkOrder>(workOrderPath);
      } else {
        const matches = fs
          .readdirSync(runDir)
          .filter((f) => f.startsWith("work-order-iter-") && f.endsWith(".json"));
        for (const f of matches) {
          const candidate = readJsonFile<CursorWorkOrder>(path.join(runDir, f));
          if (candidate.workOrderId === checkpoint.lastWorkOrderId) {
            workOrder = candidate;
            break;
          }
        }
      }
      if (!workOrder) {
        terminalVerdict = "RADIO_PHASE3_INFRASTRUCTURE_BLOCKED";
        stopReason =
          "WAITING_FOR_AGENT resume failed: durable work order artifact missing";
        break;
      }

      let effectiveCursorClient = cursorClient;
      if (
        !effectiveCursorClient &&
        config.mode === "live" &&
        externalCursorAllowed &&
        !config.skipLiveExecution
      ) {
        const env = config.env ?? process.env;
        const apiKey = resolveCursorApiKey(env);
        if (!apiKey || !isCursorExecutionEnabled(env)) {
          terminalVerdict = "RADIO_PHASE3_IMPLEMENTED_LIVE_NOT_RUN";
          stopReason = "Live Cursor credentials unavailable for WAITING resume";
          break;
        }
        const createClient =
          config.createCursorHttpClient ?? createHttpCursorApiClient;
        effectiveCursorClient = createClient({
          apiKey,
          baseUrl: env.CURSOR_API_BASE_URL?.trim() || "https://api.cursor.com",
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        });
      }
      if (!effectiveCursorClient) {
        terminalVerdict = "RADIO_PHASE3_INFRASTRUCTURE_BLOCKED";
        stopReason = "No Cursor client available for WAITING_FOR_AGENT resume";
        break;
      }

      const prompt = renderCursorPrompt(workOrder);
      const iterRunDir = path.join(
        runDir,
        `exec-${Math.max(1, checkpoint.cursorExecutionCount)}-resume`,
      );
      fs.mkdirSync(iterRunDir, { recursive: true });
      const pollDefaults = resolvePhase3TransmitPollOptions({
        mode: config.mode,
        usingInjectedCursorClient,
        pollIntervalMs: config.pollIntervalMs,
        pollMaxAttempts: config.pollMaxAttempts,
      });
      const transmit = await transmitCursorWorkOrder({
        runId: `${runId}-resume-${checkpoint.cursorExecutionCount}`,
        runDir: iterRunDir,
        state,
        statePath,
        ledgerPath,
        workOrder,
        prompt,
        client: effectiveCursorClient,
        forceFixtureTransmit,
        explicitTransmitMode: externalCursorAllowed,
        externalCursorAllowed,
        pollIntervalMs: pollDefaults.pollIntervalMs,
        pollMaxAttempts: pollDefaults.pollMaxAttempts,
        sleep: config.sleep,
        env: config.env,
        resolveRemoteBranchTip: config.resolveRemoteBranchTip,
        objectiveId: authority.objectiveId,
        skipModelCatalogValidation: forceFixtureTransmit,
      });
      state = transmit.state;
      fingerprint = transmit.fingerprint;
      await bindLeaseAgent(transmit.agentId, transmit.runId);

      if (transmit.terminalVerdict === "RADIO_PHASE1_DISPATCH_WAITING") {
        checkpoint.lastAgentId = transmit.agentId;
        checkpoint.lastRunId = transmit.runId;
        checkpoint.lastMeaningfulEvent = "WAITING_FOR_AGENT_OBSERVATION_BUDGET";
        saveCheckpoint(runDir, checkpoint);
        terminalVerdict = "RADIO_PHASE3_WAITING_FOR_AGENT";
        stopReason =
          "Cursor worker still non-terminal after observation budget; lease retained; resumable";
        break;
      }

      if (
        transmit.terminalVerdict !== "RADIO_PHASE1_RAW_RESULT_READY" &&
        transmit.terminalVerdict !== "RADIO_PHASE1_DISPATCH_COMPLETE"
      ) {
        // Late ERROR / failed terminal on the SAME run — no duplicate create.
        checkpoint.lastAgentId = transmit.agentId;
        checkpoint.lastRunId = transmit.runId;
        checkpoint.lastMeaningfulEvent = "CURSOR_RUN_TERMINAL_NON_SUCCESS";
        saveCheckpoint(runDir, checkpoint);
        writeJson(path.join(runDir, "cursor-late-terminal-evidence.json"), {
          agentId: transmit.agentId,
          runId: transmit.runId,
          terminalVerdict: transmit.terminalVerdict,
          rawResultText: transmit.rawResultText,
          summaryNotes: transmit.summaryNotes,
          workerModel: transmit.workerModel,
        });
        terminalVerdict = "RADIO_PHASE3_BLOCKED";
        stopReason = `Resumed Cursor run ended non-success: ${transmit.terminalVerdict}`;
        break;
      }

      if (
        transmit.terminalVerdict === "RADIO_PHASE1_RAW_RESULT_READY" ||
        transmit.terminalVerdict === "RADIO_PHASE1_DISPATCH_COMPLETE"
      ) {
        checkpoint.lastAgentId = transmit.agentId;
        checkpoint.lastRunId = transmit.runId;
        checkpoint.lastMeaningfulEvent = "CURSOR_RESULT_ACQUIRED";
        saveCheckpoint(runDir, checkpoint);

        const continuationPath =
          config.mode === "fixture"
            ? continuationFixtures[checkpoint.continuationFixtureIndex]
            : undefined;

        if (config.mode === "fixture" && !continuationPath) {
          terminalVerdict = "RADIO_PHASE3_INVALID_SOL_DECISION";
          stopReason =
            "No Sol continuation fixture remaining for resumed WAITING execution";
          break;
        }

        assertLiveModeDoesNotUseFixtureDecisionPath(
          config.mode,
          continuationPath,
          "Phase 3 continuation",
        );

        const rawText =
          transmit.rawResultText ??
          rawResults[checkpoint.rawResultFixtureIndex] ??
          "";

        const phase2 = await runPhase2({
          projectId: config.projectId,
          workstreamId: config.workstreamId,
          transactionId: config.transactionId,
          model: config.model,
          mode: config.mode === "fixture" ? "fixture" : "live",
          nextDecisionFixturePath: continuationPath,
          solPhase2Call: config.solPhase2Call,
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

        if (config.mode === "fixture") {
          checkpoint.continuationFixtureIndex += 1;
        }
        checkpoint.rawResultFixtureIndex += 1;
        checkpoint.solDecisionCount += 1;
        checkpoint.iterations += 1;
        authority = recordIterationUsed(authority);
        persistObjectiveAuthority(authorityWorkingPath, authority);

        state = phase2.state;
        fingerprint = computeStateFingerprint(state);

        persistCompletionAcceptanceContext({
          runDir,
          iteration: checkpoint.iterations,
          rawText,
          workOrder,
          state,
          agentId: transmit.agentId,
          runId: transmit.runId,
          checkpoint,
        });

        if (phase2.solContinuationCalls !== 1) {
          terminalVerdict = "RADIO_PHASE3_INVALID_SOL_DECISION";
          stopReason =
            "Phase 2 Sol call count must be exactly 1 per reviewed execution";
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
          schemaVersion: "phase0-1.0",
          decisionId: phase2.decision.decisionId,
          projectId: config.projectId,
          workstreamId: config.workstreamId,
          transactionId: config.transactionId,
          stateRevision: state.stateRevision,
          requestFingerprint: fingerprint,
          model: config.model,
          mode: config.mode,
          generatedAt: nowIso(),
          cursorExecutionEnabled: externalCursorAllowed,
          notes: [
            "Phase 3 pending decision after WAITING_FOR_AGENT reconciliation",
            `priorAgentId=${transmit.agentId}`,
            `priorRunId=${transmit.runId}`,
          ],
        };

        assertLiveDecisionFreeOfFixtureSemantics({
          mode: config.mode,
          decision: lastDecision,
          context: "Phase 3 continuation decision",
        });

        checkpoint.pendingDecision = lastDecision;
        checkpoint.pendingDecisionEnvelope = lastEnvelope;
        checkpoint.lastMeaningfulEvent = "SOL_NEXT_DECISION_READY";
        saveCheckpoint(runDir, checkpoint);
        writeJson(
          path.join(runDir, `next-decision-iter-${checkpoint.iterations}.json`),
          lastDecision,
        );
        continue;
      }

      break;
    }

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
      await markLeaseTerminal();
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
      const acceptanceGate = await evaluateAcceptWorkstreamGate({
        authority,
        completionContextPath: checkpoint.lastCompletionAcceptanceContextPath,
        resolveRemoteBranchTip: config.resolveRemoteBranchTip,
      });
      writeJson(
        path.join(
          runDir,
          `completion-acceptance-gate-iter-${checkpoint.iterations + 1}.json`,
        ),
        acceptanceGate,
      );

      if (!acceptanceGate.ok) {
        state = applyCompletionAcceptanceFailure(state, acceptanceGate);
        const persisted = persistProjectState({
          state,
          path: statePath,
          expectedRevision: state.stateRevision,
        });
        state = persisted.state;
        fingerprint = persisted.fingerprint;
        await markLeaseTerminal();
        terminalVerdict = "RADIO_PHASE3_READY_FOR_HUMAN";
        stopReason = acceptanceGate.summary;
        checkpoint.lastMeaningfulEvent = "COMPLETION_REQUIREMENTS_FAILED";
        break;
      }

      state = applyAccept(state, lastDecision);
      const persisted = persistProjectState({
        state,
        path: statePath,
        expectedRevision: state.stateRevision,
      });
      state = persisted.state;
      authority = consumeObjectiveAuthority(authority);
      persistObjectiveAuthority(authorityWorkingPath, authority);
      await markLeaseTerminal();
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
      await markLeaseTerminal();
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
    if (
      config.mode === "live" &&
      !usingInjectedCursorClient &&
      !config.skipLiveExecution
    ) {
      const prereqs = validatePhase3ExecutionPrerequisites({
        env: config.env,
      });
      writeJson(
        path.join(runDir, `execution-prerequisites-iter-${checkpoint.cursorExecutionCount + 1}.json`),
        prereqs,
      );
      if (!prereqs.ok || !externalCursorAllowed) {
        terminalVerdict = "RADIO_PHASE3_IMPLEMENTED_LIVE_NOT_RUN";
        stopReason = prereqs.ok
          ? "Live Cursor create not authorized for this invocation"
          : `${prereqs.code}: ${prereqs.summary}`;
        break;
      }
    }

    // Live mode: obtain Phase 1 HTTP Cursor client only after execution gates.
    // Constructing the client does not call the network; POST /v1/agents remains
    // inside transmitCursorWorkOrder after its own durable create gates.
    let effectiveCursorClient = cursorClient;
    if (
      !effectiveCursorClient &&
      config.mode === "live" &&
      externalCursorAllowed &&
      !config.skipLiveExecution
    ) {
      const env = config.env ?? process.env;
      const apiKey = resolveCursorApiKey(env);
      if (!apiKey || !isCursorExecutionEnabled(env)) {
        terminalVerdict = "RADIO_PHASE3_IMPLEMENTED_LIVE_NOT_RUN";
        stopReason = !apiKey
          ? "CURSOR_API_KEY_MISSING: CURSOR_API_KEY is required for live Phase 3 Cursor create"
          : "CURSOR_EXECUTION_DISABLED: CURSOR_EXECUTION_ENABLED must be true with CURSOR_API_KEY for live Cursor create";
        break;
      }
      const createClient =
        config.createCursorHttpClient ?? createHttpCursorApiClient;
      effectiveCursorClient = createClient({
        apiKey,
        baseUrl: env.CURSOR_API_BASE_URL?.trim() || "https://api.cursor.com",
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      });
    }

    if (!effectiveCursorClient) {
      terminalVerdict = "RADIO_PHASE3_INFRASTRUCTURE_BLOCKED";
      stopReason = "No Cursor client available for Phase 3 execution";
      break;
    }

    requireRequestedWork(lastDecision.cursorInstruction);
    const workerModelPolicy = resolveCursorWorkerModelPolicy(
      config.env ?? process.env,
    );
    const workOrder = buildCursorWorkOrder({
      state,
      decision: lastDecision,
      policy: lastPolicy!,
      objectiveAuthority: authority,
      workerModel: workerModelPolicy.defaultModelId,
      env: config.env,
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

    const pollDefaults = resolvePhase3TransmitPollOptions({
      mode: config.mode,
      usingInjectedCursorClient,
      pollIntervalMs: config.pollIntervalMs,
      pollMaxAttempts: config.pollMaxAttempts,
    });
    const transmit = await transmitCursorWorkOrder({
      runId: `${runId}-exec-${checkpoint.cursorExecutionCount + 1}`,
      runDir: iterRunDir,
      state,
      statePath,
      ledgerPath,
      workOrder,
      prompt,
      client: effectiveCursorClient,
      forceFixtureTransmit,
      explicitTransmitMode: externalCursorAllowed,
      externalCursorAllowed,
      pollIntervalMs: pollDefaults.pollIntervalMs,
      pollMaxAttempts: pollDefaults.pollMaxAttempts,
      sleep: config.sleep,
      env: config.env,
      resolveRemoteBranchTip: config.resolveRemoteBranchTip,
      objectiveId: authority.objectiveId,
      workerModelPolicy,
      skipModelCatalogValidation: forceFixtureTransmit,
    });

    state = transmit.state;
    fingerprint = transmit.fingerprint;
    await bindLeaseAgent(transmit.agentId, transmit.runId);

    if (transmit.terminalVerdict === "RADIO_PHASE1_DISPATCH_WAITING") {
      // Observation budget expired; worker still healthy — resumable WAITING.
      if (!wasTransportReconcile && transmit.agentId) {
        authority = recordCursorAgentUsed(authority, {
          logicalRetry: isLogicalRetry,
          usageTokens: transmit.usage?.totalUsage?.totalTokens ?? 0,
        });
        checkpoint.cursorExecutionCount += 1;
        if (isLogicalRetry) {
          checkpoint.logicalRetryCount += 1;
        }
      } else if (wasTransportReconcile) {
        checkpoint.transportReconcileCount += 1;
      }
      checkpoint.lastAgentId = transmit.agentId;
      checkpoint.lastRunId = transmit.runId;
      checkpoint.lastWorkOrderId = workOrder.workOrderId;
      checkpoint.lastMeaningfulEvent = "WAITING_FOR_AGENT_OBSERVATION_BUDGET";
      persistObjectiveAuthority(authorityWorkingPath, authority);
      saveCheckpoint(runDir, checkpoint);
      terminalVerdict = "RADIO_PHASE3_WAITING_FOR_AGENT";
      stopReason =
        "Cursor worker still non-terminal after observation budget; lease retained; resumable — not infrastructure failure";
      break;
    }

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
      config.mode === "fixture"
        ? continuationFixtures[checkpoint.continuationFixtureIndex]
        : undefined;

    if (config.mode === "fixture" && !continuationPath) {
      terminalVerdict = "RADIO_PHASE3_INVALID_SOL_DECISION";
      stopReason = "No Sol continuation fixture remaining for completed execution";
      break;
    }

    assertLiveModeDoesNotUseFixtureDecisionPath(
      config.mode,
      continuationPath,
      "Phase 3 continuation",
    );

    const rawText =
      transmit.rawResultText ??
      rawResults[checkpoint.rawResultFixtureIndex] ??
      "";

    const phase2 = await runPhase2({
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      model: config.model,
      mode: config.mode === "fixture" ? "fixture" : "live",
      nextDecisionFixturePath: continuationPath,
      solPhase2Call: config.solPhase2Call,
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

    if (config.mode === "fixture") {
      checkpoint.continuationFixtureIndex += 1;
    }
    checkpoint.rawResultFixtureIndex += 1;
    checkpoint.solDecisionCount += 1;
    checkpoint.iterations += 1;
    authority = recordIterationUsed(authority);
    persistObjectiveAuthority(authorityWorkingPath, authority);

    state = phase2.state;
    fingerprint = computeStateFingerprint(state);

    persistCompletionAcceptanceContext({
      runDir,
      iteration: checkpoint.iterations,
      rawText,
      workOrder,
      state,
      agentId: transmit.agentId,
      runId: transmit.runId,
      checkpoint,
    });

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
      schemaVersion: "phase0-1.0",
      decisionId: phase2.decision.decisionId,
      projectId: config.projectId,
      workstreamId: config.workstreamId,
      transactionId: config.transactionId,
      stateRevision: state.stateRevision,
      requestFingerprint: fingerprint,
      model: config.model,
      mode: config.mode,
      generatedAt: nowIso(),
      cursorExecutionEnabled: externalCursorAllowed,
      notes: [
        "Phase 3 pending decision after Phase 2 interpret+decide",
        `priorAgentId=${transmit.agentId}`,
        `priorRunId=${transmit.runId}`,
      ],
    };

    assertLiveDecisionFreeOfFixtureSemantics({
      mode: config.mode,
      decision: lastDecision,
      context: "Phase 3 continuation decision",
    });

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
  authority: ObjectiveAuthority,
): Promise<{ decision: OrchestratorDecision; envelope: DecisionEnvelope }> {
  if (config.mode === "fixture") {
    const fixturePath =
      config.initialDecisionFixturePath ??
      resolveRepoPath("fixtures", "decisions", "phase3-initial-launch.json");
    assertLiveModeDoesNotUseFixtureDecisionPath(
      config.mode,
      fixturePath,
      "Phase 3 initial decision",
    );
    const sol = await (config.solCall ?? callSol)({
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

  // Live mode: never load Phase 3 fixture decision files.
  assertLiveModeDoesNotUseFixtureDecisionPath(
    config.mode,
    config.initialDecisionFixturePath,
    "Phase 3 initial decision",
  );

  const brain = loadProjectBrain(config.projectId);
  const context = buildPhase3InitialContext({
    brain: { ...brain, state, fingerprint },
    authority,
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
  });

  const sol = await (config.solCall ?? callSol)({
    context,
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    currentRuntimeState: state.radioRuntime.state,
    model: config.model,
    mode: "live",
  });

  assertLiveDecisionFreeOfFixtureSemantics({
    mode: config.mode,
    decision: sol.decision,
    context: "Phase 3 initial live Sol decision",
  });

  const envelope: DecisionEnvelope = {
    schemaVersion: "phase0-1.0",
    decisionId: sol.decision.decisionId,
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    stateRevision: state.stateRevision,
    requestFingerprint: fingerprint,
    model: sol.model,
    mode: "live",
    generatedAt: nowIso(),
    cursorExecutionEnabled: config.externalCursorAllowed === true,
    notes: [
      "Phase 3 initial decision (live Sol)",
      `objectiveId=${authority.objectiveId}`,
      `approvalId=${authority.approvalId}`,
    ],
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

function applyCompletionAcceptanceFailure(
  state: ProjectState,
  gate: {
    code: string;
    summary: string;
    failedConditions: string[];
  },
): ProjectState {
  let next = transitionRuntimeState(
    state,
    "READY_FOR_HUMAN",
    "PHASE3_COMPLETION_REQUIREMENTS_FAILED",
  );
  next = {
    ...next,
    notes: [
      ...next.notes,
      `RADIO_COMPLETION_ACCEPTANCE_GATE:${gate.code}:${gate.summary}`,
      ...gate.failedConditions.map((c) => `RADIO_COMPLETION_FAILURE:${c}`),
    ],
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

function persistCompletionAcceptanceContext(input: {
  runDir: string;
  iteration: number;
  rawText: string;
  workOrder: CursorWorkOrder;
  state: ProjectState;
  agentId: string | null;
  runId: string | null;
  checkpoint: Phase3Checkpoint;
}): string {
  const diagnostics = diagnoseStructuredWorkerReport(input.rawText, {
    state: input.state,
    workOrder: input.workOrder,
    expectedAgentId: input.agentId,
    expectedRunId: input.runId,
  });
  const contextPath = path.join(
    input.runDir,
    `completion-acceptance-context-iter-${input.iteration}.json`,
  );
  writeJson(
    contextPath,
    buildCompletionAcceptanceContextArtifact({
      workOrder: input.workOrder,
      diagnostics,
    }),
  );
  input.checkpoint.lastCompletionAcceptanceContextPath = contextPath;
  return contextPath;
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
    lastCompletionAcceptanceContextPath: null,
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
