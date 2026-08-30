/**
 * Smallest machine-readable Phase 3 status summary for future mobile/web UX.
 * Not a UI — state/API-friendly data only.
 */

import type {
  ObjectiveAuthority,
  Phase3StatusSummary,
  Phase3TerminalVerdict,
  ProjectState,
  RuntimeState,
} from "../types.js";

export function buildPhase3StatusSummary(input: {
  state: ProjectState;
  authority: ObjectiveAuthority | null;
  terminalReason: Phase3TerminalVerdict | null;
  lastMeaningfulEvent: string | null;
  humanQuestion?: string | null;
  previewOrResultLink?: string | null;
}): Phase3StatusSummary {
  const { state, authority, terminalReason } = input;
  const humanActionRequired =
    terminalReason === "RADIO_PHASE3_READY_FOR_HUMAN" ||
    terminalReason === "RADIO_PHASE3_WAITING_FOR_HUMAN" ||
    state.radioRuntime.state === "READY_FOR_HUMAN" ||
    state.radioRuntime.state === "WAITING_FOR_HUMAN";

  return {
    schemaVersion: "phase3-status-1.0",
    objectiveId: authority?.objectiveId ?? null,
    objectiveSummary: authority?.summary ?? null,
    status: mapUxStatus({
      runtimeState: state.radioRuntime.state,
      terminalReason,
      humanActionRequired,
    }),
    currentPhase: "PHASE3",
    runtimeState: state.radioRuntime.state,
    workstreamId: state.activeWorkstream?.id ?? null,
    transactionId: state.currentTransaction?.id ?? null,
    activeAgentId: state.activeAgent?.agentId ?? null,
    activeRunId:
      typeof state.activeAgent?.runId === "string"
        ? state.activeAgent.runId
        : null,
    iterationCount: authority?.accounting.iterationsUsed ?? 0,
    maxIterations: authority?.maxIterations ?? null,
    cursorAgentsUsed: authority?.accounting.cursorAgentsUsed ?? 0,
    maxCursorAgents: authority?.maxCursorAgents ?? null,
    retriesUsed: authority?.accounting.retriesUsed ?? 0,
    maxRetriesPerLogicalStep: authority?.maxRetriesPerLogicalStep ?? null,
    budgetRemaining: {
      iterations:
        authority != null
          ? Math.max(0, authority.maxIterations - authority.accounting.iterationsUsed)
          : null,
      cursorAgents:
        authority != null
          ? Math.max(
              0,
              authority.maxCursorAgents - authority.accounting.cursorAgentsUsed,
            )
          : null,
      retries:
        authority != null
          ? Math.max(
              0,
              authority.maxRetriesPerLogicalStep - authority.accounting.retriesUsed,
            )
          : null,
    },
    lastMeaningfulEvent: input.lastMeaningfulEvent,
    humanActionRequired,
    humanQuestion: input.humanQuestion ?? null,
    previewOrResultLink: input.previewOrResultLink ?? null,
    terminalReason,
  };
}

function mapUxStatus(input: {
  runtimeState: RuntimeState;
  terminalReason: Phase3TerminalVerdict | null;
  humanActionRequired: boolean;
}): Phase3StatusSummary["status"] {
  if (input.terminalReason === "RADIO_PHASE3_BUDGET_EXHAUSTED") {
    return "Budget exhausted";
  }
  if (input.terminalReason === "RADIO_PHASE3_OBJECTIVE_COMPLETE") {
    return "Completed";
  }
  if (input.terminalReason === "RADIO_PHASE3_WAITING_FOR_AGENT") {
    return "Testing";
  }
  if (
    input.terminalReason === "RADIO_PHASE3_BLOCKED" ||
    input.terminalReason === "RADIO_PHASE3_POLICY_REJECTED" ||
    input.terminalReason === "RADIO_PHASE3_INFRASTRUCTURE_BLOCKED" ||
    input.terminalReason === "RADIO_PHASE3_INVALID_SOL_DECISION" ||
    input.terminalReason === "RADIO_PHASE3_OBJECTIVE_ALREADY_LEASED" ||
    input.runtimeState === "BLOCKED"
  ) {
    return "Blocked";
  }
  if (
    input.humanActionRequired ||
    input.terminalReason === "RADIO_PHASE3_AUTONOMOUS_LOOP_READY" ||
    input.terminalReason === "RADIO_PHASE3_READY_FOR_HUMAN" ||
    input.terminalReason === "RADIO_PHASE3_WAITING_FOR_HUMAN"
  ) {
    return "Needs your decision";
  }
  switch (input.runtimeState) {
    case "REVIEWING":
      return "Reviewing";
    case "VERIFYING":
    case "WAITING_FOR_AGENT":
      return "Testing";
    case "ACCEPTED":
      return "Completed";
    default:
      return "Working";
  }
}
