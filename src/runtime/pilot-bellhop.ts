import path from "node:path";
import { pathToFileURL } from "node:url";
import { persistPhase0Artifacts } from "../artifacts/writer.js";
import { renderCursorPrompt } from "../cursor/prompt-renderer.js";
import { buildCursorWorkOrder } from "../cursor/work-order-builder.js";
import { buildSolContext } from "../orchestrator/context-builder.js";
import { callSol } from "../orchestrator/sol-adapter.js";
import { evaluatePolicy } from "../policy/engine.js";
import { loadBellhopBrain } from "../state/store.js";
import type {
  DecisionEnvelope,
  Phase0Config,
  Phase0TerminalVerdict,
  RunSummary,
} from "../types.js";
import { newId, nowIso, resolveRepoPath } from "../util/io.js";

export const DEFAULT_MODEL = "gpt-5.6-sol";

export function resolvePhase0Config(argv: string[] = process.argv): Phase0Config {
  const fixture = argv.includes("--fixture");
  const model = process.env.RADIO_MODEL?.trim() || DEFAULT_MODEL;
  const cursorExecutionEnabled =
    (process.env.CURSOR_EXECUTION_ENABLED ?? "false").toLowerCase() === "true";

  return {
    projectId: "bellhop",
    workstreamId: "radio-pilot-01",
    transactionId: "bellhop-radio-pilot-01-stage2-verification",
    model,
    cursorExecutionEnabled,
    mode: fixture ? "fixture" : "live",
    fixturePath: resolveRepoPath(
      "fixtures",
      "decisions",
      "bellhop-legal-launch-cursor.json",
    ),
    projectRoot: resolveRepoPath(),
  };
}

/**
 * Phase 0 Bellhop dry-run pipeline.
 * Stops before any Cursor execution. No Cursor adapter exists.
 */
export async function runBellhopPilot(config: Phase0Config = resolvePhase0Config()) {
  const runId = newId("run");
  const brain = loadBellhopBrain();
  const { state, fingerprint } = brain;

  const context = buildSolContext({
    brain,
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
      "CURSOR_EXECUTION_ENABLED does not alter policy legality; Phase 0 has no Cursor adapter.",
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
  let terminalVerdict: Phase0TerminalVerdict = "RADIO_PHASE0_BLOCKED";

  if (policy.result === "ALLOW") {
    if (
      sol.decision.decision === "LAUNCH_CURSOR" ||
      sol.decision.decision === "REUSE_CURSOR"
    ) {
      // Runtime: generate work order + prompt, then STOP (Cursor execution disabled / unimplemented).
      workOrder = buildCursorWorkOrder({
        state,
        decision: sol.decision,
        policy,
      });
      cursorPrompt = renderCursorPrompt(workOrder);
      terminalVerdict = "RADIO_PHASE0_DRY_RUN_COMPLETE";
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

  // Defense in depth: even if CURSOR_EXECUTION_ENABLED=true, Phase 0 has no Cursor adapter.
  if (config.cursorExecutionEnabled) {
    // Intentionally do nothing external. Log via summary only.
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
    cursorExecutionEnabled: false, // Phase 0 always reports disabled externally
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
}): void {
  const rel = (p: string | null) =>
    p ? path.relative(resolveRepoPath(), p) : "(not generated)";

  console.log("");
  console.log("RADIO v0.1 — BELLHOP DRY RUN");
  console.log("");
  console.log(`Project: ${input.projectName}`);
  console.log(`State revision: ${input.stateRevision}`);
  console.log(`State fingerprint: ${input.fingerprint}`);
  console.log("");
  console.log(`Sol decision: ${input.decision}`);
  console.log(`Agent action: ${input.agentAction ?? "(none)"}`);
  console.log(`Work type: ${input.workType ?? "(none)"}`);
  console.log("");
  console.log(`Policy: ${input.policy}`);
  console.log("");
  console.log("Cursor execution: DISABLED");
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
    const code =
      result.terminalVerdict === "RADIO_PHASE0_DRY_RUN_COMPLETE" ? 0 : 1;
    process.exitCode = code;
  } catch (err) {
    console.error("RADIO_PHASE0_BLOCKED");
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
