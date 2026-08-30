/**
 * Bounded Sol context for Phase 3 live initial orchestration decision.
 *
 * Derived from authoritative objective authority + current project state.
 * Does NOT hardcode Bellhop Stage 3 — objective content comes from authority.
 */

import { legalOutgoingTransitions } from "../policy/transitions.js";
import type { LoadedProjectBrain, ObjectiveAuthority, SolContext } from "../types.js";
import { contextContainsCyberAssuranceLeak } from "./context-builder.js";

const DECISION_VOCABULARY = [
  "NO_ACTION",
  "WAIT",
  "LAUNCH_CURSOR",
  "REUSE_CURSOR",
  "REQUEST_HUMAN_APPROVAL",
  "ACCEPT_WORKSTREAM",
  "BLOCK_WORKSTREAM",
] as const;

export interface BuildPhase3InitialContextInput {
  brain: LoadedProjectBrain;
  authority: ObjectiveAuthority;
  projectId: string;
  workstreamId: string;
  transactionId: string;
}

/**
 * Build bounded Phase 3 live initial decision context from objective authority.
 */
export function buildPhase3InitialContext(
  input: BuildPhase3InitialContextInput,
): SolContext {
  const { brain, authority, projectId, workstreamId, transactionId } = input;
  const { state, fingerprint } = brain;
  const currentRuntimeState = state.radioRuntime.state;
  const legalToTargets = legalOutgoingTransitions(currentRuntimeState);

  const authorizedSource = {
    repository: state.project.repository,
    canonicalMainBranch: state.canonicalState.mainBranch,
    canonicalMainSha: state.canonicalState.mainSha,
    activeTransactionBranch: state.currentTransaction?.branch ?? null,
    activeTransactionBranchTipSha: state.currentTransaction?.branchTipSha ?? null,
    sourceBaseBranch: state.currentTransaction?.sourceBaseBranch ?? null,
    sourceBaseTipSha: state.currentTransaction?.sourceBaseTipSha ?? null,
  };

  const system = [
    "You are GPT-5.6 Sol, the orchestration layer for Radio v0.1.",
    "",
    "CORE DOCTRINE:",
    "- Human Product Owner retains consequential judgment via explicit objective authority.",
    "- GPT-5.6 Sol proposes the next orchestration action for the authorized objective.",
    "- Radio deterministic policy enforces legality, budgets, and scope.",
    "- Cursor reports are evidence, not truth.",
    "- THE LLM REASONS; RADIO ENFORCES.",
    "",
    "PHASE 3 LIVE INITIAL DECISION (MANDATORY):",
    "- This is the FIRST orchestration decision for a human-authorized objective.",
    "- Objective authority is AUTHORITATIVE for scope, budgets, and identities.",
    "- You do NOT create authority; you propose the smallest legal next action.",
    "- Do NOT invent repository facts beyond the trusted context below.",
    "- Do NOT expand budgets, merge, deploy, or override human gates.",
    "- Do NOT reference any other Radio-managed product.",
    "",
    "Return a single structured Orchestrator Decision object conforming to the provided schema.",
  ].join("\n");

  const user = [
    `projectId (required): ${projectId}`,
    `workstreamId (required): ${workstreamId}`,
    `transactionId (required): ${transactionId}`,
    `objectiveId: ${authority.objectiveId}`,
    `approvalId: ${authority.approvalId}`,
    `stateRevision: ${state.stateRevision}`,
    `stateFingerprint: ${fingerprint}`,
    `decisionId: generate a unique decisionId string`,
    `generatedAt: use a valid current ISO-8601 timestamp`,
    "",
    "=== HUMAN OBJECTIVE AUTHORITY (AUTHORITATIVE) ===",
    JSON.stringify(
      {
        objectiveId: authority.objectiveId,
        approvalId: authority.approvalId,
        summary: authority.summary,
        permittedWorkTypes: authority.permittedWorkTypes,
        prohibitedScope: authority.prohibitedScope,
        humanGatedActions: authority.humanGatedActions,
        maxIterations: authority.maxIterations,
        maxCursorAgents: authority.maxCursorAgents,
        maxRetriesPerLogicalStep: authority.maxRetriesPerLogicalStep,
        maxCursorUsageTokens: authority.maxCursorUsageTokens,
        maxEstimatedSpend: authority.maxEstimatedSpend,
        stateRevisionBasis: authority.stateRevisionBasis,
        consumed: authority.consumed,
        accounting: authority.accounting,
      },
      null,
      2,
    ),
    "",
    "=== AUTHORIZED BELLHOP SOURCE (TRUSTED) ===",
    JSON.stringify(authorizedSource, null, 2),
    "",
    "=== CURRENT BELLHOP PROJECT STATE (JSON) ===",
    JSON.stringify(state, null, 2),
    "",
    "=== LEGAL DECISION VOCABULARY ===",
    `decision enum: ${DECISION_VOCABULARY.join(" | ")}`,
    "",
    "=== RUNTIME STATE TRANSITION CONSTRAINT ===",
    `Current authoritative radioRuntime.state: ${currentRuntimeState}`,
    `stateTransition.from MUST equal ${currentRuntimeState}.`,
    `stateTransition.to MUST be one of the legal direct outgoing states: ${legalToTargets.join(" | ") || "(none)"}`,
    "For LAUNCH_CURSOR from PLANNING: propose PLANNING → IMPLEMENTING.",
    "Radio runtime later performs IMPLEMENTING → WAITING_FOR_AGENT after Cursor dispatch.",
    "",
    "=== TASK ===",
    `Decide the smallest legal first orchestration action for objective: ${authority.summary}`,
    "Use ONLY the authorized workstreamId, transactionId, and source pins above.",
    "Respect prohibitedScope and humanGatedActions from objective authority.",
    "If proposing LAUNCH_CURSOR, populate cursorInstruction with structured fields only:",
    "  - requestedWork: executable work only (what Cursor should implement/verify);",
    "  - verificationCriteria: acceptance checks (may verify absence of prohibitedScope items);",
    "  - Do NOT put prohibitedScope reminders or Radio guardrails into requestedWork;",
    "  - Do NOT author the final Cursor prompt — Radio renders guardrails separately from trusted authority.",
    "Populate required payloads for the chosen decision; set unused payloads to null.",
  ].join("\n");

  const context: SolContext = {
    system,
    user,
    vocabulary: [...DECISION_VOCABULARY],
    fingerprint,
    stateRevision: state.stateRevision,
  };

  if (contextContainsCyberAssuranceLeak(context)) {
    throw new Error(
      "Phase 3 initial context leaked Cyber Assurance content into Bellhop Sol context",
    );
  }

  return context;
}
