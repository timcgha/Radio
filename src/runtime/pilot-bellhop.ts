import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { persistPhase0Artifacts } from "../artifacts/writer.js";
import { renderCursorPrompt } from "../cursor/prompt-renderer.js";
import { buildCursorWorkOrder } from "../cursor/work-order-builder.js";
import {
  canLiveCursorDispatch,
  isCursorExecutionEnabled,
  isLiveTransmitAuthorized,
  resolveCursorApiKey,
} from "../cursor/api-client.js";
import { buildSolContext } from "../orchestrator/context-builder.js";
import { callSol } from "../orchestrator/sol-adapter.js";
import { evaluatePolicy } from "../policy/engine.js";
import { loadBellhopBrain, loadProjectState } from "../state/store.js";
import { defaultLedgerPath } from "../state/ledger.js";
import {
  ensureLedgerFile,
  transmitCursorWorkOrder,
} from "./transmitter.js";
import {
  bellhopPlanningSeedPath,
  runPhase2,
  type Phase2Result,
} from "./phase2.js";
import {
  loadObjectiveAuthority,
  resolvePhase3LiveIdentities,
  STAGE2_PLAYTEST_APPROVAL_ID,
} from "./objective-authority.js";
import {
  phase3DefaultObjectivePath,
  phase3PlanningSeedPath,
  runPhase3Loop,
  type Phase3LoopResult,
} from "./phase3.js";
import {
  recoverInvalidReport,
  type RecoverInvalidReportResult,
} from "./recover-invalid-report.js";
import type {
  DecisionEnvelope,
  Phase0Config,
  RadioTerminalVerdict,
  RunSummary,
} from "../types.js";
import { newId, nowIso, resolveRepoPath } from "../util/io.js";

export const DEFAULT_MODEL = "gpt-5.6-sol";

/**
 * Phase 3 live Cursor authorization model:
 * explicit objective authority + CURSOR_EXECUTION_ENABLED + CURSOR_API_KEY.
 * Does NOT require Phase 1 --transmit (objective authority is the human gate).
 */
export function resolvePhase3LiveCursorAuthorization(input: {
  phase3Live: boolean;
  fixtureMode: boolean;
  env?: NodeJS.ProcessEnv;
}): {
  liveCursorDispatchAuthorized: boolean;
  externalCursorAllowed: boolean;
} {
  const authorized =
    input.phase3Live &&
    !input.fixtureMode &&
    canLiveCursorDispatch(input.env);
  return {
    liveCursorDispatchAuthorized: authorized,
    externalCursorAllowed: authorized,
  };
}

function readArgValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

export function resolvePhase0Config(argv: string[] = process.argv): Phase0Config {
  const fixture = argv.includes("--fixture");
  const phase1FixtureTransmit =
    argv.includes("--phase1-fixture") ||
    argv.includes("--transmit-fixture");
  const phase2Fixture =
    argv.includes("--phase2-fixture") || argv.includes("--phase2:fixture");
  const phase3Fixture =
    argv.includes("--phase3-fixture") || argv.includes("--phase3:fixture");
  const phase3Live =
    argv.includes("--phase3") &&
    !phase3Fixture &&
    !phase2Fixture &&
    !fixture &&
    !phase1FixtureTransmit;
  const phase2Live =
    argv.includes("--phase2") &&
    !phase2Fixture &&
    !phase3Fixture &&
    !phase3Live &&
    !fixture &&
    !phase1FixtureTransmit;
  const recoverInvalidReportFixture =
    argv.includes("--recover-invalid-report-fixture");
  const recoverInvalidReportLive =
    argv.includes("--recover-invalid-report") && !recoverInvalidReportFixture;
  const fixtureMode =
    fixture ||
    phase1FixtureTransmit ||
    phase2Fixture ||
    phase3Fixture ||
    recoverInvalidReportFixture;
  // Exact flag match — "--transmit-fixture" is NOT "--transmit".
  const explicitTransmitMode =
    argv.includes("--transmit") &&
    !fixtureMode &&
    !phase2Live &&
    !phase3Live &&
    !recoverInvalidReportLive &&
    !recoverInvalidReportFixture;
  const model = process.env.RADIO_MODEL?.trim() || DEFAULT_MODEL;
  const cursorExecutionEnabled = isCursorExecutionEnabled();
  const cursorApiKeyPresent = resolveCursorApiKey() !== null;
  const phase3LiveCursorAuth = resolvePhase3LiveCursorAuthorization({
    phase3Live,
    fixtureMode,
  });
  const phase1LiveCursorAuth = isLiveTransmitAuthorized({
    explicitTransmitMode,
    fixtureMode:
      fixtureMode || phase2Live || phase3Live || recoverInvalidReportLive,
  });
  // Phase 3 live: objective authority + execution env gates (no --transmit).
  // Phase 1 live: explicit --transmit + execution env gates.
  const liveCursorDispatchAuthorized =
    phase3LiveCursorAuth.liveCursorDispatchAuthorized ||
    phase1LiveCursorAuth;
  const externalCursorAllowed =
    phase3LiveCursorAuth.externalCursorAllowed ||
    (phase1LiveCursorAuth &&
      !fixtureMode &&
      !phase2Live &&
      !recoverInvalidReportLive);

  const humanAuthorized = argv.includes("--human-authorized");
  const expectedRevisionRaw = readArgValue(argv, "--expected-revision");
  const expectedRevision =
    expectedRevisionRaw != null ? Number.parseInt(expectedRevisionRaw, 10) : null;
  const validationArtifactPath =
    readArgValue(argv, "--validation-artifact") ??
    (recoverInvalidReportFixture || recoverInvalidReportLive
      ? resolveRepoPath(
          "fixtures",
          "phase2",
          "bellhop-prose-halt-precheck-validation.json",
        )
      : null);
  const objectiveAuthorityPath =
    readArgValue(argv, "--objective-authority") ??
    (phase3Fixture
      ? resolveRepoPath("fixtures", "phase3", "objective-authority.json")
      : null);

  return {
    projectId: "bellhop",
    workstreamId: phase3Fixture
      ? "radio-phase3-fixture-01"
      : "radio-pilot-01",
    transactionId: phase3Fixture
      ? "radio-phase3-fixture-01-bounded-verify"
      : "bellhop-radio-pilot-01-stage2-verification",
    model,
    cursorExecutionEnabled,
    cursorApiKeyPresent,
    liveCursorDispatchAuthorized,
    explicitTransmitMode,
    externalCursorAllowed,
    phase1FixtureTransmit,
    phase2Fixture,
    phase2Live,
    phase3Fixture,
    phase3Live,
    objectiveAuthorityPath,
    recoverInvalidReport: recoverInvalidReportLive || recoverInvalidReportFixture,
    recoverInvalidReportFixture,
    humanAuthorized,
    expectedRevision:
      expectedRevisionRaw != null && Number.isFinite(expectedRevision)
        ? expectedRevision
        : null,
    validationArtifactPath,
    mode: fixtureMode ? "fixture" : "live",
    fixturePath: resolveRepoPath(
      "fixtures",
      "decisions",
      phase3Fixture
        ? "phase3-initial-launch.json"
        : "bellhop-legal-launch-cursor.json",
    ),
    projectRoot: resolveRepoPath(),
    pollIntervalMs: phase1FixtureTransmit || phase3Fixture ? 1 : undefined,
    pollMaxAttempts: phase1FixtureTransmit || phase3Fixture ? 5 : undefined,
  };
}

/**
 * Bellhop pilot pipeline.
 * Phase 0: DECIDE → POLICY → WORK ORDER → STOP
 * Phase 1: … → TRANSMIT → WAIT → STORE RAW CURSOR RESULT → VERIFYING → STOP
 * Phase 2: VALIDATE RESULT → RECONCILE → REVIEW → SOL NEXT DECISION → POLICY → STOP
 * Phase 3: REPEAT EXECUTE / OBSERVE / DECIDE UNTIL TERMINAL OR HUMAN GATE
 */
export async function runBellhopPilot(config: Phase0Config = resolvePhase0Config()) {
  if (config.recoverInvalidReport) {
    return runBellhopInvalidReportRecovery(config);
  }
  if (config.phase3Fixture || config.phase3Live) {
    return runBellhopPhase3(config);
  }
  if (config.phase2Fixture || config.phase2Live) {
    return runBellhopPhase2(config);
  }

  const runId = newId("run");
  const runDir = resolveRepoPath("artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  // Phase 0/1 fixtures must not mutate checked-in PROJECT-STATE.json.
  // After Phase 1 live transmit, canonical state is VERIFYING; Phase 0/1
  // regression fixtures therefore seed from the immutable PLANNING snapshot.
  let statePath =
    config.statePath ??
    resolveRepoPath("projects", config.projectId, "PROJECT-STATE.json");
  let ledgerPath =
    config.ledgerPath ?? defaultLedgerPath(config.projectId);

  if (
    (config.phase1FixtureTransmit || config.mode === "fixture") &&
    !config.statePath
  ) {
    const workingState = path.join(runDir, "PROJECT-STATE.working.json");
    const seedPath = bellhopPlanningSeedPath();
    fs.copyFileSync(seedPath, workingState);
    statePath = workingState;
    ledgerPath = path.join(runDir, "RUN-LEDGER.jsonl");
  }

  const brain = loadBellhopBrain();
  const loaded = loadProjectState({
    projectId: config.projectId,
    statePath,
  });

  let { state, fingerprint } = loaded;
  const contextBrain = { ...brain, state, fingerprint };

  const context = buildSolContext({
    brain: contextBrain,
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
  });

  const sol = await callSol({
    context,
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    currentRuntimeState: state.radioRuntime.state,
    model: config.model,
    mode: config.mode,
    fixturePath: config.fixturePath,
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
    mode: sol.mode,
    generatedAt: nowIso(),
    cursorExecutionEnabled: config.cursorExecutionEnabled,
    notes: [
      "Fingerprint is stored on the envelope because decision.schema.json has no fingerprint field.",
      "Policy compares envelope.requestFingerprint to the loaded authoritative fingerprint.",
      "Live Cursor dispatch requires --transmit AND CURSOR_EXECUTION_ENABLED=true AND CURSOR_API_KEY.",
      "Fixture mode structurally sets EXTERNAL_CURSOR_ALLOWED=false.",
      ...sol.schemaCompatNotes,
    ],
  };

  const policy = evaluatePolicy({
    decision: sol.decision,
    state,
    envelope,
    currentFingerprint: fingerprint,
  });

  let workOrder = null;
  let cursorPrompt: string | null = null;
  let terminalVerdict: RadioTerminalVerdict = "RADIO_PHASE0_BLOCKED";
  let cursorApiCalled = false;
  let cursorAgentId: string | null = null;
  let transmitArtifacts: Record<string, string> = {};

  if (policy.result === "ALLOW") {
    if (
      sol.decision.decision === "LAUNCH_CURSOR" ||
      sol.decision.decision === "REUSE_CURSOR"
    ) {
      workOrder = buildCursorWorkOrder({
        state,
        decision: sol.decision,
        policy,
      });
      cursorPrompt = renderCursorPrompt(workOrder);

      // Fixture transmit uses mock only. Live transmit requires three-part auth.
      const shouldTransmit =
        config.phase1FixtureTransmit || config.liveCursorDispatchAuthorized;

      if (shouldTransmit && workOrder && cursorPrompt) {
        ensureLedgerFile(ledgerPath);

        const transmit = await transmitCursorWorkOrder({
          runId,
          runDir,
          state,
          statePath,
          ledgerPath,
          workOrder,
          prompt: cursorPrompt,
          forceFixtureTransmit: config.phase1FixtureTransmit,
          explicitTransmitMode: config.explicitTransmitMode,
          externalCursorAllowed: config.externalCursorAllowed,
          pollIntervalMs: config.pollIntervalMs,
          pollMaxAttempts: config.pollMaxAttempts,
        });

        state = transmit.state;
        fingerprint = transmit.fingerprint;
        cursorApiCalled = transmit.cursorApiCalled;
        cursorAgentId = transmit.agentId;
        transmitArtifacts = transmit.artifactPaths;
        terminalVerdict = transmit.terminalVerdict;
      } else {
        // Phase 1 implemented but live dispatch not authorized for this invocation.
        if (
          config.mode === "fixture" &&
          !config.phase1FixtureTransmit
        ) {
          // Phase 0 fixture dry-run never transmits (regardless of live env gates).
          terminalVerdict = "RADIO_PHASE0_DRY_RUN_COMPLETE";
        } else if (config.explicitTransmitMode && !config.cursorApiKeyPresent) {
          terminalVerdict = "RADIO_PHASE1_BLOCKED";
        } else if (
          config.explicitTransmitMode &&
          !config.cursorExecutionEnabled
        ) {
          terminalVerdict = "RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN";
        } else {
          terminalVerdict = "RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN";
        }
      }
    } else {
      terminalVerdict = "RADIO_PHASE0_DRY_RUN_COMPLETE";
    }
  } else if (policy.result === "REQUIRE_HUMAN") {
    terminalVerdict = "RADIO_PHASE0_HUMAN_REQUIRED";
  } else if (policy.result === "REJECT") {
    terminalVerdict = "RADIO_PHASE0_POLICY_REJECTED";
  } else {
    terminalVerdict = "RADIO_PHASE0_BLOCKED";
  }

  const summary: RunSummary = {
    runId,
    projectId: config.projectId,
    stateRevision: state.stateRevision,
    stateFingerprint: fingerprint,
    model: sol.model,
    mode: sol.mode,
    decision: sol.decision.decision,
    policyOutcome: policy.result,
    agentAction: sol.decision.cursorInstruction?.agentAction ?? null,
    workType: sol.decision.cursorInstruction?.workType ?? null,
    cursorExecutionEnabled: config.cursorExecutionEnabled,
    cursorApiCalled,
    liveCursorDispatchAuthorized: config.liveCursorDispatchAuthorized,
    cursorAgentId,
    artifactPaths: {},
    terminalVerdict,
  };

  const artifacts = persistPhase0Artifacts({
    runId,
    decision: sol.decision,
    envelope,
    policy,
    workOrder,
    cursorPrompt,
    summary,
    solRawText: sol.mode === "live" ? sol.rawText : undefined,
  });

  summary.artifactPaths = {
    decision: artifacts.paths.decision,
    decisionEnvelope: artifacts.paths.decisionEnvelope,
    policyEvaluation: artifacts.paths.policyEvaluation,
    workOrder: artifacts.paths.workOrder ?? "",
    cursorPrompt: artifacts.paths.cursorPrompt ?? "",
    runSummary: artifacts.paths.runSummary,
    ...transmitArtifacts,
  };

  printSummary({
    projectName: state.project.name,
    stateRevision: state.stateRevision,
    fingerprint,
    decision: sol.decision.decision,
    agentAction: summary.agentAction,
    workType: summary.workType,
    policy: policy.result,
    paths: artifacts.paths,
    terminalVerdict,
    cursorExecutionEnabled: config.cursorExecutionEnabled,
    liveCursorDispatchAuthorized: config.liveCursorDispatchAuthorized,
    explicitTransmitMode: config.explicitTransmitMode,
    externalCursorAllowed: config.externalCursorAllowed,
    cursorApiCalled,
    cursorAgentId,
    runtimeState: state.radioRuntime.state,
  });

  return {
    runId,
    state,
    fingerprint,
    context,
    decision: sol.decision,
    envelope,
    policy,
    workOrder,
    cursorPrompt,
    summary,
    artifacts,
    terminalVerdict,
    cursorApiCalled,
    cursorAgentId,
  };
}

async function runBellhopInvalidReportRecovery(config: Phase0Config) {
  if (config.expectedRevision == null) {
    throw new Error(
      "Invalid-report recovery requires --expected-revision <n>",
    );
  }
  if (!config.validationArtifactPath) {
    throw new Error(
      "Invalid-report recovery requires --validation-artifact <path>",
    );
  }

  const runDir = resolveRepoPath("artifacts", "runs", newId("run"));
  fs.mkdirSync(runDir, { recursive: true });

  const statePath =
    config.statePath ??
    (config.recoverInvalidReportFixture
      ? resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json")
      : resolveRepoPath("projects", config.projectId, "PROJECT-STATE.json"));
  const ledgerPath =
    config.ledgerPath ??
    (config.recoverInvalidReportFixture
      ? path.join(runDir, "RUN-LEDGER.seed.jsonl")
      : defaultLedgerPath(config.projectId));

  // Fixture path never touches canonical PROJECT-STATE.json.
  const result: RecoverInvalidReportResult = recoverInvalidReport({
    projectId: config.projectId,
    statePath,
    ledgerPath,
    humanAuthorized: config.humanAuthorized,
    expectedRevision: config.expectedRevision,
    validationArtifactPath: config.validationArtifactPath,
    runDir,
    isolateState: config.recoverInvalidReportFixture || Boolean(config.statePath),
  });

  console.log("");
  console.log("RADIO v0.1 — BELLHOP INVALID-REPORT RECOVERY");
  console.log("");
  console.log(`Human authorized: ${config.humanAuthorized ? "YES" : "NO"}`);
  console.log(`Result: ${result.code}`);
  console.log(`Runtime before: ${result.runtimeStateBefore ?? "(n/a)"}`);
  console.log(`Runtime after: ${result.runtimeStateAfter ?? "(n/a)"}`);
  console.log(`Revision before: ${result.stateRevisionBefore ?? "(n/a)"}`);
  console.log(`Revision after: ${result.stateRevisionAfter ?? "(n/a)"}`);
  console.log(`Rejected agent: ${result.rejectedAgentId ?? "(n/a)"}`);
  console.log(`Rejected work order: ${result.rejectedWorkOrderId ?? "(n/a)"}`);
  console.log(`Cursor calls: ${result.cursorCallCount}`);
  console.log(`OpenAI calls: ${result.openaiCallCount}`);
  console.log(
    `Bellhop product mutations: ${result.bellhopProductMutationCount}`,
  );
  console.log(
    `Future retry automatically launched: ${result.futureRetryAutomaticallyLaunched ? "YES" : "NO"}`,
  );
  console.log("");
  console.log(result.terminalVerdict);
  console.log("");

  return {
    runId: path.basename(runDir),
    state: result.state,
    fingerprint: "",
    context: null,
    decision: null,
    envelope: null,
    policy: null,
    workOrder: null,
    cursorPrompt: null,
    summary: {
      runId: path.basename(runDir),
      projectId: config.projectId,
      stateRevision: result.stateRevisionAfter ?? 0,
      stateFingerprint: "",
      model: config.model,
      mode: config.recoverInvalidReportFixture
        ? ("fixture" as const)
        : ("live" as const),
      decision: null,
      policyOutcome: null,
      agentAction: null,
      workType: null,
      cursorExecutionEnabled: false,
      cursorApiCalled: false,
      liveCursorDispatchAuthorized: false,
      cursorAgentId: result.rejectedAgentId,
      artifactPaths: result.artifactPaths,
      terminalVerdict: result.terminalVerdict as RadioTerminalVerdict,
    },
    artifacts: {
      runId: path.basename(runDir),
      runDir,
      paths: result.artifactPaths,
    },
    terminalVerdict: result.terminalVerdict as RadioTerminalVerdict,
    cursorApiCalled: false,
    cursorAgentId: result.rejectedAgentId,
    recovery: result,
  };
}

async function runBellhopPhase3(config: Phase0Config) {
  const runId = newId("run");
  const runDir = resolveRepoPath("artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  if (config.phase3Live) {
    if (!config.objectiveAuthorityPath) {
      throw new Error(
        "OBJECTIVE_AUTHORITY_REQUIRED: --objective-authority <path> is required",
      );
    }

    const authority = loadObjectiveAuthority(config.objectiveAuthorityPath);
    const identities = resolvePhase3LiveIdentities({
      authority,
      state: loadProjectState({
        projectId: config.projectId,
        statePath:
          config.statePath ??
          resolveRepoPath("projects", config.projectId, "PROJECT-STATE.json"),
      }).state,
    });

    const statePath =
      config.statePath ??
      resolveRepoPath("projects", config.projectId, "PROJECT-STATE.json");
    const ledgerPath =
      config.ledgerPath ?? defaultLedgerPath(config.projectId);
    ensureLedgerFile(ledgerPath);

    const authorityWorkingPath = path.join(runDir, "objective-authority.json");
    fs.copyFileSync(config.objectiveAuthorityPath, authorityWorkingPath);

    const result: Phase3LoopResult = await runPhase3Loop({
      projectId: identities.projectId,
      workstreamId: identities.workstreamId,
      transactionId: identities.transactionId,
      model: config.model,
      mode: "live",
      objectiveAuthorityPath: authorityWorkingPath,
      statePath,
      ledgerPath,
      runDir,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
      externalCursorAllowed: config.externalCursorAllowed,
      pollIntervalMs: config.pollIntervalMs,
      pollMaxAttempts: config.pollMaxAttempts,
    });

    printPhase3Summary(result, config, "live");
    return buildPhase3PilotReturn(result, config, runDir, "live");
  }

  const workingState = path.join(runDir, "PROJECT-STATE.working.json");
  fs.copyFileSync(phase3PlanningSeedPath(), workingState);
  const ledgerPath = path.join(runDir, "RUN-LEDGER.jsonl");
  const authorityPath = path.join(runDir, "objective-authority.json");
  fs.copyFileSync(
    config.objectiveAuthorityPath ?? phase3DefaultObjectivePath(),
    authorityPath,
  );

  const failRaw = fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-fail.txt"),
    "utf8",
  );
  const passRaw = fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
    "utf8",
  );

  const result: Phase3LoopResult = await runPhase3Loop({
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    model: config.model,
    mode: "fixture",
    objectiveAuthorityPath: authorityPath,
    statePath: workingState,
    ledgerPath,
    initialDecisionFixturePath: resolveRepoPath(
      "fixtures",
      "decisions",
      "phase3-initial-launch.json",
    ),
    continuationDecisionFixturePaths: [
      resolveRepoPath("fixtures", "decisions", "phase3-retry-launch.json"),
      resolveRepoPath("fixtures", "decisions", "phase3-human-gate.json"),
    ],
    cursorRawResultSequence: [failRaw, passRaw],
    pollIntervalMs: config.pollIntervalMs ?? 1,
    pollMaxAttempts: config.pollMaxAttempts ?? 5,
    runDir,
    foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
  });

  printPhase3Summary(result, config, "fixture");
  return buildPhase3PilotReturn(result, config, runDir, "fixture");
}

function printPhase3Summary(
  result: Phase3LoopResult,
  config: Phase0Config,
  mode: "live" | "fixture",
): void {
  console.log("");
  console.log("RADIO v0.1 — BELLHOP PILOT PHASE 3");
  console.log("");
  console.log(`Mode: ${mode}`);
  console.log(`Iterations: ${result.iterations}`);
  console.log(`Cursor executions: ${result.cursorExecutionCount}`);
  console.log(`Sol decisions: ${result.solDecisionCount}`);
  console.log(`Logical retries: ${result.logicalRetryCount}`);
  console.log(`Transport reconciles: ${result.transportReconcileCount}`);
  console.log(`Runtime state: ${result.runtimeState}`);
  console.log(`State revision: ${result.stateRevision}`);
  console.log(`Status: ${result.status.status}`);
  console.log(`Human action required: ${result.status.humanActionRequired}`);
  console.log(`Stop reason: ${result.stopReason}`);
  console.log(
    `Canonical Bellhop state touched: ${result.canonicalBellhopStateTouched}`,
  );
  console.log(`Live OpenAI calls: 0`);
  console.log(`Live Cursor calls: 0`);
  console.log("");
  console.log(result.terminalVerdict);
  console.log("");
}

function buildPhase3PilotReturn(
  result: Phase3LoopResult,
  config: Phase0Config,
  runDir: string,
  mode: "live" | "fixture",
) {
  return {
    runId: result.runId,
    state: result.state,
    fingerprint: "",
    context: null,
    decision: result.lastDecision,
    envelope: null,
    policy: result.lastPolicy,
    workOrder: null,
    cursorPrompt: null,
    summary: {
      runId: result.runId,
      projectId: config.projectId,
      stateRevision: result.stateRevision,
      stateFingerprint: "",
      model: config.model,
      mode: mode as "live" | "fixture",
      decision: result.lastDecision?.decision ?? null,
      policyOutcome: result.lastPolicy?.result ?? null,
      agentAction: null,
      workType: null,
      cursorExecutionEnabled: config.cursorExecutionEnabled,
      cursorApiCalled: false,
      liveCursorDispatchAuthorized: config.liveCursorDispatchAuthorized,
      cursorAgentId: result.status.activeAgentId,
      artifactPaths: result.artifactPaths,
      terminalVerdict: result.terminalVerdict,
    },
    artifacts: { runId: result.runId, runDir, paths: result.artifactPaths },
    terminalVerdict: result.terminalVerdict,
    cursorApiCalled: false,
    cursorAgentId: result.status.activeAgentId,
    phase3: result,
  };
}

async function runBellhopPhase2(config: Phase0Config) {
  const isFixture = config.phase2Fixture === true;

  // Live mode: NEVER default to historical fixture agent/run IDs.
  // Resolve from explicit env and/or Radio-owned state inside runPhase2.
  const envAgentId = process.env.RADIO_PHASE2_CURSOR_AGENT_ID?.trim() || null;
  const envRunId = process.env.RADIO_PHASE2_CURSOR_RUN_ID?.trim() || null;

  const agentId = isFixture
    ? envAgentId || "bc-f4e61939-43e9-4eb8-94c4-4c3c1a9e5df5"
    : envAgentId;
  const runId = isFixture
    ? envRunId || "run-fb22133a-f1b6-4c56-938a-ab2cae667efe"
    : envRunId;

  const result: Phase2Result = await runPhase2({
    projectId: config.projectId,
    workstreamId: config.workstreamId,
    transactionId: config.transactionId,
    model: config.model,
    mode: isFixture ? "fixture" : "live",
    nextDecisionFixturePath: isFixture
      ? resolveRepoPath(
          "fixtures",
          "decisions",
          "bellhop-phase2-schema-invalid-next.json",
        )
      : undefined,
    statePath:
      config.statePath ??
      (isFixture
        ? resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json")
        : undefined),
    isolateState: true,
    cursorAgentId: agentId,
    cursorRunId: runId,
    workOrderPath: process.env.RADIO_PHASE2_WORK_ORDER_PATH?.trim() || undefined,
    // Live Phase 2 may retrieve completed run read-only; never create.
    allowReadOnlyCursorRetrieval: config.phase2Live === true,
  });

  console.log("");
  console.log("RADIO v0.1 — BELLHOP PILOT PHASE 2");
  console.log("");
  console.log(
    `Structured worker report: ${result.structuredWorkerReportStatus ?? "(n/a)"}`,
  );
  console.log(`Report valid: ${result.reportValid ? "YES" : "NO"}`);
  console.log(`Work outcome: ${result.workOutcome ?? "(n/a)"}`);
  if (result.assessment) {
    console.log(
      `Sol assessment: ${result.assessment.resultClass} (${result.assessment.confidence})`,
    );
  }
  console.log(`Runtime state: ${result.runtimeState}`);
  console.log(`State revision: ${result.stateRevision}`);
  console.log(`Sol continuation calls: ${result.solContinuationCalls}`);
  console.log(`Cursor create calls: ${result.cursorCreateCalls}`);
  console.log(`Cursor follow-up calls: ${result.cursorFollowUpCalls}`);
  if (result.decision) {
    console.log(`Next decision: ${result.decision.decision}`);
  }
  if (result.policy) {
    console.log(`Policy: ${result.policy.result} (${result.policy.primaryCode})`);
  }
  console.log(`Next action executed: NO`);
  console.log("");
  console.log(result.terminalVerdict);
  console.log("");

  return {
    runId: result.runId,
    state: result.state,
    fingerprint: "",
    context: null,
    decision: result.decision,
    envelope: null,
    policy: result.policy,
    workOrder: null,
    cursorPrompt: null,
    summary: {
      runId: result.runId,
      projectId: config.projectId,
      stateRevision: result.stateRevision,
      stateFingerprint: "",
      model: config.model,
      mode: isFixture ? ("fixture" as const) : ("live" as const),
      decision: result.decision?.decision ?? null,
      policyOutcome: result.policy?.result ?? null,
      agentAction: null,
      workType: null,
      cursorExecutionEnabled: false,
      cursorApiCalled: false,
      liveCursorDispatchAuthorized: false,
      cursorAgentId: result.preservedAgentAttribution.agentId,
      artifactPaths: result.artifactPaths,
      terminalVerdict: result.terminalVerdict,
    },
    artifacts: { runId: result.runId, runDir: "", paths: result.artifactPaths },
    terminalVerdict: result.terminalVerdict,
    cursorApiCalled: false,
    cursorAgentId: result.preservedAgentAttribution.agentId,
    phase2: result,
  };
}

function printSummary(input: {
  projectName: string;
  stateRevision: number;
  fingerprint: string;
  decision: string;
  agentAction: string | null;
  workType: string | null;
  policy: string;
  paths: {
    decision: string;
    policyEvaluation: string;
    workOrder: string | null;
    cursorPrompt: string | null;
  };
  terminalVerdict: string;
  cursorExecutionEnabled: boolean;
  liveCursorDispatchAuthorized: boolean;
  explicitTransmitMode: boolean;
  externalCursorAllowed: boolean;
  cursorApiCalled: boolean;
  cursorAgentId: string | null;
  runtimeState: string;
}): void {
  const rel = (p: string | null) =>
    p ? path.relative(resolveRepoPath(), p) : "(not generated)";

  console.log("");
  console.log("RADIO v0.1 — BELLHOP PILOT");
  console.log("");
  console.log(`Project: ${input.projectName}`);
  console.log(`State revision: ${input.stateRevision}`);
  console.log(`State fingerprint: ${input.fingerprint}`);
  console.log(`Runtime state: ${input.runtimeState}`);
  console.log("");
  console.log(`Sol decision: ${input.decision}`);
  console.log(`Agent action: ${input.agentAction ?? "(none)"}`);
  console.log(`Work type: ${input.workType ?? "(none)"}`);
  console.log("");
  console.log(`Policy: ${input.policy}`);
  console.log("");
  console.log(
    `Cursor execution enabled: ${input.cursorExecutionEnabled ? "true" : "false"}`,
  );
  console.log(
    `Explicit transmit mode: ${input.explicitTransmitMode ? "true" : "false"}`,
  );
  console.log(
    `External Cursor allowed: ${input.externalCursorAllowed ? "true" : "false"}`,
  );
  console.log(
    `Live Cursor dispatch authorized: ${input.liveCursorDispatchAuthorized ? "true" : "false"}`,
  );
  console.log(`Cursor API called: ${input.cursorApiCalled ? "YES" : "NO"}`);
  if (input.cursorAgentId) {
    console.log(`Cursor agent ID: ${input.cursorAgentId}`);
  }
  console.log("");
  console.log("Generated:");
  console.log(rel(input.paths.decision));
  console.log(rel(input.paths.policyEvaluation));
  console.log(rel(input.paths.workOrder));
  console.log(rel(input.paths.cursorPrompt));
  console.log("");
  console.log(input.terminalVerdict);
  console.log("");
}

async function main(): Promise<void> {
  try {
    const result = await runBellhopPilot();
    const successVerdicts = new Set<string>([
      "RADIO_PHASE0_DRY_RUN_COMPLETE",
      "RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN",
      "RADIO_PHASE1_DISPATCH_COMPLETE",
      "RADIO_PHASE1_DISPATCH_WAITING",
      "RADIO_PHASE1_RAW_RESULT_READY",
      "RADIO_PHASE2_NEXT_ACTION_READY",
      "RADIO_PHASE3_AUTONOMOUS_LOOP_READY",
      "RADIO_PHASE3_READY_FOR_HUMAN",
      "RADIO_PHASE3_OBJECTIVE_COMPLETE",
      "RADIO_PHASE3_BUDGET_EXHAUSTED",
      "RADIO_PHASE3_ITERATION_LIMIT_REACHED",
      "RADIO_PHASE3_POLICY_REJECTED",
      "RADIO_INVALID_REPORT_RECOVERY_APPLIED",
    ]);
    process.exitCode = successVerdicts.has(result.terminalVerdict) ? 0 : 1;
  } catch (err) {
    const config = resolvePhase0Config();
    const label =
      config.recoverInvalidReport
        ? "RADIO_INVALID_REPORT_RECOVERY_DENIED"
        : config.phase3Fixture || config.phase3Live
          ? "RADIO_PHASE3_BLOCKED"
          : config.phase2Fixture || config.phase2Live
            ? "RADIO_PHASE2_BLOCKED"
            : "RADIO_PHASE1_BLOCKED";
    console.error(label);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

const invokedAsCli =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsCli) {
  void main();
}
