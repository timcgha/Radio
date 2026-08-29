import type { CursorWorkOrder } from "../types.js";
import {
  formatAjvErrors,
  getSchemaValidator,
  sha256Hex,
  canonicalize,
} from "../util/io.js";

export interface CursorCompletionReport {
  schemaVersion: "1.0";
  reportId: string;
  workOrderId: string;
  workOrderRevision: number;
  projectId: string;
  workstreamId: string;
  transactionId: string;
  decisionId: string;
  generatedAt: string;
  terminalVerdict: string;
  resultClass: string;
  summary: string;
  repositoryState: {
    repository: string;
    observedCanonicalMainSha: string | null;
    observedBaseTipSha: string | null;
    branchTipSha: string | null;
    finalExecutableSha: string | null;
    evidenceTipSha: string | null;
    sourcePinsMatched: boolean;
    [key: string]: unknown;
  };
  changeSummary: {
    productFilesChanged: string[];
    scopeExpanded: boolean;
    protectedSemanticsChanged: boolean;
    [key: string]: unknown;
  };
  gitPr: {
    mergeAttempted: boolean;
    prState: string;
    [key: string]: unknown;
  };
  recommendedNextAction: {
    kind: string;
    summary: string;
    requiresHumanApproval: boolean;
  };
  [key: string]: unknown;
}

export type CompletionValidationStatus =
  | "VALID"
  | "SCHEMA_INVALID"
  | "IDENTITY_MISMATCH"
  | "RECONCILE_FAILED"
  | "TERMINAL_VERDICT_ILLEGAL";

export interface CompletionValidationResult {
  status: CompletionValidationStatus;
  report: CursorCompletionReport | null;
  errors: string[];
  reportHash: string | null;
}

export function validateCompletionReportSchema(
  raw: unknown,
): CompletionValidationResult {
  const validate = getSchemaValidator("cursor-completion-report.schema.json");
  const ok = validate(raw);
  if (!ok) {
    return {
      status: "SCHEMA_INVALID",
      report: null,
      errors: [formatAjvErrors(validate.errors)],
      reportHash: null,
    };
  }
  const report = raw as CursorCompletionReport;
  return {
    status: "VALID",
    report,
    errors: [],
    reportHash: sha256Hex(canonicalize(report)),
  };
}

/**
 * Validate schema + bind to work order + basic Bellhop pilot reconciliation.
 */
export function validateCompletionAgainstWorkOrder(input: {
  raw: unknown;
  workOrder: CursorWorkOrder;
}): CompletionValidationResult {
  const schema = validateCompletionReportSchema(input.raw);
  if (schema.status !== "VALID" || !schema.report) {
    return schema;
  }

  const report = schema.report;
  const errors: string[] = [];

  if (report.workOrderId !== input.workOrder.workOrderId) {
    errors.push(
      `workOrderId mismatch: report=${report.workOrderId} workOrder=${input.workOrder.workOrderId}`,
    );
  }
  if (report.workOrderRevision !== input.workOrder.revision) {
    errors.push(
      `workOrderRevision mismatch: report=${report.workOrderRevision} workOrder=${input.workOrder.revision}`,
    );
  }
  if (report.projectId !== input.workOrder.projectId) {
    errors.push(
      `projectId mismatch: report=${report.projectId} workOrder=${input.workOrder.projectId}`,
    );
  }
  if (report.transactionId !== input.workOrder.transactionId) {
    errors.push(
      `transactionId mismatch: report=${report.transactionId} workOrder=${input.workOrder.transactionId}`,
    );
  }
  if (report.decisionId !== input.workOrder.decisionId) {
    errors.push(
      `decisionId mismatch: report=${report.decisionId} workOrder=${input.workOrder.decisionId}`,
    );
  }

  if (errors.length > 0) {
    return {
      status: "IDENTITY_MISMATCH",
      report,
      errors,
      reportHash: schema.reportHash,
    };
  }

  const allowed = new Set(input.workOrder.completion.allowedTerminalVerdicts);
  if (!allowed.has(report.terminalVerdict)) {
    return {
      status: "TERMINAL_VERDICT_ILLEGAL",
      report,
      errors: [
        `terminalVerdict ${report.terminalVerdict} not in allowed set [${[
          ...allowed,
        ].join(", ")}]`,
      ],
      reportHash: schema.reportHash,
    };
  }

  const reconcileErrors = reconcilePilotFacts(report, input.workOrder);
  if (reconcileErrors.length > 0) {
    return {
      status: "RECONCILE_FAILED",
      report,
      errors: reconcileErrors,
      reportHash: schema.reportHash,
    };
  }

  return {
    status: "VALID",
    report,
    errors: [],
    reportHash: schema.reportHash,
  };
}

function reconcilePilotFacts(
  report: CursorCompletionReport,
  workOrder: CursorWorkOrder,
): string[] {
  const errors: string[] = [];

  if (report.repositoryState.repository !== workOrder.source.repository) {
    errors.push(
      `repository mismatch: report=${report.repositoryState.repository} expected=${workOrder.source.repository}`,
    );
  }

  // Successful verified path must not claim product edits or merge.
  if (
    report.terminalVerdict ===
      "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST"
  ) {
    if (!report.repositoryState.sourcePinsMatched) {
      errors.push("verified verdict requires sourcePinsMatched=true");
    }
    if (
      Array.isArray(report.changeSummary.productFilesChanged) &&
      report.changeSummary.productFilesChanged.length > 0
    ) {
      errors.push("verified verdict requires empty productFilesChanged");
    }
    if (report.changeSummary.scopeExpanded) {
      errors.push("verified verdict requires scopeExpanded=false");
    }
    if (report.changeSummary.protectedSemanticsChanged) {
      errors.push("verified verdict requires protectedSemanticsChanged=false");
    }
    if (report.gitPr.mergeAttempted) {
      errors.push("verified verdict requires mergeAttempted=false");
    }
  }

  return errors;
}
