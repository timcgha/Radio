/**
 * Cyber Assurance Phase 3 fixture pilot.
 *
 * Exercises the same runPhase3Loop path as Bellhop with mocked Sol/Cursor.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  phase3DefaultObjectivePath,
  runPhase3Loop,
  type Phase3LoopResult,
} from "./phase3.js";
import { createPhase3FixtureCursorClient } from "./phase3-fixture-client.js";
import { ensureLedgerFile } from "./transmitter.js";
import { newId, resolveRepoPath } from "../util/io.js";

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
    projectId: "cyber-assurance",
    workstreamId: "ca-phase3-fixture-01",
    transactionId: "ca-phase3-fixture-01-program-recovery",
    model: "gpt-5.6-sol",
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

function printSummary(result: Phase3LoopResult): void {
  console.log("");
  console.log("RADIO v0.1 — CYBER ASSURANCE PHASE 3 FIXTURE");
  console.log("");
  console.log(`Runtime state: ${result.runtimeState}`);
  console.log(`Cursor executions: ${result.cursorExecutionCount}`);
  console.log(`Sol decisions: ${result.solDecisionCount}`);
  console.log(`Stop reason: ${result.stopReason}`);
  console.log(`Live OpenAI calls: 0`);
  console.log(`Live Cursor calls: 0`);
  console.log("");
  console.log(result.terminalVerdict);
  console.log("");
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  runCyberAssurancePhase3Fixture()
    .then((result) => {
      printSummary(result);
      if (
        result.runtimeState !== "READY_FOR_HUMAN" ||
        result.terminalVerdict !== "RADIO_PHASE3_READY_FOR_HUMAN"
      ) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
