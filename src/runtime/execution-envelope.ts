/**
 * Trusted Radio execution-envelope validation for Phase 2.
 * These checks are deterministic and must pass BEFORE Sol is called.
 * Worker semantic output is never authoritative for identity or authority.
 */

import type { CursorWorkOrder, ProjectState } from "../types.js";

/** Minimal Cursor run shape for envelope checks (read-only GET). */
export interface V1RunLike {
  id?: string;
  agentId?: string;
  status?: string;
  result?: string;
}

export type ExecutionEnvelopeCode =
  | "ENVELOPE_OK"
  | "RUNTIME_NOT_ELIGIBLE"
  | "AGENT_NOT_TERMINAL"
  | "AGENT_IDENTITY_MISMATCH"
  | "RUN_IDENTITY_MISSING"
  | "RUN_IDENTITY_MISMATCH"
  | "RUN_NOT_TERMINAL"
  | "RAW_RESULT_MISSING"
  | "WORK_ORDER_IDENTITY_MISSING"
  | "WORK_ORDER_MISMATCH"
  | "SUPERSEDED_EXECUTION"
  | "STALE_OR_CONFLICTING_STATE";

export interface TrustedExecutionIdentity {
  agentId: string;
  runId: string;
  workOrderId: string;
  transactionId: string;
  repository: string | null;
  authorizedSourceSha: string | null;
  transportStartingRef: string | null;
  stateRevision: number;
  stateFingerprint: string;
}

export interface ExecutionEnvelopeInput {
  state: ProjectState;
  fingerprint: string;
  selectedAgentId: string | null;
  selectedRunId: string | null;
  workOrder: CursorWorkOrder | null;
  rawResultText: string | null | undefined;
  /** When Cursor GET was used, the retrieved run (read-only). */
  cursorRun?: V1RunLike | null;
  /** Expected state revision binding (optional explicit check). */
  expectedStateRevision?: number | null;
}

export interface ExecutionEnvelopeResult {
  ok: boolean;
  code: ExecutionEnvelopeCode;
  summary: string;
  errors: string[];
  identity: TrustedExecutionIdentity | null;
}

const TERMINAL_AGENT_STATUSES = new Set(["COMPLETED", "FAILED", "BLOCKED"]);
const TERMINAL_RUN_STATUSES = new Set([
  "FINISHED",
  "FAILED",
  "CANCELLED",
  "ERROR",
]);

/**
 * Deterministically verify Radio-owned execution evidence for Phase 2 review.
 * Fail closed before Sol when the intended execution cannot be identified.
 */
export function validateTrustedExecutionEnvelope(
  input: ExecutionEnvelopeInput,
): ExecutionEnvelopeResult {
  const errors: string[] = [];
  const { state } = input;

  if (state.radioRuntime.state !== "VERIFYING") {
    return fail(
      "RUNTIME_NOT_ELIGIBLE",
      `Phase 2 requires radioRuntime.state=VERIFYING; found ${state.radioRuntime.state}`,
      errors,
    );
  }

  if (
    input.expectedStateRevision != null &&
    input.expectedStateRevision !== state.stateRevision
  ) {
    return fail(
      "STALE_OR_CONFLICTING_STATE",
      `State revision mismatch: expected ${input.expectedStateRevision}, found ${state.stateRevision}`,
      errors,
    );
  }

  const selectedAgentId = trimOrNull(input.selectedAgentId);
  const selectedRunId = trimOrNull(input.selectedRunId);

  if (!selectedAgentId) {
    return fail(
      "AGENT_IDENTITY_MISMATCH",
      "Cannot identify intended Cursor agentId for Phase 2 review",
      errors,
    );
  }
  if (!selectedRunId) {
    return fail(
      "RUN_IDENTITY_MISSING",
      "Cannot identify intended Cursor runId for Phase 2 review",
      errors,
    );
  }

  const active = state.activeAgent;
  if (!active?.agentId) {
    return fail(
      "AGENT_NOT_TERMINAL",
      "No activeAgent present; cannot verify completed execution identity",
      errors,
    );
  }

  if (active.agentId !== selectedAgentId) {
    return fail(
      "AGENT_IDENTITY_MISMATCH",
      `Selected agentId ${selectedAgentId} does not match Radio activeAgent ${active.agentId}`,
      errors,
    );
  }

  const agentStatus =
    typeof active.status === "string" ? active.status : "UNKNOWN";
  if (!TERMINAL_AGENT_STATUSES.has(agentStatus)) {
    return fail(
      "AGENT_NOT_TERMINAL",
      `activeAgent.status must be terminal; found ${agentStatus}`,
      errors,
    );
  }

  const durableRunId =
    typeof active.runId === "string" && active.runId.trim()
      ? active.runId.trim()
      : null;
  if (durableRunId && durableRunId !== selectedRunId) {
    return fail(
      "RUN_IDENTITY_MISMATCH",
      `Selected runId ${selectedRunId} does not match Radio-owned activeAgent.runId ${durableRunId}`,
      errors,
    );
  }

  // Superseding execution: Radio tracks a different active work order/agent.
  const activeWorkOrderId = state.radioRuntime.activeWorkOrderId;
  if (
    activeWorkOrderId &&
    typeof active.workOrderId === "string" &&
    active.workOrderId !== activeWorkOrderId
  ) {
    return fail(
      "SUPERSEDED_EXECUTION",
      `activeAgent.workOrderId ${active.workOrderId} superseded by radioRuntime.activeWorkOrderId ${activeWorkOrderId}`,
      errors,
    );
  }

  if (!input.workOrder?.workOrderId) {
    return fail(
      "WORK_ORDER_IDENTITY_MISSING",
      "Trusted work-order identity is required for Phase 2 review",
      errors,
    );
  }

  if (
    typeof active.workOrderId === "string" &&
    active.workOrderId !== input.workOrder.workOrderId
  ) {
    return fail(
      "WORK_ORDER_MISMATCH",
      `Work order ${input.workOrder.workOrderId} does not match activeAgent.workOrderId ${active.workOrderId}`,
      errors,
    );
  }

  if (
    activeWorkOrderId &&
    activeWorkOrderId !== input.workOrder.workOrderId
  ) {
    return fail(
      "WORK_ORDER_MISMATCH",
      `Work order ${input.workOrder.workOrderId} does not match radioRuntime.activeWorkOrderId ${activeWorkOrderId}`,
      errors,
    );
  }

  const raw = input.rawResultText;
  if (typeof raw !== "string" || raw.length === 0) {
    return fail(
      "RAW_RESULT_MISSING",
      "Raw Cursor result is missing or empty; Sol will not be called",
      errors,
    );
  }

  if (input.cursorRun) {
    const run = input.cursorRun;
    if (run.agentId && run.agentId !== selectedAgentId) {
      return fail(
        "AGENT_IDENTITY_MISMATCH",
        `Cursor GET agentId ${run.agentId} does not match selected ${selectedAgentId}`,
        errors,
      );
    }
    if (run.id && run.id !== selectedRunId) {
      return fail(
        "RUN_IDENTITY_MISMATCH",
        `Cursor GET runId ${run.id} does not match selected ${selectedRunId}`,
        errors,
      );
    }
    const runStatus = typeof run.status === "string" ? run.status : "";
    if (runStatus) {
      const upper = runStatus.toUpperCase();
      if (!TERMINAL_RUN_STATUSES.has(upper) && !TERMINAL_RUN_STATUSES.has(runStatus)) {
        return fail(
          "RUN_NOT_TERMINAL",
          `Selected Cursor run is not terminal; status=${runStatus}`,
          errors,
        );
      }
    }
  }

  const identity: TrustedExecutionIdentity = {
    agentId: selectedAgentId,
    runId: selectedRunId,
    workOrderId: input.workOrder.workOrderId,
    transactionId: input.workOrder.transactionId,
    repository: input.workOrder.source?.repository ?? state.project.repository,
    authorizedSourceSha:
      input.workOrder.source?.expectedBaseTipSha ??
      state.currentTransaction?.branchTipSha ??
      null,
    transportStartingRef:
      input.workOrder.source?.workingBranch ??
      state.currentTransaction?.branch ??
      null,
    stateRevision: state.stateRevision,
    stateFingerprint: input.fingerprint,
  };

  return {
    ok: true,
    code: "ENVELOPE_OK",
    summary: "Trusted execution envelope verified for Phase 2 review",
    errors: [],
    identity,
  };
}

function fail(
  code: ExecutionEnvelopeCode,
  summary: string,
  errors: string[],
): ExecutionEnvelopeResult {
  return {
    ok: false,
    code,
    summary,
    errors: [...errors, summary],
    identity: null,
  };
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}
