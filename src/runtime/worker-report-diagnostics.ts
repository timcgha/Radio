/**
 * Optional best-effort structured worker-report diagnostics for Phase 2.
 * Never blocks Sol solely because the worker report format is imperfect.
 */

import {
  extractCompletionReport,
  type CompletionExtractResult,
} from "../cursor/completion-parser.js";
import {
  validateCompletionReport,
  type CompletionBindingContext,
  type CompletionValidationResult,
} from "../cursor/completion-validator.js";

export type StructuredWorkerReportStatus =
  | "VALID"
  | "UNAVAILABLE_OR_INVALID"
  | "SCHEMA_INVALID"
  | "PROSE"
  | "JSON_PARSE_FAILED";

export interface StructuredWorkerReportDiagnostics {
  status: StructuredWorkerReportStatus;
  extract: CompletionExtractResult;
  validation: CompletionValidationResult | null;
  /** Parsed report when extract produced an object (may still be schema-invalid). */
  parsedReport: Record<string, unknown> | null;
  /** True only when extract+schema+identity+evidence all passed. */
  reportValid: boolean;
  diagnosticCodes: string[];
  summary: string;
}

/**
 * Best-effort structured report diagnostics. Always returns; never throws for
 * format problems. Radio still sends the exact raw result to Sol as untrusted
 * evidence regardless of this status.
 */
export function diagnoseStructuredWorkerReport(
  rawResultText: string,
  binding: CompletionBindingContext,
): StructuredWorkerReportDiagnostics {
  const extract = extractCompletionReport(rawResultText);
  const diagnosticCodes: string[] = [extract.code];

  if (!extract.ok || !extract.report) {
    let status = mapExtractFailureToStatus(extract.code);
    // Prose inside a correct text fence typically surfaces as JSON_PARSE_FAILED.
    if (
      extract.code === "JSON_PARSE_FAILED" &&
      typeof extract.fenceBody === "string" &&
      !looksLikeJsonObject(extract.fenceBody)
    ) {
      status = "PROSE";
      diagnosticCodes.push("PROSE_INSIDE_FENCE");
    }
    return {
      status,
      extract,
      validation: null,
      parsedReport: null,
      reportValid: false,
      diagnosticCodes,
      summary: extract.summary,
    };
  }

  const validation = validateCompletionReport(extract.report, binding);
  diagnosticCodes.push(validation.code);

  if (validation.ok) {
    return {
      status: "VALID",
      extract,
      validation,
      parsedReport: extract.report,
      reportValid: true,
      diagnosticCodes,
      summary: validation.summary,
    };
  }

  const status: StructuredWorkerReportStatus =
    validation.code === "SCHEMA_INVALID"
      ? "SCHEMA_INVALID"
      : "UNAVAILABLE_OR_INVALID";

  return {
    status,
    extract,
    validation,
    parsedReport: extract.report,
    reportValid: false,
    diagnosticCodes,
    summary: validation.summary,
  };
}

function mapExtractFailureToStatus(
  code: CompletionExtractResult["code"],
): StructuredWorkerReportStatus {
  switch (code) {
    case "JSON_PARSE_FAILED":
      return "JSON_PARSE_FAILED";
    case "JSON_NOT_OBJECT":
      return "JSON_PARSE_FAILED";
    case "EMPTY_RAW":
      return "UNAVAILABLE_OR_INVALID";
    case "PROSE_OUTSIDE_FENCE":
    case "ZERO_TEXT_FENCES":
      return "PROSE";
    case "MULTIPLE_TEXT_FENCES":
    case "MALFORMED_FENCE":
    case "NESTED_FENCE":
      return "UNAVAILABLE_OR_INVALID";
    default:
      return "UNAVAILABLE_OR_INVALID";
  }
}

function looksLikeJsonObject(body: string): boolean {
  const t = body.trim();
  return t.startsWith("{") || t.startsWith("[");
}
