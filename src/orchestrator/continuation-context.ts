/**
 * Phase 2 bounded Sol continuation context.
 * Includes only what Sol needs to choose the next legal orchestration action
 * after a validated completion report. Explicitly excludes Cyber Assurance.
 */

import { legalOutgoingTransitions } from "../policy/transitions.js";
import type {
  CursorWorkOrder,
  LoadedProjectBrain,
  ProjectState,
  RuntimeState,
  SolContext,
} from "../types.js";
import type { CompletionValidationResult } from "../cursor/completion-validator.js";
import { contextContainsCyberAssuranceLeak } from "./context-builder.js";

export interface ContinuationContextInput {
  brain: LoadedProjectBrain;
  state: ProjectState;
  fingerprint: string;
  workOrder: CursorWorkOrder;
  validation: CompletionValidationResult;
  report: Record<string, unknown>;
  /** Durable attribution from Phase 1 transmission. */
  cursorAgentId: string | null;
  cursorRunId: string | null;
  projectId: string;
  workstreamId: string;
  transactionId: string;
}

export interface ContinuationContextArtifact {
  schemaVersion: "phase2-1.0";
  projectId: string;
  workstreamId: string;
  transactionId: string;
  workOrderId: string;
  runtimeState: RuntimeState;
  stateRevision: number;
  stateFingerprint: string;
  legalOutgoingTransitions: RuntimeState[];
  workOutcome: string;
  workOutcomeDetail: string | null;
  sourceIntegrity: string;
  reportValid: true;
  expectedSource: {
    repository: string;
    workingBranch: string | null;
    expectedSha: string | null;
  };
  observedSource: {
    repository: string | null;
    workingBranch: string | null;
    observedSha: string | null;
    sourcePinsMatched: boolean | null;
  };
  cursorAgentId: string | null;
  cursorRunId: string | null;
  remediationBudget: number;
  remediationsUsed: number;
  specialistBudget: number;
  humanApprovalRequiredFor: string[];
  deferredItemIds: string[];
  blockers: unknown[];
  reportSummary: string;
  reportTerminalVerdict: string;
  reportResultClass: string;
  phase2Boundary: "NO_ACTION_WILL_BE_EXECUTED";
}

/**
 * Build bounded continuation context for GPT-5.6 Sol (Phase 2).
 * Radio has already validated the completion report; Sol decides next action only.
 */
export function buildContinuationContext(
  input: ContinuationContextInput,
): { context: SolContext; artifact: ContinuationContextArtifact } {
  const {
    state,
    fingerprint,
    workOrder,
    validation,
    report,
    cursorAgentId,
    cursorRunId,
    projectId,
    workstreamId,
    transactionId,
  } = input;

  const runtimeState = state.radioRuntime.state;
  const legalTo = legalOutgoingTransitions(runtimeState);
  const repoState = (report.repositoryState ?? {}) as Record<string, unknown>;

  const artifact: ContinuationContextArtifact = {
    schemaVersion: "phase2-1.0",
    projectId,
    workstreamId,
    transactionId,
    workOrderId: workOrder.workOrderId,
    runtimeState,
    stateRevision: state.stateRevision,
    stateFingerprint: fingerprint,
    legalOutgoingTransitions: legalTo,
    workOutcome: validation.workOutcome,
    workOutcomeDetail: validation.workOutcomeDetail,
    sourceIntegrity: validation.sourceIntegrity,
    reportValid: true,
    expectedSource: {
      repository: workOrder.source.repository,
      workingBranch: workOrder.source.workingBranch,
      expectedSha: workOrder.source.expectedBaseTipSha,
    },
    observedSource: {
      repository: typeof repoState.repository === "string" ? repoState.repository : null,
      workingBranch:
        typeof repoState.workingBranch === "string" ? repoState.workingBranch : null,
      observedSha:
        typeof repoState.branchTipSha === "string"
          ? repoState.branchTipSha
          : typeof repoState.startingWorkingSha === "string"
            ? repoState.startingWorkingSha
            : null,
      sourcePinsMatched:
        typeof repoState.sourcePinsMatched === "boolean"
          ? repoState.sourcePinsMatched
          : null,
    },
    cursorAgentId,
    cursorRunId,
    remediationBudget: state.currentTransaction?.remediationBudget ?? 0,
    remediationsUsed: state.currentTransaction?.remediationsUsed ?? 0,
    specialistBudget: state.budgets.maxSpecialistCallsPerTransaction,
    humanApprovalRequiredFor: state.authority.humanApprovalRequiredFor,
    deferredItemIds: state.deferredItems.map((d) => d.id),
    blockers: Array.isArray(report.blockers) ? report.blockers : [],
    reportSummary: String(report.summary ?? ""),
    reportTerminalVerdict: String(report.terminalVerdict ?? ""),
    reportResultClass: String(report.resultClass ?? ""),
    phase2Boundary: "NO_ACTION_WILL_BE_EXECUTED",
  };

  const system = [
    "You are GPT-5.6 Sol, the orchestration layer for Radio v0.1.",
    "",
    "CORE DOCTRINE:",
    "- Human Product Owner retains consequential judgment.",
    "- GPT-5.6 Sol proposes the next orchestration action.",
    "- Radio deterministic policy enforces legality.",
    "- Cursor reports are evidence, not truth — but THIS report has already been",
    "  schema-validated, identity-bound, and evidence-reconciled by Radio.",
    "- A VALID completion report can describe a BLOCKED worker outcome.",
    "- Report validity and work outcome are separate concepts.",
    "- The LLM reasons; Radio enforces.",
    "",
    "PHASE 2 CONSTRAINTS (MANDATORY):",
    "- Radio has already validated the Cursor completion report.",
    "- You decide the smallest legal NEXT orchestration action given the validated facts.",
    "- You do NOT decide whether the report is valid.",
    "- Phase 2 will NOT execute your decision (no Cursor create, no remediation, no merge).",
    "- Do NOT automatically retry Cursor.",
    "- Do NOT treat prior Cursor-launch authorization as fresh authority for a new worker.",
    "- Do NOT start Stage 3, merge, deploy, or retune flight.",
    "- Do NOT reference any other Radio-managed product.",
    "- Stay within Bellhop Pilot 01 scope only.",
    "",
    "Return a single structured Orchestrator Decision object conforming to the provided schema.",
  ].join("\n");

  const user = [
    `projectId (required): ${projectId}`,
    `workstreamId (required): ${workstreamId}`,
    `transactionId (required): ${transactionId}`,
    `stateRevision: ${state.stateRevision}`,
    `stateFingerprint: ${fingerprint}`,
    `decisionId: generate a unique decisionId string`,
    `generatedAt: use a valid current ISO-8601 timestamp`,
    "",
    "=== AUTHORITATIVE RADIO RUNTIME STATE ===",
    `radioRuntime.state: ${runtimeState}`,
    `currentTransaction.status: ${state.currentTransaction?.status ?? "null"}`,
    `activeAgent: ${state.activeAgent ? JSON.stringify({
      agentId: state.activeAgent.agentId,
      status: state.activeAgent.status,
      workOrderId: state.activeAgent.workOrderId,
    }) : "null"}`,
    `Legal outgoing runtime transitions from ${runtimeState}: ${legalTo.join(" | ") || "(none)"}`,
    `stateTransition.from MUST equal ${runtimeState}.`,
    `stateTransition.to MUST be one of: ${[runtimeState, ...legalTo].filter((v, i, a) => a.indexOf(v) === i).join(" | ")}`,
    "Same-state no-op is only for non-mutating decisions such as NO_ACTION or WAIT.",
    "",
    "=== WORK ORDER AUTHORIZATION BOUNDARIES ===",
    JSON.stringify(
      {
        workOrderId: workOrder.workOrderId,
        agentAction: workOrder.agentAction,
        workType: workOrder.workType,
        objective: workOrder.objective,
        repository: workOrder.source.repository,
        expectedSha: workOrder.source.expectedBaseTipSha,
        workingBranch: workOrder.source.workingBranch,
        outOfScope: workOrder.scope.outOfScope,
        maxRemediationPasses: workOrder.budgets.maxRemediationPasses,
        maxSpecialists: workOrder.budgets.maxSpecialistReviewCycles,
        prCreationAllowed: workOrder.pr.creationAllowed,
        mergeAllowed: workOrder.pr.mergeAllowed,
        allowedTerminalVerdicts: workOrder.completion.allowedTerminalVerdicts,
      },
      null,
      2,
    ),
    "",
    "=== VALIDATED COMPLETION REPORT FACTS ===",
    JSON.stringify(artifact, null, 2),
    "",
    "=== COMPACT REPORT SUMMARY ===",
    JSON.stringify(
      {
        resultClass: report.resultClass,
        terminalVerdict: report.terminalVerdict,
        summary: report.summary,
        executionStatus: (report.execution as { status?: string } | undefined)?.status,
        sourcePinsMatched: repoState.sourcePinsMatched,
        expectedSha: workOrder.source.expectedBaseTipSha,
        observedSha: artifact.observedSource.observedSha,
        productFilesChanged: (report.changeSummary as { productFilesChanged?: string[] })
          ?.productFilesChanged,
        testResults: report.testResults,
        blockers: report.blockers,
        recommendedNextAction: report.recommendedNextAction,
        remediation: report.remediation,
        gitPr: report.gitPr,
      },
      null,
      2,
    ),
    "",
    "=== REMAINING BUDGETS / AUTHORITY ===",
    `remediationBudget: ${artifact.remediationBudget} (used ${artifact.remediationsUsed})`,
    `specialistBudget: ${artifact.specialistBudget}`,
    `maxCursorAgentsPerTransaction: ${state.budgets.maxCursorAgentsPerTransaction}`,
    `humanApprovalRequiredFor: ${artifact.humanApprovalRequiredFor.join(", ")}`,
    `deferredItems: ${artifact.deferredItemIds.join(", ")}`,
    "",
    "=== TASK ===",
    "Given this VALID completion report and its substantive work outcome, choose the smallest legal next orchestration action.",
    "Phase 2 boundary: NO ACTION WILL BE EXECUTED — store decision + policy result only.",
    "Populate required payloads for the chosen decision; set unused payloads to null.",
  ].join("\n");

  const context: SolContext = {
    system,
    user,
    vocabulary: [
      "NO_ACTION",
      "WAIT",
      "LAUNCH_CURSOR",
      "REUSE_CURSOR",
      "REQUEST_HUMAN_APPROVAL",
      "ACCEPT_WORKSTREAM",
      "BLOCK_WORKSTREAM",
    ],
    fingerprint,
    stateRevision: state.stateRevision,
  };

  if (contextContainsCyberAssuranceLeak(context)) {
    throw new Error(
      "Continuation context leaked Cyber Assurance content into Bellhop Sol context",
    );
  }

  return { context, artifact };
}
