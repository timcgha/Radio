/**
 * Deterministic post-Sol acceptance gate.
 *
 * Sol may recommend ACCEPT_WORKSTREAM; Radio independently verifies structural
 * completion requirements before applyAccept().
 */

import type { ResolveRemoteBranchTip } from "../cursor/source-ref.js";
import {
  verifyExecutableEvidenceAncestry,
  verifyRemoteBranchTipExact,
  verifyRemoteCommitExists,
  type VerifyCommitAncestry,
} from "../cursor/remote-publication-verify.js";
import { commitShasMatch, isFullGitCommitSha } from "../cursor/source-ref.js";
import type { StructuredWorkerReportDiagnostics } from "./worker-report-diagnostics.js";
import {
  hasActiveCompletionRequirements,
  resolveObjectiveCompletionRequirements,
} from "./completion-requirements.js";
import type { CompletionAcceptanceContextArtifact } from "./completion-acceptance-context.js";
import type { CursorWorkOrder, ObjectiveAuthority } from "../types.js";
import { readJsonFile } from "../util/io.js";
import fs from "node:fs";

export type CompletionAcceptanceFailureCode =
  | "ACCEPTANCE_OK"
  | "WORKER_REPORT_SCHEMA_INVALID"
  | "BRANCH_PUSH_REQUIRED_BUT_FALSE"
  | "REMOTE_BRANCH_MISSING"
  | "REMOTE_BRANCH_SHA_MISMATCH"
  | "FRESH_EXECUTABLE_SHA_MISSING"
  | "EVIDENCE_TIP_MISSING"
  | "REMOTE_EXECUTABLE_NOT_VERIFIED"
  | "STARTING_SHA_NOT_FRESH"
  | "REMOTE_COMMIT_NOT_FOUND"
  | "EXECUTABLE_NOT_ANCESTOR_OF_EVIDENCE";

export interface CompletionAcceptanceGateResult {
  ok: boolean;
  code: CompletionAcceptanceFailureCode;
  summary: string;
  failedConditions: CompletionAcceptanceFailureCode[];
}

export interface CompletionAcceptanceContext {
  authority: ObjectiveAuthority;
  workOrder: CursorWorkOrder;
  diagnostics: StructuredWorkerReportDiagnostics;
  resolveRemoteBranchTip?: ResolveRemoteBranchTip;
  verifyCommitAncestry?: VerifyCommitAncestry;
  verifyRemoteCommitExists?: (input: {
    repositoryUrl: string;
    commitSha: string;
  }) => Promise<boolean>;
}

function fail(
  code: CompletionAcceptanceFailureCode,
  summary: string,
  failedConditions: CompletionAcceptanceFailureCode[],
): CompletionAcceptanceGateResult {
  return { ok: false, code, summary, failedConditions };
}

function pass(): CompletionAcceptanceGateResult {
  return {
    ok: true,
    code: "ACCEPTANCE_OK",
    summary: "Structural completion requirements satisfied",
    failedConditions: [],
  };
}

function reportRepositoryState(
  diagnostics: StructuredWorkerReportDiagnostics,
): Record<string, unknown> | null {
  const report = diagnostics.parsedReport;
  if (!report || typeof report !== "object") return null;
  const rs = (report as { repositoryState?: unknown }).repositoryState;
  return rs && typeof rs === "object" ? (rs as Record<string, unknown>) : null;
}

function reportGitPr(
  diagnostics: StructuredWorkerReportDiagnostics,
): Record<string, unknown> | null {
  const report = diagnostics.parsedReport;
  if (!report || typeof report !== "object") return null;
  const gitPr = (report as { gitPr?: unknown }).gitPr;
  return gitPr && typeof gitPr === "object" ? (gitPr as Record<string, unknown>) : null;
}

function readSha(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Evaluate objective completion requirements after Sol recommends ACCEPT_WORKSTREAM.
 * Fail closed when any required deterministic condition is unsatisfied.
 */
export async function evaluateCompletionAcceptanceGate(
  input: CompletionAcceptanceContext,
): Promise<CompletionAcceptanceGateResult> {
  const requirements = resolveObjectiveCompletionRequirements(input.authority);
  if (
    !requirements.structuredWorkerReportRequired &&
    !requirements.commitRequired &&
    !requirements.remotePublicationRequired &&
    !requirements.freshExecutableShaRequired &&
    !requirements.evidenceTipRequired
  ) {
    return pass();
  }

  const failed: CompletionAcceptanceFailureCode[] = [];
  const remoteCommitExists =
    input.verifyRemoteCommitExists ?? verifyRemoteCommitExists;

  if (requirements.structuredWorkerReportRequired) {
    if (!input.diagnostics.reportValid || input.diagnostics.status !== "VALID") {
      failed.push("WORKER_REPORT_SCHEMA_INVALID");
    }
  }

  const repoState = reportRepositoryState(input.diagnostics);
  const gitPr = reportGitPr(input.diagnostics);
  const startingSha = input.authority.expectedStartingSha.trim();

  if (requirements.remotePublicationRequired) {
    if (!input.diagnostics.reportValid) {
      failed.push("WORKER_REPORT_SCHEMA_INVALID");
    } else {
      const branchPushed = gitPr?.branchPushed === true;
      if (!branchPushed) {
        failed.push("BRANCH_PUSH_REQUIRED_BUT_FALSE");
      } else {
        const remoteBranch =
          readSha(gitPr?.remoteBranch) ??
          readSha(repoState?.workingBranch) ??
          input.workOrder.source.workingBranch?.trim() ??
          null;
        const claimedTip =
          readSha(gitPr?.branchTipSha) ??
          readSha(repoState?.branchTipSha) ??
          readSha(repoState?.evidenceTipSha);

        if (!remoteBranch || !claimedTip) {
          failed.push("REMOTE_BRANCH_MISSING");
        } else if (!input.resolveRemoteBranchTip) {
          failed.push("REMOTE_BRANCH_MISSING");
        } else {
          const remoteCheck = await verifyRemoteBranchTipExact({
            repositoryUrl: input.workOrder.source.repository,
            branch: remoteBranch,
            expectedTipSha: claimedTip,
            resolveRemoteBranchTip: input.resolveRemoteBranchTip,
          });
          if (!remoteCheck.ok) {
            failed.push(remoteCheck.code as CompletionAcceptanceFailureCode);
          }
        }
      }
    }
  }

  if (requirements.freshExecutableShaRequired) {
    if (!input.diagnostics.reportValid) {
      if (!failed.includes("WORKER_REPORT_SCHEMA_INVALID")) {
        failed.push("WORKER_REPORT_SCHEMA_INVALID");
      }
    } else {
      const finalExecutableSha = readSha(repoState?.finalExecutableSha);
      if (!finalExecutableSha || !isFullGitCommitSha(finalExecutableSha)) {
        failed.push("FRESH_EXECUTABLE_SHA_MISSING");
      } else if (commitShasMatch(finalExecutableSha, startingSha)) {
        failed.push("STARTING_SHA_NOT_FRESH");
      } else {
        const exists = await remoteCommitExists({
          repositoryUrl: input.workOrder.source.repository,
          commitSha: finalExecutableSha,
        });
        if (!exists) {
          failed.push("REMOTE_EXECUTABLE_NOT_VERIFIED");
        }
      }
    }
  }

  if (requirements.evidenceTipRequired) {
    if (!input.diagnostics.reportValid) {
      if (!failed.includes("WORKER_REPORT_SCHEMA_INVALID")) {
        failed.push("WORKER_REPORT_SCHEMA_INVALID");
      }
    } else {
      const evidenceTipSha = readSha(repoState?.evidenceTipSha);
      if (!evidenceTipSha || !isFullGitCommitSha(evidenceTipSha)) {
        failed.push("EVIDENCE_TIP_MISSING");
      } else if (!input.resolveRemoteBranchTip) {
        failed.push("REMOTE_BRANCH_MISSING");
      } else {
        const remoteBranch =
          readSha(gitPr?.remoteBranch) ??
          readSha(repoState?.workingBranch) ??
          input.workOrder.source.workingBranch?.trim() ??
          null;
        if (!remoteBranch) {
          failed.push("REMOTE_BRANCH_MISSING");
        } else {
          const remoteCheck = await verifyRemoteBranchTipExact({
            repositoryUrl: input.workOrder.source.repository,
            branch: remoteBranch,
            expectedTipSha: evidenceTipSha,
            resolveRemoteBranchTip: input.resolveRemoteBranchTip,
          });
          if (!remoteCheck.ok) {
            failed.push(remoteCheck.code as CompletionAcceptanceFailureCode);
          }
        }

        const finalExecutableSha = readSha(repoState?.finalExecutableSha);
        if (
          finalExecutableSha &&
          isFullGitCommitSha(finalExecutableSha) &&
          !commitShasMatch(finalExecutableSha, evidenceTipSha)
        ) {
          const ancestry = await verifyExecutableEvidenceAncestry({
            repositoryUrl: input.workOrder.source.repository,
            finalExecutableSha,
            evidenceTipSha,
            verifyCommitAncestry: input.verifyCommitAncestry,
            verifyRemoteCommitExistsImpl: remoteCommitExists,
          });
          if (!ancestry.ok) {
            if (ancestry.code === "EXECUTABLE_NOT_ANCESTOR_OF_EVIDENCE") {
              failed.push("EXECUTABLE_NOT_ANCESTOR_OF_EVIDENCE");
            } else {
              failed.push("REMOTE_EXECUTABLE_NOT_VERIFIED");
            }
          }
        }
      }
    }
  }

  if (failed.length === 0) {
    return pass();
  }

  const uniqueFailed = [...new Set(failed)];
  return fail(
    uniqueFailed[0]!,
    `Completion requirements not satisfied: ${uniqueFailed.join(", ")}`,
    uniqueFailed,
  );
}

/**
 * Evaluate whether Radio may apply ACCEPT_WORKSTREAM for an objective.
 */
export async function evaluateAcceptWorkstreamGate(input: {
  authority: ObjectiveAuthority;
  completionContextPath: string | null;
  resolveRemoteBranchTip?: ResolveRemoteBranchTip;
  verifyCommitAncestry?: VerifyCommitAncestry;
  verifyRemoteCommitExists?: (input: {
    repositoryUrl: string;
    commitSha: string;
  }) => Promise<boolean>;
}): Promise<CompletionAcceptanceGateResult> {
  const requirements = resolveObjectiveCompletionRequirements(input.authority);
  if (!hasActiveCompletionRequirements(requirements)) {
    return pass();
  }

  const contextPath = input.completionContextPath;
  if (!contextPath || !fs.existsSync(contextPath)) {
    return fail(
      "WORKER_REPORT_SCHEMA_INVALID",
      "Completion acceptance context missing for objective with active completion requirements",
      ["WORKER_REPORT_SCHEMA_INVALID"],
    );
  }

  const ctx = readJsonFile<CompletionAcceptanceContextArtifact>(contextPath);
  return evaluateCompletionAcceptanceGate({
    authority: input.authority,
    workOrder: ctx.workOrder,
    diagnostics: ctx.diagnostics,
    resolveRemoteBranchTip: input.resolveRemoteBranchTip,
    verifyCommitAncestry: input.verifyCommitAncestry,
    verifyRemoteCommitExists: input.verifyRemoteCommitExists,
  });
}
