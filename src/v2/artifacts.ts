/**
 * V2 run artifact persistence — one compact run directory.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  V2Objective,
  V2Plan,
  V2RunState,
  V2RunSummary,
  V2SolDecision,
  V2VerifiedFacts,
} from "./types.js";
import { nowIso } from "../util/io.js";

export interface V2ArtifactWriter {
  runDir: string;
  writeObjective(objective: V2Objective): void;
  writePlan(plan: V2Plan): void;
  writeWorkerRequest(iteration: number, text: string): string;
  writeWorkerResult(iteration: number, text: string): string;
  writeVerifiedFacts(iteration: number, facts: V2VerifiedFacts): string;
  writeDecision(iteration: number, decision: V2SolDecision): string;
  writeSummary(summary: V2RunSummary): void;
  writeRunState(state: V2RunState): void;
}

function iterationDir(runDir: string, iteration: number): string {
  const dir = path.join(runDir, "iterations", String(iteration).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createArtifactWriter(runDir: string): V2ArtifactWriter {
  fs.mkdirSync(runDir, { recursive: true });

  return {
    runDir,
    writeObjective(objective) {
      fs.writeFileSync(
        path.join(runDir, "objective.json"),
        JSON.stringify(objective, null, 2),
      );
    },
    writePlan(plan) {
      fs.writeFileSync(
        path.join(runDir, "plan.json"),
        JSON.stringify(plan, null, 2),
      );
    },
    writeWorkerRequest(iteration, text) {
      const filePath = path.join(runDir, "worker-request.txt");
      const iterPath = path.join(iterationDir(runDir, iteration), "worker-request.txt");
      fs.writeFileSync(filePath, text);
      fs.writeFileSync(iterPath, text);
      return filePath;
    },
    writeWorkerResult(iteration, text) {
      const filePath = path.join(runDir, "worker-result.txt");
      const iterPath = path.join(iterationDir(runDir, iteration), "worker-result.txt");
      fs.writeFileSync(filePath, text);
      fs.writeFileSync(iterPath, text);
      return filePath;
    },
    writeVerifiedFacts(iteration, facts) {
      const filePath = path.join(runDir, "verified-facts.json");
      const iterPath = path.join(iterationDir(runDir, iteration), "verified-facts.json");
      const json = JSON.stringify(facts, null, 2);
      fs.writeFileSync(filePath, json);
      fs.writeFileSync(iterPath, json);
      return filePath;
    },
    writeDecision(iteration, decision) {
      const filePath = path.join(runDir, "decision.json");
      const iterPath = path.join(iterationDir(runDir, iteration), "decision.json");
      const json = JSON.stringify(decision, null, 2);
      fs.writeFileSync(filePath, json);
      fs.writeFileSync(iterPath, json);
      return filePath;
    },
    writeSummary(summary) {
      fs.writeFileSync(
        path.join(runDir, "summary.json"),
        JSON.stringify(summary, null, 2),
      );
    },
    writeRunState(state) {
      fs.writeFileSync(
        path.join(runDir, "run-state.json"),
        JSON.stringify(state, null, 2),
      );
    },
  };
}

export function loadRunState(runDir: string): V2RunState | null {
  const statePath = path.join(runDir, "run-state.json");
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as V2RunState;
}

export function defaultRunDir(objectiveId: string, baseDir?: string): string {
  const root = baseDir ?? path.join(process.cwd(), "artifacts", "v2-runs");
  const stamp = nowIso().replace(/[:.]/g, "-");
  return path.join(root, `${objectiveId}-${stamp}`);
}
