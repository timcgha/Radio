import type { AgentAction, CursorInstruction, ProjectState } from "../types.js";

export interface NextTransactionAgentRequirement {
  requiredAgentAction?: AgentAction;
}

export interface VerificationPolicySpecialistGate {
  finalDualReviewRequiredForComplexWork?: boolean;
}

/**
 * Transaction / supervisory agent requirement — distinct from the
 * implementation worker dispatched via Phase 1 POST /v1/agents.
 *
 * Sources (in priority order):
 * 1. nextTransaction.requiredAgentAction (human-authorized future transaction)
 * 2. Sol cursorInstruction.agentAction when it requests Parent/Auto orchestration
 * 3. verificationPolicy dual-review gate with specialist budget headroom
 */
export function resolveTransactionSupervisoryAgentAction(
  state: ProjectState,
  cursor: CursorInstruction,
): AgentAction | null {
  const nextTxn = state.nextTransaction as NextTransactionAgentRequirement | null;
  if (nextTxn?.requiredAgentAction === "FRESH_API_CREATED_PARENT_AUTO_REQUIRED") {
    return "FRESH_API_CREATED_PARENT_AUTO_REQUIRED";
  }

  if (cursor.agentAction === "FRESH_API_CREATED_PARENT_AUTO_REQUIRED") {
    return "FRESH_API_CREATED_PARENT_AUTO_REQUIRED";
  }

  const verificationPolicy =
    state.verificationPolicy as VerificationPolicySpecialistGate;
  if (
    verificationPolicy.finalDualReviewRequiredForComplexWork &&
    state.budgets.maxSpecialistCallsPerTransaction > 0
  ) {
    return "FRESH_API_CREATED_PARENT_AUTO_REQUIRED";
  }

  return null;
}

/**
 * Implementation / evidence worker action for Phase 1 create-agent dispatch.
 *
 * Parent/Auto is reserved for later specialist orchestration (Sol + Opus review).
 * The coding/evidence worker remains an ordinary fresh Cursor agent.
 */
export function resolveImplementationWorkerAgentAction(
  cursorAgentAction: AgentAction,
  transactionSupervisoryAgentAction: AgentAction | null,
): AgentAction {
  if (cursorAgentAction === "REUSE_CURRENT_AGENT") {
    return "REUSE_CURRENT_AGENT";
  }

  if (
    cursorAgentAction === "FRESH_API_CREATED_PARENT_AUTO_REQUIRED" ||
    transactionSupervisoryAgentAction ===
      "FRESH_API_CREATED_PARENT_AUTO_REQUIRED"
  ) {
    return "FRESH_ORDINARY_AGENT_REQUIRED";
  }

  return cursorAgentAction;
}

export function specialistReviewRequired(
  state: ProjectState,
  transactionSupervisoryAgentAction: AgentAction | null,
): boolean {
  if (
    transactionSupervisoryAgentAction ===
    "FRESH_API_CREATED_PARENT_AUTO_REQUIRED"
  ) {
    return true;
  }

  const verificationPolicy =
    state.verificationPolicy as VerificationPolicySpecialistGate;
  return Boolean(
    verificationPolicy.finalDualReviewRequiredForComplexWork &&
      state.budgets.maxSpecialistCallsPerTransaction > 0,
  );
}
