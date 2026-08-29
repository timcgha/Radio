import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { persistPhase0Artifacts } from "../artifacts/writer.js";
import { renderCursorPrompt } from "../cursor/prompt-renderer.js";
import { buildCursorWorkOrder } from "../cursor/work-order-builder.js";
import {
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
import type {
  DecisionEnvelope,
  Phase0Config,
  RadioTerminalVerdict,
  RunSummary,
} from "../types.js";
import { newId, nowIso, resolveRepoPath } from "../util/io.js";

export const DEFAULT_MODEL = "gpt-5.6-sol";

export function resolvePhase0Config(argv: string[] = process.argv): Phase0Config {
  const fixture = argv.includes("--fixture");
  const phase1FixtureTransmit =
    argv.includes("--phase1-fixture") ||
    argv.includes("--transmit-fixture");
  const fixtureMode = fixture || phase1FixtureTransmit;
  // Exact flag match — "--transmit-fixture" is NOT "--transmit".
  const explicitTransmitMode = argv.includes("--transmit") && !fixtureMode;
  const model = process.env.RADIO_MODEL?.trim() || DEFAULT_MODEL;
  const cursorExecutionEnabled = isCursorExecutionEnabled();
  const cursorApiKeyPresent = resolveCursorApiKey() !== null;
  const liveCursorDispatchAuthorized = isLiveTransmitAuthorized({
    explicitTransmitMode,
    fixtureMode,
  });
  // Fixture paths structurally forbid external Cursor HTTP.
  const externalCursorAllowed = liveCursorDispatchAuthorized && !fixtureMode;

  return {
    projectId: "bellhop",
    workstreamId: "radio-pilot-01",
    transactionId: "bellhop-radio-pilot-01-stage2-verification",
    model,
    cursorExecutionEnabled,
    cursorApiKeyPresent,
    liveCursorDispatchAuthorized,
    explicitTransmitMode,
    externalCursorAllowed,
    phase1FixtureTransmit,
    mode: fixtureMode ? "fixture" : "live",
    fixturePath: resolveRepoPath(
      "fixtures",
      "decisions",
      "bellhop-legal-launch-cursor.json",
    ),
    projectRoot: resolveRepoPath(),
    pollIntervalMs: phase1FixtureTransmit ? 1 : undefined,
    pollMaxAttempts: phase1FixtureTransmit ? 5 : undefined,
  };
}

/**
 * Bellhop pilot pipeline.
 * Phase 0: DECIDE → POLICY → WORK ORDER → STOP
 * Phase 1: … → TRANSMIT → WAIT → STORE RAW CURSOR RESULT → VERIFYING → STOP
 */
export async function runBellhopPilot(config: Phase0Config = resolvePhase0Config()) {
  const runId = newId("run");
  const runDir = resolveRepoPath("artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  // Phase 1 fixture must not mutate the checked-in PROJECT-STATE.json.
  let statePath =
    config.statePath ??
    resolveRepoPath("projects", config.projectId, "PROJECT-STATE.json");
  let ledgerPath =
    config.ledgerPath ?? defaultLedgerPath(config.projectId);

  if (config.phase1FixtureTransmit && !config.statePath) {
    const workingState = path.join(runDir, "PROJECT-STATE.working.json");
    fs.copyFileSync(statePath, workingState);
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
    ]);
    process.exitCode = successVerdicts.has(result.terminalVerdict) ? 0 : 1;
  } catch (err) {
    console.error("RADIO_PHASE1_BLOCKED");
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
