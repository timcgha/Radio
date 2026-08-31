#!/usr/bin/env node
/**
 * Radio v2 CLI entrypoint.
 *
 * Usage:
 *   npm run radio:v2 -- --objective <path> [--run-dir <dir>] [--resume <dir>]
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "../util/io.js";
import { loadV2ObjectiveFromFile } from "./objective.js";
import { runV2Loop, resumeV2Loop } from "./orchestrator.js";
import { defaultRunDir } from "./artifacts.js";
import { resolveRemoteBranchTipViaGitLsRemote } from "../cursor/source-ref.js";

function parseArgs(argv: string[]): {
  objectivePath: string | null;
  runDir: string | null;
  resumeDir: string | null;
} {
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

Note: Live Sol/Cursor calls require configured API credentials.
      Use fixture-based tests for offline validation.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.resumeDir) {
    const statePath = path.join(args.resumeDir, "run-state.json");
    if (!fs.existsSync(statePath)) {
      console.error(`No run state at ${statePath}`);
      process.exit(1);
    }
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    console.error(
      "Resume requires injected Sol/Cursor clients — use programmatic API for live resume.",
    );
    console.error(`Saved stage: ${state.stage}, iteration: ${state.iteration}`);
    process.exit(1);
  }

  if (!args.objectivePath) {
    printHelp();
    process.exit(1);
  }

  const objective = loadV2ObjectiveFromFile(readJsonFile, args.objectivePath);
  const dir = args.runDir ?? defaultRunDir(objective.objectiveId);

  console.error(
    "Radio v2 CLI requires programmatic deps (Sol/Cursor fakes or live clients).",
  );
  console.error(`Objective loaded: ${objective.objectiveId}`);
  console.error(`Run directory: ${dir}`);
  console.error(
    "Import runV2Loop from src/v2/orchestrator.js for full execution.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
