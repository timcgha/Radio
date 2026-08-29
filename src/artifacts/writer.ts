import fs from "node:fs";
import path from "node:path";
import type {
  CursorWorkOrder,
  DecisionEnvelope,
  OrchestratorDecision,
  PolicyEvaluation,
  RunSummary,
} from "../types.js";
import { resolveRepoPath } from "../util/io.js";

export interface RunArtifacts {
  runId: string;
  runDir: string;
  paths: {
    decision: string;
    decisionEnvelope: string;
    policyEvaluation: string;
    workOrder: string | null;
    cursorPrompt: string | null;
    runSummary: string;
    solRaw?: string;
  };
}

export function createRunDirectory(runId: string): string {
  const runDir = resolveRepoPath("artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

export function persistPhase0Artifacts(input: {
  runId: string;
  decision: OrchestratorDecision;
  envelope: DecisionEnvelope;
  policy: PolicyEvaluation;
  workOrder: CursorWorkOrder | null;
  cursorPrompt: string | null;
  summary: RunSummary;
  solRawText?: string;
}): RunArtifacts {
  const runDir = createRunDirectory(input.runId);
  const paths = {
    decision: path.join(runDir, "decision.json"),
    decisionEnvelope: path.join(runDir, "decision-envelope.json"),
    policyEvaluation: path.join(runDir, "policy-evaluation.json"),
    workOrder: input.workOrder ? path.join(runDir, "work-order.json") : null,
    cursorPrompt: input.cursorPrompt
      ? path.join(runDir, "cursor-prompt.txt")
      : null,
    runSummary: path.join(runDir, "run-summary.json"),
    solRaw: input.solRawText ? path.join(runDir, "sol-raw.json.txt") : undefined,
  };

  writeJson(paths.decision, input.decision);
  writeJson(paths.decisionEnvelope, input.envelope);
  writeJson(paths.policyEvaluation, input.policy);
  if (paths.workOrder && input.workOrder) {
    writeJson(paths.workOrder, input.workOrder);
  }
  if (paths.cursorPrompt && input.cursorPrompt) {
    writeText(paths.cursorPrompt, input.cursorPrompt);
  }
  if (paths.solRaw && input.solRawText) {
    writeText(paths.solRaw, input.solRawText);
  }
  writeJson(paths.runSummary, {
    ...input.summary,
    artifactPaths: {
      decision: paths.decision,
      decisionEnvelope: paths.decisionEnvelope,
      policyEvaluation: paths.policyEvaluation,
      workOrder: paths.workOrder,
      cursorPrompt: paths.cursorPrompt,
      runSummary: paths.runSummary,
    },
  });

  return { runId: input.runId, runDir, paths };
}
