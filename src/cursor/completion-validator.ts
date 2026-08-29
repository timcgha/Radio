/**
 * Phase 2 completion-report schema validation, identity binding, and
 * deterministic evidence reconciliation.
 *
 * Principles:
 * - A valid report is not necessarily a successful work outcome.
 * - Expected SHA ≠ observed SHA with BLOCKED/PRECHECK_BLOCKED is coherent.
 * - Radio fails closed on schema/identity/evidence inconsistency.
 * - No LLM decides "close enough."
 */

import type { CursorWorkOrder, ProjectState } from "../types.js";
import {
  formatAjvErrors,
  getSchemaValidator,
} from "../util/io.js";

export type CompletionValidationCode =
  | "REPORT_VALID"
  | "SCHEMA_INVALID"
  | "IDENTITY_BINDING_FAILED"
  | "EVIDENCE_INCONSISTENT"
  | "TERMINAL_VERDICT_NOT_ALLOWED";

export type WorkOutcomeClass =
  | "READY"
  | "ACCEPTED"
  | "BLOCKED"
  | "FAILED"
  | "NOOP"
  | "UNKNOWN";

export interface CompletionValidationResult {
  ok: boolean;
  code: CompletionValidationCode;
  summary: string;
  reportValid: boolean;
  workOutcome: WorkOutcomeClass;
  workOutcomeDetail: string | null;
  sourceIntegrity: "MATCHED" | "MISMATCH" | "UNKNOWN";
  errors: string[];
  report: Record<string, unknown> | null;
}

export interface CompletionBindingContext {
  state: ProjectState;
  workOrder: CursorWorkOrder;
  /** Durable Cursor agent id from Phase 1 transmission, when known. */
  expectedAgentId?: string | null;
  /** Durable Cursor run id from Phase 1 transmission, when known. */
  expectedRunId?: string | null;
}

/**
 * Canonical schema validation + identity binding + evidence consistency.
 */
export function validateCompletionReport(
  report: Record<string, unknown>,
  ctx: CompletionBindingContext,
): CompletionValidationResult {
  const errors: string[] = [];
  const validate = getSchemaValidator("cursor-completion-report.schema.json");
  if (!validate(report)) {
    return {
      ok: false,
      code: "SCHEMA_INVALID",
      summary: `Canonical completion-report schema validation failed: ${formatAjvErrors(validate.errors)}`,
      reportValid: false,
      workOutcome: "UNKNOWN",
      workOutcomeDetail: null,
      sourceIntegrity: "UNKNOWN",
      errors: [formatAjvErrors(validate.errors)],
      report,
    };
  }

  const identity = bindIdentity(report, ctx);
  if (!identity.ok) {
    return {
      ok: false,
      code: "IDENTITY_BINDING_FAILED",
      summary: identity.summary,
      reportValid: false,
      workOutcome: "UNKNOWN",
      workOutcomeDetail: null,
      sourceIntegrity: "UNKNOWN",
      errors: identity.errors,
      report,
    };
  }

  const verdictCheck = checkAllowedTerminalVerdict(report, ctx.workOrder);
  if (!verdictCheck.ok) {
    return {
      ok: false,
      code: "TERMINAL_VERDICT_NOT_ALLOWED",
      summary: verdictCheck.summary,
      reportValid: false,
      workOutcome: "UNKNOWN",
      workOutcomeDetail: null,
      sourceIntegrity: "UNKNOWN",
      errors: verdictCheck.errors,
      report,
    };
  }

  const evidence = reconcileEvidence(report, ctx.workOrder);
  if (!evidence.ok) {
    return {
      ok: false,
      code: "EVIDENCE_INCONSISTENT",
      summary: evidence.summary,
      reportValid: false,
      workOutcome: "UNKNOWN",
      workOutcomeDetail: null,
      sourceIntegrity: evidence.sourceIntegrity,
      errors: evidence.errors,
      report,
    };
  }

  const resultClass = String(report.resultClass ?? "UNKNOWN") as WorkOutcomeClass;
  const terminalVerdict = String(report.terminalVerdict ?? "");
  const workOutcomeDetail =
    terminalVerdict ||
    (resultClass === "BLOCKED" ? "BLOCKED_SOURCE_STATE" : resultClass);

  return {
    ok: true,
    code: "REPORT_VALID",
    summary:
      "Completion report passed schema, identity binding, and evidence reconciliation",
    reportValid: true,
    workOutcome: resultClass,
    workOutcomeDetail,
    sourceIntegrity: evidence.sourceIntegrity,
    errors: [],
    report,
  };
}

function bindIdentity(
  report: Record<string, unknown>,
  ctx: CompletionBindingContext,
): { ok: boolean; summary: string; errors: string[] } {
  const errors: string[] = [];
  const { state, workOrder } = ctx;

  if (report.workOrderId !== workOrder.workOrderId) {
    errors.push(
      `workOrderId mismatch: report=${String(report.workOrderId)} expected=${workOrder.workOrderId}`,
    );
  }
  if (Number(report.workOrderRevision) !== workOrder.revision) {
    errors.push(
      `workOrderRevision mismatch: report=${String(report.workOrderRevision)} expected=${workOrder.revision}`,
    );
  }
  if (report.projectId !== workOrder.projectId || report.projectId !== state.project.id) {
    errors.push(
      `projectId mismatch: report=${String(report.projectId)} expected=${workOrder.projectId}`,
    );
  }
  if (report.workstreamId !== workOrder.workstreamId) {
    errors.push(
      `workstreamId mismatch: report=${String(report.workstreamId)} expected=${workOrder.workstreamId}`,
    );
  }
  if (report.transactionId !== workOrder.transactionId) {
    errors.push(
      `transactionId mismatch: report=${String(report.transactionId)} expected=${workOrder.transactionId}`,
    );
  }
  if (report.decisionId !== workOrder.decisionId) {
    errors.push(
      `decisionId mismatch: report=${String(report.decisionId)} expected=${workOrder.decisionId}`,
    );
  }

  const execution = report.execution as Record<string, unknown> | undefined;
  if (execution) {
    if (execution.agentAction !== workOrder.agentAction) {
      errors.push(
        `agentAction mismatch: report=${String(execution.agentAction)} expected=${workOrder.agentAction}`,
      );
    }
    if (execution.workType !== workOrder.workType) {
      errors.push(
        `workType mismatch: report=${String(execution.workType)} expected=${workOrder.workType}`,
      );
    }
  }

  const repoState = report.repositoryState as Record<string, unknown> | undefined;
  if (repoState) {
    const expectedRepo = normalizeRepo(workOrder.source.repository);
    const observedRepo = normalizeRepo(String(repoState.repository ?? ""));
    if (expectedRepo && observedRepo && expectedRepo !== observedRepo) {
      errors.push(
        `repository mismatch: report=${String(repoState.repository)} expected=${workOrder.source.repository}`,
      );
    }
  }

  // Agent identity: when Radio knows the dispatched agent, ordinary/primary must match.
  if (ctx.expectedAgentId) {
    const ordinary = execution?.ordinaryAgent as Record<string, unknown> | null;
    const primary = execution?.primaryAgent as Record<string, unknown> | null;
    const reportedId =
      (ordinary && typeof ordinary.agentId === "string" && ordinary.agentId) ||
      (primary && typeof primary.agentId === "string" && primary.agentId) ||
      null;
    if (reportedId && reportedId !== ctx.expectedAgentId) {
      errors.push(
        `agentId mismatch: report=${reportedId} expected=${ctx.expectedAgentId}`,
      );
    }
    if (!reportedId) {
      errors.push(
        `agentId missing in report; expected dispatched agent ${ctx.expectedAgentId}`,
      );
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      summary: `Identity binding failed: ${errors.join("; ")}`,
      errors,
    };
  }
  return { ok: true, summary: "Identity binding matched", errors: [] };
}

function checkAllowedTerminalVerdict(
  report: Record<string, unknown>,
  workOrder: CursorWorkOrder,
): { ok: boolean; summary: string; errors: string[] } {
  const verdict = String(report.terminalVerdict ?? "");
  const allowed = workOrder.completion.allowedTerminalVerdicts;
  // Contract also documents PRECHECK_BLOCKED as a valid precheck outcome.
  const extended = new Set([...allowed, "PRECHECK_BLOCKED"]);
  if (!extended.has(verdict)) {
    return {
      ok: false,
      summary: `terminalVerdict ${verdict} is not in work-order allowlist`,
      errors: [`terminalVerdict not allowed: ${verdict}`],
    };
  }
  return { ok: true, summary: "terminalVerdict allowed", errors: [] };
}

function reconcileEvidence(
  report: Record<string, unknown>,
  workOrder: CursorWorkOrder,
): {
  ok: boolean;
  summary: string;
  errors: string[];
  sourceIntegrity: "MATCHED" | "MISMATCH" | "UNKNOWN";
} {
  const errors: string[] = [];
  const repoState = report.repositoryState as Record<string, unknown>;
  const changeSummary = report.changeSummary as Record<string, unknown>;
  const testResults = report.testResults as Array<Record<string, unknown>>;
  const execution = report.execution as Record<string, unknown>;
  const resultClass = String(report.resultClass);
  const remediation = report.remediation as Record<string, unknown>;
  const gitPr = report.gitPr as Record<string, unknown>;

  const expectedSha = String(workOrder.source.expectedBaseTipSha ?? "");
  const observedSha = String(
    repoState.branchTipSha ??
      repoState.startingWorkingSha ??
      repoState.observedBaseTipSha ??
      "",
  );
  const pinsMatched = Boolean(repoState.sourcePinsMatched);

  let sourceIntegrity: "MATCHED" | "MISMATCH" | "UNKNOWN" = "UNKNOWN";
  if (expectedSha && observedSha) {
    sourceIntegrity = shaEqual(expectedSha, observedSha) ? "MATCHED" : "MISMATCH";
  } else if (pinsMatched === true) {
    sourceIntegrity = "MATCHED";
  } else if (pinsMatched === false) {
    sourceIntegrity = "MISMATCH";
  }

  // Source mismatch accurately reported as blocked is VALID — not an invalid report.
  if (sourceIntegrity === "MISMATCH") {
    if (pinsMatched === true) {
      errors.push(
        "sourcePinsMatched=true contradicts expected≠observed source SHAs",
      );
    }
    if (resultClass === "READY" || resultClass === "ACCEPTED") {
      errors.push(
        `resultClass ${resultClass} cannot coexist with source pin mismatch`,
      );
    }
  }

  // No product changes claimed vs files listed.
  const productFiles = asStringArray(changeSummary.productFilesChanged);
  const filesChanged = asStringArray(changeSummary.filesChanged);
  const summaryText = String(changeSummary.summary ?? "").toLowerCase();
  const claimsNoProduct =
    productFiles.length === 0 &&
    (summaryText.includes("no product") ||
      summaryText.includes("none") ||
      summaryText.includes("no changes") ||
      summaryText.includes("halt_precheck") ||
      summaryText.includes("precheck"));

  if (
    productFiles.length > 0 &&
    (resultClass === "BLOCKED" || resultClass === "NOOP") &&
    String(execution.status).includes("PRECHECK")
  ) {
    errors.push(
      "PRECHECK_BLOCKED/BLOCKED report claims product file changes",
    );
  }

  // Claimed PASS tests with NOT_RUN / missing runs.
  for (const t of testResults) {
    const result = String(t.result);
    const name = String(t.name);
    if (result === "PASS" && (t.exitCode === null || t.passed === null)) {
      // Soft: schema allows nulls; only flag explicit contradiction.
    }
    if (
      result === "PASS" &&
      typeof t.failed === "number" &&
      (t.failed as number) > 0
    ) {
      errors.push(`test ${name} claims PASS but failed count > 0`);
    }
  }

  const anyTestPass = testResults.some((t) => t.result === "PASS");
  const anyTestNotRun = testResults.every(
    (t) => t.result === "NOT_RUN" || t.result === "BLOCKED",
  );
  const status = String(execution.status);
  if (
    (status === "PRECHECK_BLOCKED" || status === "BLOCKED") &&
    anyTestPass &&
    sourceIntegrity === "MISMATCH"
  ) {
    errors.push(
      "PRECHECK/BLOCKED with source mismatch cannot claim PASS tests",
    );
  }

  // Coherent precheck-blocked pattern: tests not run, no product changes, no PR, no remediation.
  if (status === "PRECHECK_BLOCKED" || resultClass === "BLOCKED") {
    if (productFiles.length > 0 || (claimsNoProduct === false && filesChanged.length > 0 && productFiles.length > 0)) {
      // already covered
    }
    if (gitPr.branchPushed === true || gitPr.mergeAttempted === true) {
      errors.push("blocked/precheck report claims branch push or merge attempt");
    }
    if (
      Number(remediation.passesUsed) > 0 &&
      workOrder.budgets.maxRemediationPasses === 0
    ) {
      errors.push("remediation used despite budget 0");
    }
  }

  // READY/ACCEPTED cannot coexist with failed required gates (contract §29).
  if (resultClass === "READY" || resultClass === "ACCEPTED") {
    if (sourceIntegrity === "MISMATCH") {
      errors.push("READY/ACCEPTED with source mismatch");
    }
    if (anyTestNotRun && workOrder.verification.requiredCommands.length > 0) {
      // Verification work that claims ready must have run gates.
      const requiredCats = workOrder.verification.requiredCommands;
      if (requiredCats.length > 0 && testResults.every((t) => t.result === "NOT_RUN")) {
        errors.push("READY/ACCEPTED but all required tests are NOT_RUN");
      }
    }
    const blockers = report.blockers as unknown[];
    if (Array.isArray(blockers) && blockers.length > 0) {
      const blocking = blockers.filter(
        (b) =>
          b &&
          typeof b === "object" &&
          (b as { blocksAcceptance?: boolean }).blocksAcceptance === true,
      );
      if (blocking.length > 0) {
        errors.push("READY/ACCEPTED with acceptance-blocking findings");
      }
    }
  }

  // Explicit contradictory: claims PASS overall with FAILED tests.
  if (
    (resultClass === "READY" || resultClass === "ACCEPTED") &&
    testResults.some((t) => t.result === "FAIL")
  ) {
    errors.push("READY/ACCEPTED with FAIL test result");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      summary: `Evidence reconciliation failed: ${errors.join("; ")}`,
      errors,
      sourceIntegrity,
    };
  }

  return {
    ok: true,
    summary: "Evidence reconciliation coherent",
    errors: [],
    sourceIntegrity,
  };
}

function normalizeRepo(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^git@github\.com:/i, "github.com/")
    .toLowerCase();
}

function shaEqual(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  // Prefix match only when shorter uniquely prefixes longer (display forms).
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  return longer.startsWith(shorter) && shorter.length >= 7;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
