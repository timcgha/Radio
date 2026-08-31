/**
 * Cyber Assurance Phase 3 pilot entrypoint.
 *
 * Fixture mode exercises runPhase3Loop with mocked Sol/Cursor.
 * Strict live mode requires explicit objective authority, git-remote-ref lease,
 * and a real initial Sol decision — no injected initialDecision substitute.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultLedgerPath } from "../state/ledger.js";
import { loadProjectState } from "../state/store.js";
import type { Phase0Config, RadioTerminalVerdict } from "../types.js";
import { newId, resolveRepoPath } from "../util/io.js";
import {
  loadObjectiveAuthority,
  resolvePhase3LiveIdentities,
} from "./objective-authority.js";
import { createPhase3FixtureCursorClient } from "./phase3-fixture-client.js";
import {
  assertStrictLiveNoInitialDecisionInjection,
  resolveStrictLiveObjectiveLeaseStore,
} from "./phase3-strict-live-guard.js";
import {
  runPhase3Loop,
  type Phase3LoopConfig,
  type Phase3LoopResult,
} from "./phase3.js";
import {
  resolvePhase3LiveCursorAuthorization,
} from "./pilot-bellhop.js";
import { ensureLedgerFile } from "./transmitter.js";

export const CYBER_ASSURANCE_PROJECT_ID = "cyber-assurance";
export const DEFAULT_CYBER_MODEL = "gpt-5.6-sol";

function readArgValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

export function resolveCyberAssurancePhase0Config(
  argv: string[] = process.argv,
): Phase0Config {
  const fixture = argv.includes("--fixture");
  const phase3Fixture =
    argv.includes("--phase3-fixture") ||
    argv.includes("--phase3:fixture") ||
    (!argv.includes("--phase3") && !fixture);
  const phase3Live =
    argv.includes("--phase3") && !phase3Fixture && !fixture;
  const fixtureMode = fixture || phase3Fixture;
  const model = process.env.RADIO_MODEL?.trim() || DEFAULT_CYBER_MODEL;
  const phase3LiveCursorAuth = resolvePhase3LiveCursorAuthorization({
    phase3Live,
    fixtureMode,
  });
  const objectiveAuthorityPath =
    readArgValue(argv, "--objective-authority") ??
    (phase3Fixture ? cyberAssurancePhase3ObjectivePath() : null);

  return {
    projectId: CYBER_ASSURANCE_PROJECT_ID,
    workstreamId: phase3Fixture
      ? "ca-phase3-fixture-01"
      : "ca-phase3-live-unbound",
    transactionId: phase3Fixture
      ? "ca-phase3-fixture-01-program-recovery"
      : "ca-phase3-live-unbound",
    model,
    cursorExecutionEnabled: phase3LiveCursorAuth.liveCursorDispatchAuthorized,
    cursorApiKeyPresent: Boolean(process.env.CURSOR_API_KEY?.trim()),
    liveCursorDispatchAuthorized:
      phase3LiveCursorAuth.liveCursorDispatchAuthorized,
    explicitTransmitMode: false,
    externalCursorAllowed: phase3LiveCursorAuth.externalCursorAllowed,
    phase1FixtureTransmit: false,
    phase2Fixture: false,
    phase2Live: false,
    phase3Fixture,
    phase3Live,
    objectiveAuthorityPath,
    recoverInvalidReport: false,
    recoverInvalidReportFixture: false,
    humanAuthorized: false,
    expectedRevision: null,
    validationArtifactPath: null,
    mode: fixtureMode ? "fixture" : "live",
    fixturePath: resolveRepoPath(
      "fixtures",
      "decisions",
      "cyber-assurance-phase3-initial-launch.json",
    ),
    projectRoot: resolveRepoPath(),
    pollIntervalMs: phase3Fixture ? 1 : undefined,
    pollMaxAttempts: phase3Fixture ? 5 : undefined,
  };
}

export function cyberAssurancePhase3PlanningSeedPath(): string {
  return resolveRepoPath(
    "fixtures",
    "state",
    "cyber-assurance-phase3-planning-seed.json",
  );
}

export function cyberAssurancePhase3ObjectivePath(): string {
  return resolveRepoPath(
    "fixtures",
    "phase3",
    "cyber-assurance-objective-authority.json",
  );
}

export interface StrictCyberPhase3LoopOverrides {
  objectiveLeaseStore?: Phase3LoopConfig["objectiveLeaseStore"];
  cursorClient?: Phase3LoopConfig["cursorClient"];
  solCall?: Phase3LoopConfig["solCall"];
  solPhase2Call?: Phase3LoopConfig["solPhase2Call"];
  initialDecision?: Phase3LoopConfig["initialDecision"];
  skipLiveExecution?: boolean;
  env?: NodeJS.ProcessEnv;
  statePath?: string;
  ledgerPath?: string;
  runDir?: string;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
}

/**
 * Strict Cyber Assurance Phase 3 loop — enforces git-remote-ref lease and
 * rejects live initialDecision injection before delegating to runPhase3Loop.
 */
export async function runStrictCyberAssurancePhase3Loop(
  config: Phase0Config,
  overrides: StrictCyberPhase3LoopOverrides = {},
): Promise<Phase3LoopResult> {
  if (!config.objectiveAuthorityPath) {
    throw new Error(
      "OBJECTIVE_AUTHORITY_REQUIRED: --objective-authority <path> is required",
    );
  }

  assertStrictLiveNoInitialDecisionInjection({
    mode: "live",
    initialDecision: overrides.initialDecision,
  });

  const authority = loadObjectiveAuthority(config.objectiveAuthorityPath);
  const identities = resolvePhase3LiveIdentities({
    authority,
    state: loadProjectState({
      projectId: config.projectId,
      statePath:
        overrides.statePath ??
        config.statePath ??
        resolveRepoPath("projects", config.projectId, "PROJECT-STATE.json"),
    }).state,
  });

  const runId = newId("run");
  const runDir =
    overrides.runDir ?? resolveRepoPath("artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  const statePath =
    overrides.statePath ??
    config.statePath ??
    resolveRepoPath("projects", config.projectId, "PROJECT-STATE.json");
  const ledgerPath =
    overrides.ledgerPath ??
    config.ledgerPath ??
    defaultLedgerPath(config.projectId);
  ensureLedgerFile(ledgerPath);

  const authorityWorkingPath = path.join(runDir, "objective-authority.json");
  fs.copyFileSync(config.objectiveAuthorityPath, authorityWorkingPath);

  const leaseStore = resolveStrictLiveObjectiveLeaseStore({
    env: overrides.env,
    store: overrides.objectiveLeaseStore,
  });

  return runPhase3Loop({
    projectId: identities.projectId,
    workstreamId: identities.workstreamId,
    transactionId: identities.transactionId,
    model: config.model,
    mode: "live",
    objectiveAuthorityPath: authorityWorkingPath,
    statePath,
    ledgerPath,
    runDir,
    objectiveLeaseStore: leaseStore,
    externalCursorAllowed: config.externalCursorAllowed,
    pollIntervalMs: overrides.pollIntervalMs ?? config.pollIntervalMs,
    pollMaxAttempts: overrides.pollMaxAttempts ?? config.pollMaxAttempts,
    skipLiveExecution: overrides.skipLiveExecution,
    env: overrides.env,
    cursorClient: overrides.cursorClient,
    solCall: overrides.solCall,
    solPhase2Call: overrides.solPhase2Call,
  });
}

export async function runCyberAssurancePhase3Fixture(): Promise<Phase3LoopResult> {
  const runId = newId("run");
  const runDir = resolveRepoPath("artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  const workingState = path.join(runDir, "PROJECT-STATE.working.json");
  fs.copyFileSync(cyberAssurancePhase3PlanningSeedPath(), workingState);
  const ledgerPath = path.join(runDir, "RUN-LEDGER.jsonl");
  ensureLedgerFile(ledgerPath);

  const authorityPath = path.join(runDir, "objective-authority.json");
  fs.copyFileSync(cyberAssurancePhase3ObjectivePath(), authorityPath);

  const passRaw = fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
    "utf8",
  );

  const client = createPhase3FixtureCursorClient([{ rawResult: passRaw }]);

  return runPhase3Loop({
    projectId: CYBER_ASSURANCE_PROJECT_ID,
    workstreamId: "ca-phase3-fixture-01",
    transactionId: "ca-phase3-fixture-01-program-recovery",
    model: DEFAULT_CYBER_MODEL,
    mode: "fixture",
    objectiveAuthorityPath: authorityPath,
    statePath: workingState,
    ledgerPath,
    initialDecisionFixturePath: resolveRepoPath(
      "fixtures",
      "decisions",
      "cyber-assurance-phase3-initial-launch.json",
    ),
    continuationDecisionFixturePaths: [
      resolveRepoPath(
        "fixtures",
        "decisions",
        "cyber-assurance-phase3-human-gate.json",
      ),
    ],
    cursorRawResultSequence: [passRaw],
    cursorClient: client,
    pollIntervalMs: 1,
    pollMaxAttempts: 5,
    runDir,
  });
}

async function runCyberAssurancePhase3Live(
  config: Phase0Config,
): Promise<Phase3LoopResult> {
  return runStrictCyberAssurancePhase3Loop(config);
}

function printPhase3Summary(
  result: Phase3LoopResult,
  mode: "live" | "fixture",
): void {
  console.log("");
  console.log("RADIO v0.1 — CYBER ASSURANCE PHASE 3");
  console.log("");
  console.log(`Mode: ${mode}`);
  console.log(`Iterations: ${result.iterations}`);
  console.log(`Cursor executions: ${result.cursorExecutionCount}`);
  console.log(`Sol decisions: ${result.solDecisionCount}`);
  console.log(`Runtime state: ${result.runtimeState}`);
  console.log(`Stop reason: ${result.stopReason}`);
  console.log(`Live OpenAI calls: 0`);
  console.log(`Live Cursor calls: 0`);
  console.log("");
  console.log(result.terminalVerdict);
  console.log("");
}

export async function runCyberAssurancePilot(
  config: Phase0Config = resolveCyberAssurancePhase0Config(),
) {
  if (config.phase3Live) {
    const result = await runCyberAssurancePhase3Live(config);
    printPhase3Summary(result, "live");
    return {
      terminalVerdict: result.terminalVerdict,
      phase3: result,
    };
  }

  const result = await runCyberAssurancePhase3Fixture();
  printPhase3Summary(result, "fixture");
  return {
    terminalVerdict: result.terminalVerdict,
    phase3: result,
  };
}

async function main(): Promise<void> {
  try {
    const config = resolveCyberAssurancePhase0Config();
    const outcome = await runCyberAssurancePilot(config);
    const successVerdicts = new Set<RadioTerminalVerdict>([
      "RADIO_PHASE3_AUTONOMOUS_LOOP_READY",
      "RADIO_PHASE3_READY_FOR_HUMAN",
      "RADIO_PHASE3_OBJECTIVE_COMPLETE",
      "RADIO_PHASE3_WAITING_FOR_AGENT",
      "RADIO_PHASE3_OBJECTIVE_ALREADY_LEASED",
      "RADIO_PHASE3_BUDGET_EXHAUSTED",
      "RADIO_PHASE3_ITERATION_LIMIT_REACHED",
      "RADIO_PHASE3_POLICY_REJECTED",
      "RADIO_PHASE3_IMPLEMENTED_LIVE_NOT_RUN",
    ]);
    process.exitCode = successVerdicts.has(outcome.terminalVerdict) ? 0 : 1;
  } catch (err) {
    console.error("RADIO_STRICT_CYBER_PHASE3_BLOCKED");
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
