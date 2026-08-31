/**
 * Canonical objective-start preparation for Phase 3 live entry.
 *
 * Transitions an ACCEPTED terminal baseline into PLANNING for a newly
 * authorized objective.workstream/transaction — without consuming authority.
 */

import type { ObjectiveAuthority, ProjectState } from "../types.js";
import { isLegalTransition } from "../policy/transitions.js";
import {
  persistProjectState,
  transitionRuntimeState,
} from "../state/mutate.js";
import { alignStateBudgetsWithObjectiveAuthority } from "./cursor-agent-budget.js";
import {
  alignRemediationBudgetWithObjectiveAuthority,
  isRemediationBudgetExhausted,
  resolveEffectiveRemediationBudget,
} from "./remediation-budget.js";

export type ObjectiveStartCode =
  | "OBJECTIVE_START_OK"
  | "RUNTIME_NOT_ACCEPTED"
  | "ACTIVE_AGENT_PRESENT"
  | "ILLEGAL_TRANSITION"
  | "STATE_REVISION_MISMATCH";

export interface ObjectiveStartResult {
  ok: boolean;
  code: ObjectiveStartCode;
  summary: string;
  state: ProjectState;
  fingerprint: string;
}

/**
 * Prepare Radio state for a newly authorized Phase 3 objective from an
 * ACCEPTED baseline: ACCEPTED → IDLE → PLANNING with authority-bound
 * workstream/transaction identity.
 */
export function prepareAcceptedBaselineForObjectiveStart(input: {
  state: ProjectState;
  authority: ObjectiveAuthority;
  statePath: string;
}): ObjectiveStartResult {
  const { authority } = input;
  let state = input.state;

  if (state.stateRevision < authority.stateRevisionBasis) {
    return {
      ok: false,
      code: "STATE_REVISION_MISMATCH",
      summary: `State revision ${state.stateRevision} is older than authority basis ${authority.stateRevisionBasis}`,
      state,
      fingerprint: "",
    };
  }

  if (state.activeAgent != null) {
    return {
      ok: false,
      code: "ACTIVE_AGENT_PRESENT",
      summary: "Cannot start objective while an active agent is bound",
      state,
      fingerprint: "",
    };
  }

  const runtime = state.radioRuntime.state;
  if (runtime !== "ACCEPTED" && runtime !== "IDLE" && runtime !== "PLANNING") {
    return {
      ok: false,
      code: "RUNTIME_NOT_ACCEPTED",
      summary: `Objective start requires ACCEPTED/IDLE/PLANNING baseline; found ${runtime}`,
      state,
      fingerprint: "",
    };
  }

  if (runtime === "ACCEPTED") {
    state = transitionRuntimeState(state, "IDLE", "PHASE3_OBJECTIVE_START_IDLE");
    state = {
      ...state,
      activeWorkstream: null,
      currentTransaction: null,
      nextTransaction: null,
      radioRuntime: {
        ...state.radioRuntime,
        activeTransactionId: null,
        activeWorkOrderId: null,
      },
    };
  }

  state = bindObjectiveWorkstream(state, authority);

  // Align transaction Cursor-agent budget to ObjectiveAuthority.maxCursorAgents
  // so stale Stage-2 maxCursorAgentsPerTransaction=1 cannot throttle a
  // human-authorized objective max (e.g. 3).
  state = alignStateBudgetsWithObjectiveAuthority(state, authority);
  // Align remediation budget when objective permits REMEDIATION (Retry-12 fix).
  state = alignRemediationBudgetWithObjectiveAuthority(state, authority);

  if (state.radioRuntime.state === "IDLE") {
    if (!isLegalTransition("IDLE", "PLANNING")) {
      return {
        ok: false,
        code: "ILLEGAL_TRANSITION",
        summary: "IDLE → PLANNING is not legal",
        state,
        fingerprint: "",
      };
    }
    state = transitionRuntimeState(state, "PLANNING", "PHASE3_OBJECTIVE_START_PLANNING");
  } else if (state.radioRuntime.state === "PLANNING") {
    state = {
      ...state,
      radioRuntime: {
        ...state.radioRuntime,
        lastEvent: "PHASE3_OBJECTIVE_START_PLANNING",
        lastError: null,
      },
    };
  }

  const revBefore = state.stateRevision;
  const persisted = persistProjectState({
    state,
    path: input.statePath,
    expectedRevision: revBefore,
  });

  return {
    ok: true,
    code: "OBJECTIVE_START_OK",
    summary: "Objective workstream/transaction prepared; runtime PLANNING",
    state: persisted.state,
    fingerprint: persisted.fingerprint,
  };
}

function bindObjectiveWorkstream(
  state: ProjectState,
  authority: ObjectiveAuthority,
): ProjectState {
  const transactionType = resolveTransactionType(authority);
  // Prefer full trusted ObjectiveAuthority source pin for the fresh transaction.
  // PROJECT-STATE canonical mainSha may remain abbreviated display metadata;
  // it must not become the live dispatch pin or downgrade a full authority SHA.
  const trustedBranch =
    authority.baseBranch?.trim() || state.canonicalState.mainBranch;
  const trustedSha =
    authority.expectedStartingSha?.trim() || state.canonicalState.mainSha;
  const remediationBudget = resolveEffectiveRemediationBudget({
    permittedWorkTypes: authority.permittedWorkTypes,
    defaultRemediationBudgetPerTransaction:
      state.authority.defaultRemediationBudgetPerTransaction,
  });
  const remediationsUsed = 0;
  return {
    ...state,
    activeWorkstream: {
      id: authority.workstreamId,
      name: authority.summary.slice(0, 120),
      status: "PLANNING",
      terminalVerdict: null,
      priority: "HIGH",
      scopeGuard: authority.prohibitedScope.join("; "),
    },
    currentTransaction: {
      id: authority.transactionId,
      type: transactionType,
      status: "PLANNING",
      branch: trustedBranch,
      branchTipSha: trustedSha,
      sourceBaseBranch: trustedBranch,
      sourceBaseTipSha: trustedSha,
      finalExecutableSha: null,
      evidenceTipSha: null,
      remediationBudget,
      remediationsUsed,
      remediationBudgetExhausted: isRemediationBudgetExhausted({
        remediationBudget,
        remediationsUsed,
      }),
      recoverySequence: 0,
      pr: { state: "NOT_OPENED", number: null, url: null },
      review: {
        solFinal: { agentId: null, verdict: null },
        opusFinal: { agentId: null, verdict: null },
      },
    },
    nextTransaction: null,
    activeAgent: null,
    radioRuntime: {
      ...state.radioRuntime,
      activeTransactionId: authority.transactionId,
      activeWorkOrderId: null,
    },
  };
}

function resolveTransactionType(
  authority: ObjectiveAuthority,
): "IMPLEMENTATION" | "VERIFICATION" | "RECOVERY" | "REMEDIATION" | "CLOSEOUT" {
  if (authority.permittedWorkTypes.includes("VERIFICATION")) {
    return "VERIFICATION";
  }
  if (authority.permittedWorkTypes.includes("IMPLEMENTATION")) {
    return "IMPLEMENTATION";
  }
  if (authority.permittedWorkTypes.includes("CLOSEOUT")) {
    return "CLOSEOUT";
  }
  if (authority.permittedWorkTypes.includes("RECOVERY")) {
    return "RECOVERY";
  }
  if (authority.permittedWorkTypes.includes("REMEDIATION")) {
    return "REMEDIATION";
  }
  return "IMPLEMENTATION";
}
