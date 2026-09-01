#!/usr/bin/env node
/**
 * Radio v2 CLI entrypoint.
 *
 * Usage:
 *   npm run radio:v2 -- --objective <path> [--run-dir <dir>]
 *   npm run radio:v2 -- --resume <run-dir>
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "../util/io.js";
import { loadV2ObjectiveFromFile } from "./objective.js";
import { runV2Loop, resumeV2Loop } from "./orchestrator.js";
import { defaultRunDir } from "./artifacts.js";
import {
  createV2ProductionDeps,
  V2PreflightError,
  type V2ProductionOverrides,
} from "./deps.js";
import type { V2RunResult, V2TerminalOutcome } from "./types.js";

export interface V2CliArgs {
  objectivePath: string | null;
  runDir: string | null;
  resumeDir: string | null;
}

export function parseV2CliArgs(argv: string[]): V2CliArgs {
  let objectivePath: string | null = null;
  let runDir: string | null = null;
  let resumeDir: string | null = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--objective" && argv[i + 1]) {
      objectivePath = argv[++i]!;
    } else if (arg === "--run-dir" && argv[i + 1]) {
      runDir = argv[++i]!;
    } else if (arg === "--resume" && argv[i + 1]) {
      resumeDir = argv[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return { objectivePath, runDir, resumeDir };
}

function printHelp(): void {
  console.log(`Radio v2 — thin zero-relay orchestrator

Usage:
  npm run radio:v2 -- --objective <path> [--run-dir <dir>]
  npm run radio:v2 -- --resume <run-dir>

Options:
  --objective <path>   V2 objective JSON file (required for new runs)
  --run-dir <dir>      Artifact output directory (default: artifacts/v2-runs/<id>-<ts>)
  --resume <dir>       Resume an existing v2 run directory

Required environment for live execution:
  OPENAI_API_KEY
  CURSOR_API_KEY
  CURSOR_EXECUTION_ENABLED=true

Optional:
  RADIO_MODEL                 Sol model (default: gpt-5.6-sol)
  RADIO_CURSOR_ENV_BELLHOP    Cursor Cloud environment name for Bellhop workers
`);
}

function terminalExitCode(outcome: V2TerminalOutcome | null): number {
  if (outcome === "DONE") return 0;
  return 1;
}

export function formatCliResult(result: V2RunResult): string {
  return [
    `runDir=${result.runDir}`,
    `terminalOutcome=${result.state.terminalOutcome ?? "null"}`,
    `finalStage=${result.state.stage}`,
    `iterations=${result.summary.iterations}`,
    `workerRunsUsed=${result.summary.workerRunsUsed}`,
    `implementationWorkersCreated=${result.summary.implementationWorkersCreated}`,
    `humanMessagesAfterLaunch=${result.summary.humanMessagesAfterLaunch}`,
  ].join("\n");
}

export async function runV2Cli(
  argv: string[],
  overrides?: V2ProductionOverrides,
): Promise<{ exitCode: number; result: V2RunResult }> {
  const args = parseV2CliArgs(argv);

  if (args.resumeDir) {
    const statePath = path.join(args.resumeDir, "run-state.json");
    if (!fs.existsSync(statePath)) {
      throw new Error(`No run state at ${statePath}`);
    }

    const { deps } = await createV2ProductionDeps({
      runDir: args.resumeDir,
      overrides,
    });
    const result = await resumeV2Loop({ ...deps, runDir: args.resumeDir });
    return {
      exitCode: terminalExitCode(result.state.terminalOutcome),
      result,
    };
  }

  if (!args.objectivePath) {
    printHelp();
    throw new Error("--objective is required for new runs");
  }

  const objective = loadV2ObjectiveFromFile(readJsonFile, args.objectivePath);
  const runDir = args.runDir ?? defaultRunDir(objective.objectiveId);

  const { deps } = await createV2ProductionDeps({
    objective,
    runDir,
    overrides,
  });
  const result = await runV2Loop(deps);
  return {
    exitCode: terminalExitCode(result.state.terminalOutcome),
    result,
  };
}

async function main(): Promise<void> {
  try {
    const { exitCode, result } = await runV2Cli(process.argv);
    console.log(formatCliResult(result));
    process.exit(exitCode);
  } catch (err) {
    if (err instanceof V2PreflightError) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("/cli.ts") ||
    process.argv[1].endsWith("/cli.js") ||
    process.argv[1].endsWith("\\cli.ts") ||
    process.argv[1].endsWith("\\cli.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
