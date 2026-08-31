/**
 * Bounded same-worker completion-report repair.
 *
 * Schema-invalid worker output is a routine execution error — not a human gate.
 * Radio sends at most MAX_REPORT_REPAIR_ATTEMPTS follow-ups to the SAME
 * implementation agent with REPORT-ONLY correction instructions.
 */

import fs from "node:fs";
import path from "node:path";
import { writeJson, writeText } from "../artifacts/writer.js";
import {
  buildCompletionReportTemplate,
  buildMachineReadableCompletionContract,
  renderReportRepairPrompt,
} from "../cursor/completion-contract.js";
import { extractCompletionReport } from "../cursor/completion-parser.js";
import type { CursorApiClient } from "../cursor/api-client.js";
import { pollRunUntilTerminal } from "../cursor/adapter.js";
import type { CursorWorkOrder, ProjectState } from "../types.js";
import { diagnoseStructuredWorkerReport } from "./worker-report-diagnostics.js";
import { classifyWorkerReportDiagnostics } from "./execution-outcome.js";

export const MAX_REPORT_REPAIR_ATTEMPTS = 2;

export type ReportRepairTerminalCode =
  | "REPAIR_NOT_NEEDED"
  | "REPAIR_SUCCEEDED"
  | "WORKER_REPORT_SCHEMA_REPAIR_EXHAUSTED"
  | "MISSING_EVIDENCE_NOT_FABRICATED";

export interface ReportRepairAttemptRecord {
  attempt: number;
  promptPath: string;
  responsePath: string;
  validationPath: string;
  ok: boolean;
  code: string;
  summary: string;
}

export interface ReportRepairResult {
  ok: boolean;
  code: ReportRepairTerminalCode;
  summary: string;
  rawResultText: string;
  reportValid: boolean;
  attempts: number;
  sameAgentUsed: boolean;
  newImplementationAgentCreated: boolean;
  sourceMutationDuringReportRepair: boolean;
  remediationBudgetConsumed: boolean;
  initialInvalidReportPath: string | null;
  finalInvalidReportPath: string | null;
  attemptRecords: ReportRepairAttemptRecord[];
  artifactPaths: Record<string, string>;
}

export interface ReportRepairInput {
  agentId: string;
  runId: string;
  workOrder: CursorWorkOrder;
  state: ProjectState;
  rawResultText: string;
  structuredWorkerReportRequired: boolean;
  client: CursorApiClient;
  repairRunDir: string;
  pollIntervalMs: number;
  pollMaxAttempts: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Attempt bounded same-agent report repair when structured report is required
 * but schema-invalid. Returns the (possibly repaired) raw result text.
 */
export async function attemptBoundedReportRepair(
  input: ReportRepairInput,
): Promise<ReportRepairResult> {
  fs.mkdirSync(input.repairRunDir, { recursive: true });
  const artifactPaths: Record<string, string> = {};
  const attemptRecords: ReportRepairAttemptRecord[] = [];

  const binding = {
    state: input.state,
    workOrder: input.workOrder,
    expectedAgentId: input.agentId,
    expectedRunId: input.runId,
  };

  let diagnostics = diagnoseStructuredWorkerReport(input.rawResultText, binding);
  const classification = classifyWorkerReportDiagnostics({
    structuredWorkerReportRequired: input.structuredWorkerReportRequired,
    reportValid: diagnostics.reportValid,
    diagnosticStatus: diagnostics.status,
  });

  if (!input.structuredWorkerReportRequired || classification.machineRecoverable === false) {
    return {
      ok: diagnostics.reportValid,
      code: diagnostics.reportValid ? "REPAIR_NOT_NEEDED" : "WORKER_REPORT_SCHEMA_REPAIR_EXHAUSTED",
      summary: diagnostics.reportValid
        ? "Structured report already valid"
        : classification.summary,
      rawResultText: input.rawResultText,
      reportValid: diagnostics.reportValid,
      attempts: 0,
      sameAgentUsed: false,
      newImplementationAgentCreated: false,
      sourceMutationDuringReportRepair: false,
      remediationBudgetConsumed: false,
      initialInvalidReportPath: null,
      finalInvalidReportPath: null,
      attemptRecords,
      artifactPaths,
    };
  }

  const initialPath = path.join(input.repairRunDir, "initial-invalid-report.txt");
  writeText(initialPath, input.rawResultText);
  artifactPaths.initialInvalidReport = initialPath;

  const initialValidationPath = path.join(
    input.repairRunDir,
    "initial-validation.json",
  );
  writeJson(initialValidationPath, {
    ok: false,
    diagnostics,
    classification,
  });
  artifactPaths.initialValidation = initialValidationPath;

  let currentRaw = input.rawResultText;
  let attempts = 0;
  let lastInvalidPath: string | null = initialPath;

  while (attempts < MAX_REPORT_REPAIR_ATTEMPTS) {
    attempts += 1;
    const attemptDir = path.join(input.repairRunDir, `attempt-${attempts}`);
    fs.mkdirSync(attemptDir, { recursive: true });

    diagnostics = diagnoseStructuredWorkerReport(currentRaw, binding);
    const validationErrors =
      diagnostics.validation?.errors ??
      (diagnostics.extract.ok
        ? []
        : [diagnostics.extract.summary]);

    const contract = buildMachineReadableCompletionContract(input.workOrder, {
      plannedAgentId: input.agentId,
    });
    const template = buildCompletionReportTemplate(input.workOrder, {
      plannedAgentId: input.agentId,
    });

    const repairPrompt = renderReportRepairPrompt({
      workOrder: input.workOrder,
      validationErrors,
      contract,
      template,
      attempt: attempts,
      maxAttempts: MAX_REPORT_REPAIR_ATTEMPTS,
      initialRawResult: currentRaw,
    });

    const promptPath = path.join(attemptDir, "report-repair-prompt.txt");
    writeText(promptPath, repairPrompt);
    artifactPaths[`reportRepairPrompt${attempts}`] = promptPath;

    const followUp = await sendSameAgentReportRepairFollowUp({
      client: input.client,
      agentId: input.agentId,
      prompt: repairPrompt,
      pollIntervalMs: input.pollIntervalMs,
      pollMaxAttempts: input.pollMaxAttempts,
      sleep: input.sleep,
    });

    const responsePath = path.join(attemptDir, "report-repair-response.txt");
    writeText(responsePath, followUp.rawResultText);
    artifactPaths[`reportRepairResponse${attempts}`] = responsePath;

    currentRaw = followUp.rawResultText;
    diagnostics = diagnoseStructuredWorkerReport(currentRaw, binding);

    const attemptValidationPath = path.join(attemptDir, "validation.json");
    writeJson(attemptValidationPath, diagnostics);
    artifactPaths[`reportRepairValidation${attempts}`] = attemptValidationPath;

    const missingEvidence = detectMissingEvidenceAdmission(currentRaw, diagnostics);
    if (missingEvidence) {
      const finalPath = path.join(input.repairRunDir, "final-missing-evidence-report.txt");
      writeText(finalPath, currentRaw);
      attemptRecords.push({
        attempt: attempts,
        promptPath,
        responsePath,
        validationPath: attemptValidationPath,
        ok: false,
        code: "MISSING_EVIDENCE_NOT_FABRICATED",
        summary: missingEvidence,
      });
      return {
        ok: false,
        code: "MISSING_EVIDENCE_NOT_FABRICATED",
        summary: missingEvidence,
        rawResultText: currentRaw,
        reportValid: false,
        attempts,
        sameAgentUsed: true,
        newImplementationAgentCreated: false,
        sourceMutationDuringReportRepair: false,
        remediationBudgetConsumed: false,
        initialInvalidReportPath: initialPath,
        finalInvalidReportPath: finalPath,
        attemptRecords,
        artifactPaths,
      };
    }

    if (diagnostics.reportValid) {
      const validPath = path.join(input.repairRunDir, "repaired-valid-report.txt");
      writeText(validPath, currentRaw);
      artifactPaths.repairedValidReport = validPath;
      attemptRecords.push({
        attempt: attempts,
        promptPath,
        responsePath,
        validationPath: attemptValidationPath,
        ok: true,
        code: "REPAIR_SUCCEEDED",
        summary: "Schema-valid report produced by same-worker repair",
      });
      return {
        ok: true,
        code: "REPAIR_SUCCEEDED",
        summary: `Report repair succeeded on attempt ${attempts}`,
        rawResultText: currentRaw,
        reportValid: true,
        attempts,
        sameAgentUsed: true,
        newImplementationAgentCreated: false,
        sourceMutationDuringReportRepair: false,
        remediationBudgetConsumed: false,
        initialInvalidReportPath: initialPath,
        finalInvalidReportPath: null,
        attemptRecords,
        artifactPaths,
      };
    }

    lastInvalidPath = responsePath;
    attemptRecords.push({
      attempt: attempts,
      promptPath,
      responsePath,
      validationPath: attemptValidationPath,
      ok: false,
      code: diagnostics.validation?.code ?? diagnostics.extract.code,
      summary: diagnostics.summary,
    });
  }

  const finalPath = path.join(input.repairRunDir, "final-invalid-report.txt");
  writeText(finalPath, currentRaw);
  writeJson(path.join(input.repairRunDir, "repair-exhaustion.json"), {
    code: "WORKER_REPORT_SCHEMA_REPAIR_EXHAUSTED",
    attempts,
    attemptRecords,
    lastDiagnostics: diagnostics,
  });
  artifactPaths.finalInvalidReport = finalPath;
  artifactPaths.repairExhaustion = path.join(
    input.repairRunDir,
    "repair-exhaustion.json",
  );

  return {
    ok: false,
    code: "WORKER_REPORT_SCHEMA_REPAIR_EXHAUSTED",
    summary: `Same-worker report repair exhausted after ${attempts} attempts`,
    rawResultText: currentRaw,
    reportValid: false,
    attempts,
    sameAgentUsed: true,
    newImplementationAgentCreated: false,
    sourceMutationDuringReportRepair: false,
    remediationBudgetConsumed: false,
    initialInvalidReportPath: initialPath,
    finalInvalidReportPath: finalPath,
    attemptRecords,
    artifactPaths,
  };
}

async function sendSameAgentReportRepairFollowUp(input: {
  client: CursorApiClient;
  agentId: string;
  prompt: string;
  pollIntervalMs: number;
  pollMaxAttempts: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ rawResultText: string; runId: string }> {
  if (!input.client.createAgentRun) {
    throw new Error(
      "Cursor client does not support createAgentRun — cannot perform same-agent report repair",
    );
  }

  const created = await input.client.createAgentRun(input.agentId, {
    prompt: { text: input.prompt },
    mode: "agent",
  });

  const terminal = await pollRunUntilTerminal({
    client: input.client,
    agentId: input.agentId,
    runId: created.run.id,
    intervalMs: input.pollIntervalMs,
    maxAttempts: input.pollMaxAttempts,
    sleep: input.sleep,
  });

  const rawResultText =
    typeof terminal.result === "string" ? terminal.result : "";

  return { rawResultText, runId: created.run.id };
}

/**
 * Detect when repair response truthfully admits required evidence is absent.
 * Radio must not treat fabricated PASS values as success.
 */
function detectMissingEvidenceAdmission(
  rawText: string,
  diagnostics: ReturnType<typeof diagnoseStructuredWorkerReport>,
): string | null {
  const lower = rawText.toLowerCase();
  if (
    lower.includes("evidence unavailable") ||
    lower.includes("required evidence is absent") ||
    lower.includes("cannot populate required") ||
    lower.includes("missing required evidence")
  ) {
    return "Worker admitted required evidence is absent; Radio will not fabricate success";
  }

  if (diagnostics.validation?.code === "EVIDENCE_INCONSISTENT") {
    return diagnostics.validation.summary;
  }

  return null;
}

export function shouldAttemptReportRepair(input: {
  structuredWorkerReportRequired: boolean;
  reportValid: boolean;
  diagnosticStatus: string | null;
}): boolean {
  const classification = classifyWorkerReportDiagnostics({
    structuredWorkerReportRequired: input.structuredWorkerReportRequired,
    reportValid: input.reportValid,
    diagnosticStatus: input.diagnosticStatus,
  });
  return classification.machineRecoverable;
}

/**
 * Extract parsed report from raw text for acceptance context persistence.
 */
export function extractParsedReportOrNull(
  rawText: string,
): Record<string, unknown> | null {
  const extracted = extractCompletionReport(rawText);
  return extracted.ok && extracted.report ? extracted.report : null;
}
