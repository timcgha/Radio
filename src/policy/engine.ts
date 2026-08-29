import type {
  DecisionEnvelope,
  OrchestratorDecision,
  PolicyEvaluation,
  ProjectState,
  RuntimeState,
} from "../types.js";
import { formatAjvErrors, getSchemaValidator, newId, nowIso } from "../util/io.js";
import { isLegalTransition, TERMINAL_RUNTIME_STATES } from "./transitions.js";

export interface PolicyInput {
  decision: OrchestratorDecision;
  state: ProjectState;
  envelope: DecisionEnvelope;
  currentFingerprint: string;
}

type RuleOutcome = PolicyEvaluation["triggeredRules"][number];

/**
 * Deterministic Radio policy engine. Does not repair illegal Sol decisions.
 *
 * CRITICAL: CURSOR_EXECUTION_ENABLED=false must NOT cause REJECT of a legal
 * LAUNCH_CURSOR. Policy answers legality; runtime answers whether external
 * Cursor actions are enabled in this phase.
 */
export function evaluatePolicy(input: PolicyInput): PolicyEvaluation {
  const { decision, state, envelope, currentFingerprint } = input;
  const rules: RuleOutcome[] = [];
  const currentRuntimeState = state.radioRuntime.state;

  const fail = (
    primaryCode: string,
    result: PolicyEvaluation["result"],
    summary: string,
    extras: Partial<PolicyEvaluation> = {},
  ): PolicyEvaluation => {
    const evaluation: PolicyEvaluation = {
      schemaVersion: "1.0",
      evaluationId: newId("pol"),
      decisionId: decision.decisionId,
      evaluatedAt: nowIso(),
      result,
      primaryCode,
      summary,
      triggeredRules: rules,
      currentRuntimeState,
      proposedRuntimeState: decision.stateTransition?.to ?? null,
      executionPermitted: false,
      solShouldChooseAgain: result === "REJECT",
      humanInputRequired: result === "REQUIRE_HUMAN",
      requiredApprovalType: extras.requiredApprovalType ?? null,
      idempotencyKey: extras.idempotencyKey ?? null,
      stateFingerprint: currentFingerprint,
      ...extras,
    };
    return validatePolicyEvaluation(evaluation);
  };

  // P0 — Contract integrity / identity
  if (decision.projectId !== state.project.id) {
    rules.push({
      ruleId: "P0_PROJECT_IDENTITY",
      outcome: "FAIL",
      message: `projectId ${decision.projectId} != ${state.project.id}`,
    });
    return fail("PROJECT_MISMATCH", "REJECT", "Decision projectId does not match project state");
  }
  rules.push({
    ruleId: "P0_PROJECT_IDENTITY",
    outcome: "PASS",
    message: "projectId matches",
  });

  const expectedWorkstream = state.activeWorkstream?.id ?? null;
  if (expectedWorkstream && decision.workstreamId !== expectedWorkstream) {
    rules.push({
      ruleId: "P0_WORKSTREAM_IDENTITY",
      outcome: "FAIL",
      message: `workstreamId ${decision.workstreamId} != ${expectedWorkstream}`,
    });
    return fail(
      "WORKSTREAM_MISMATCH",
      "REJECT",
      "Decision workstreamId does not match active workstream",
    );
  }
  rules.push({
    ruleId: "P0_WORKSTREAM_IDENTITY",
    outcome: "PASS",
    message: "workstreamId matches",
  });

  const expectedTxn = state.currentTransaction?.id ?? null;
  if (
    expectedTxn &&
    decision.transactionId !== null &&
    decision.transactionId !== expectedTxn
  ) {
    rules.push({
      ruleId: "P0_TRANSACTION_IDENTITY",
      outcome: "FAIL",
      message: `transactionId ${decision.transactionId} != ${expectedTxn}`,
    });
    return fail(
      "TRANSACTION_MISMATCH",
      "REJECT",
      "Decision transactionId does not match current transaction",
    );
  }
  rules.push({
    ruleId: "P0_TRANSACTION_IDENTITY",
    outcome: "PASS",
    message: "transactionId matches",
  });

  // Stale-decision guard via envelope fingerprint (schema has no fingerprint field)
  if (envelope.requestFingerprint !== currentFingerprint) {
    rules.push({
      ruleId: "P0_STALE_FINGERPRINT",
      outcome: "FAIL",
      message: "Envelope requestFingerprint does not match current state fingerprint",
    });
    return fail(
      "STALE_DECISION",
      "REJECT",
      "Decision was evaluated against a stale state fingerprint",
    );
  }
  rules.push({
    ruleId: "P0_STALE_FINGERPRINT",
    outcome: "PASS",
    message: "Fingerprint matches current authoritative state",
  });

  // Payload consistency for decision kind
  const payloadIssue = checkPayloadConsistency(decision);
  if (payloadIssue) {
    rules.push({
      ruleId: "P0_PAYLOAD_CONSISTENCY",
      outcome: "FAIL",
      message: payloadIssue,
    });
    return fail("SCHEMA_INVALID", "REJECT", payloadIssue);
  }
  rules.push({
    ruleId: "P0_PAYLOAD_CONSISTENCY",
    outcome: "PASS",
    message: "Decision payloads are consistent with decision kind",
  });

  // P1 — Terminal-state protection
  const txnStatus = state.currentTransaction?.status ?? "";
  const terminalTxn = ["ACCEPTED", "BLOCKED", "FAILED", "COMPLETE"].includes(
    txnStatus,
  );
  if (
    terminalTxn &&
    (decision.decision === "LAUNCH_CURSOR" ||
      decision.decision === "REUSE_CURSOR")
  ) {
    rules.push({
      ruleId: "P1_TERMINAL_TRANSACTION",
      outcome: "FAIL",
      message: `Transaction status ${txnStatus} is terminal; cannot launch/reuse Cursor`,
    });
    return fail(
      "TERMINAL_TRANSACTION",
      "REJECT",
      "Cannot launch Cursor against a terminal transaction",
    );
  }
  rules.push({
    ruleId: "P1_TERMINAL_TRANSACTION",
    outcome: "PASS",
    message: "Transaction is not terminal for launch purposes",
  });

  // P7 — Runtime transition
  if (decision.stateTransition.from !== currentRuntimeState) {
    rules.push({
      ruleId: "P7_TRANSITION_FROM",
      outcome: "FAIL",
      message: `stateTransition.from ${decision.stateTransition.from} != runtime ${currentRuntimeState}`,
    });
    return fail(
      "ILLEGAL_STATE_TRANSITION",
      "REJECT",
      "Decision stateTransition.from does not match current runtime state",
    );
  }
  if (
    !isLegalTransition(
      decision.stateTransition.from,
      decision.stateTransition.to,
    )
  ) {
    rules.push({
      ruleId: "P7_TRANSITION_EDGE",
      outcome: "FAIL",
      message: `Illegal transition ${decision.stateTransition.from} → ${decision.stateTransition.to}`,
    });
    return fail(
      "ILLEGAL_STATE_TRANSITION",
      "REJECT",
      "Proposed runtime state transition is not in the legal transition table",
    );
  }
  rules.push({
    ruleId: "P7_TRANSITION",
    outcome: "PASS",
    message: "Runtime transition is legal",
  });

  // Human authority / deferred / budgets / agent action — decision-specific
  if (
    decision.decision === "LAUNCH_CURSOR" ||
    decision.decision === "REUSE_CURSOR"
  ) {
    const cursor = decision.cursorInstruction!;

    // Active-agent guard
    if (
      decision.decision === "LAUNCH_CURSOR" &&
      state.activeAgent &&
      cursor.agentAction !== "REUSE_CURRENT_AGENT"
    ) {
      rules.push({
        ruleId: "P3_ACTIVE_AGENT",
        outcome: "FAIL",
        message: `activeAgent ${state.activeAgent.agentId} exists; refusing duplicate fresh launch`,
      });
      return fail(
        "ACTIVE_AGENT_CONFLICT",
        "REJECT",
        "An equivalent Cursor agent is already active",
      );
    }
    rules.push({
      ruleId: "P3_ACTIVE_AGENT",
      outcome: "PASS",
      message: "No conflicting active agent for this launch",
    });

    if (
      decision.decision === "LAUNCH_CURSOR" &&
      cursor.agentAction === "REUSE_CURRENT_AGENT"
    ) {
      rules.push({
        ruleId: "P9_LAUNCH_REUSE_MISMATCH",
        outcome: "FAIL",
        message: "LAUNCH_CURSOR cannot use REUSE_CURRENT_AGENT",
      });
      return fail(
        "ILLEGAL_AGENT_ACTION",
        "REJECT",
        "LAUNCH_CURSOR must not use REUSE_CURRENT_AGENT",
      );
    }

    if (
      decision.decision === "REUSE_CURSOR" &&
      (!state.activeAgent || cursor.agentAction !== "REUSE_CURRENT_AGENT")
    ) {
      rules.push({
        ruleId: "P9_REUSE_AVAILABILITY",
        outcome: "FAIL",
        message: "REUSE_CURSOR requires an eligible active agent",
      });
      return fail(
        "REUSE_AGENT_NOT_AVAILABLE",
        "REJECT",
        "No eligible agent available to reuse",
      );
    }

    // Specialist / API Parent budget
    if (cursor.agentAction === "FRESH_API_CREATED_PARENT_AUTO_REQUIRED") {
      if (state.budgets.maxSpecialistCallsPerTransaction <= 0) {
        rules.push({
          ruleId: "P6_SPECIALIST_BUDGET",
          outcome: "FAIL",
          message: "API Parent / specialist workflow exceeds specialist budget 0",
        });
        return fail(
          "AGENT_BUDGET_EXHAUSTED",
          "REJECT",
          "Specialist/API-Parent workflow is not permitted under Pilot 01 budgets",
        );
      }
    }

    // Remediation budget
    if (
      cursor.workType === "REMEDIATION" ||
      cursor.maxRemediationPasses > (state.currentTransaction?.remediationBudget ?? 0)
    ) {
      if (
        cursor.workType === "REMEDIATION" ||
        (state.currentTransaction?.remediationBudget ?? 0) <= 0
      ) {
        rules.push({
          ruleId: "P6_REMEDIATION_BUDGET",
          outcome: "FAIL",
          message: "Remediation not permitted (budget 0 / exhausted)",
        });
        return fail(
          "REMEDIATION_BUDGET_EXHAUSTED",
          "REJECT",
          "Remediation proposal rejected because remediation budget is 0",
        );
      }
    }

    if (cursor.maxRemediationPasses > 0 && (state.currentTransaction?.remediationBudget ?? 0) === 0) {
      rules.push({
        ruleId: "P6_REMEDIATION_PASSES",
        outcome: "FAIL",
        message: "maxRemediationPasses > 0 but transaction remediation budget is 0",
      });
      return fail(
        "REMEDIATION_BUDGET_EXHAUSTED",
        "REJECT",
        "Remediation passes requested but Pilot 01 remediation budget is 0",
      );
    }

    // Agent count budget
    if (state.budgets.maxCursorAgentsPerTransaction < 1) {
      rules.push({
        ruleId: "P6_AGENT_BUDGET",
        outcome: "FAIL",
        message: "maxCursorAgentsPerTransaction < 1",
      });
      return fail(
        "AGENT_BUDGET_EXHAUSTED",
        "REJECT",
        "Cursor agent budget exhausted",
      );
    }

    // Recovery masquerading
    if (cursor.workType === "RECOVERY") {
      if (state.budgets.maxRecoveriesPerWorkstream <= 0) {
        rules.push({
          ruleId: "P6_RECOVERY_BUDGET",
          outcome: "FAIL",
          message: "Recovery work type not permitted (budget 0)",
        });
        return fail(
          "RECOVERY_BUDGET_EXHAUSTED",
          "REJECT",
          "Recovery is not permitted under Pilot 01 budgets",
        );
      }
    }

    // Deferred / frozen scope signals in objective/prompt
    const scopeText = `${cursor.objective}\n${cursor.prompt}`.toLowerCase();
    const deferredHits = detectDeferredActivation(scopeText, state);
    if (deferredHits) {
      rules.push({
        ruleId: "P5_DEFERRED_SCOPE",
        outcome: "FAIL",
        message: deferredHits.message,
      });
      return fail(
        deferredHits.code,
        deferredHits.result,
        deferredHits.message,
        { requiredApprovalType: deferredHits.approvalType },
      );
    }
    rules.push({
      ruleId: "P5_DEFERRED_SCOPE",
      outcome: "PASS",
      message: "No deferred/frozen activation detected",
    });

    // Human-gated actions appearing as Cursor work
    const humanGate = detectHumanGatedCursorWork(scopeText, cursor.workType);
    if (humanGate) {
      rules.push({
        ruleId: "P4_HUMAN_AUTHORITY",
        outcome: "FAIL",
        message: humanGate.message,
      });
      return fail("HUMAN_APPROVAL_REQUIRED", "REQUIRE_HUMAN", humanGate.message, {
        requiredApprovalType: humanGate.approvalType,
      });
    }
    rules.push({
      ruleId: "P4_HUMAN_AUTHORITY",
      outcome: "PASS",
      message: "Cursor instruction does not autonomously perform human-gated actions",
    });

    // Fresh ordinary agent is legal when no specialists required
    if (cursor.agentAction === "FRESH_ORDINARY_AGENT_REQUIRED") {
      rules.push({
        ruleId: "P9_AGENT_ACTION",
        outcome: "PASS",
        message: "FRESH_ORDINARY_AGENT_REQUIRED is legal for non-specialist work",
      });
    }
  }

  // REQUEST_HUMAN_APPROVAL path
  if (decision.decision === "REQUEST_HUMAN_APPROVAL") {
    rules.push({
      ruleId: "P4_REQUEST_HUMAN",
      outcome: "INFO",
      message: "Sol correctly routed to human approval",
    });
    const evaluation: PolicyEvaluation = {
      schemaVersion: "1.0",
      evaluationId: newId("pol"),
      decisionId: decision.decisionId,
      evaluatedAt: nowIso(),
      result: "REQUIRE_HUMAN",
      primaryCode: "HUMAN_APPROVAL_REQUIRED",
      summary: "Human approval requested by Sol decision",
      triggeredRules: rules,
      currentRuntimeState,
      proposedRuntimeState: decision.stateTransition.to,
      executionPermitted: false,
      solShouldChooseAgain: false,
      humanInputRequired: true,
      requiredApprovalType: decision.humanApproval?.approvalType ?? "OTHER",
      idempotencyKey: null,
      stateFingerprint: currentFingerprint,
    };
    return validatePolicyEvaluation(evaluation);
  }

  // Merge/deploy autonomous decisions disguised as other kinds
  if (decision.decision === "ACCEPT_WORKSTREAM") {
    // Accepting a workstream does not grant merge; Phase 0 simply marks policy.
    rules.push({
      ruleId: "P11_ACCEPT",
      outcome: "INFO",
      message: "ACCEPT_WORKSTREAM does not imply merge/deploy authority",
    });
  }

  // Phase 0 note: execution config is informational only for policy
  rules.push({
    ruleId: "PHASE0_EXECUTION_CONFIG",
    outcome: "INFO",
    message:
      "CURSOR_EXECUTION_ENABLED is a runtime switch; it does not alter policy legality of LAUNCH_CURSOR",
  });

  const idempotencyKey =
    decision.decision === "LAUNCH_CURSOR" || decision.decision === "REUSE_CURSOR"
      ? buildIdempotencyKey(decision, state)
      : null;

  const allowExecution =
    decision.decision === "LAUNCH_CURSOR" ||
    decision.decision === "REUSE_CURSOR" ||
    decision.decision === "NO_ACTION" ||
    decision.decision === "WAIT" ||
    decision.decision === "BLOCK_WORKSTREAM" ||
    decision.decision === "ACCEPT_WORKSTREAM";

  const evaluation: PolicyEvaluation = {
    schemaVersion: "1.0",
    evaluationId: newId("pol"),
    decisionId: decision.decisionId,
    evaluatedAt: nowIso(),
    result: "ALLOW",
    primaryCode: "OK",
    summary: `Policy allows ${decision.decision}`,
    triggeredRules: rules,
    currentRuntimeState,
    proposedRuntimeState: decision.stateTransition.to,
    executionPermitted: allowExecution,
    solShouldChooseAgain: false,
    humanInputRequired: false,
    requiredApprovalType: null,
    idempotencyKey,
    stateFingerprint: currentFingerprint,
  };

  // Guard: do not ALLOW if somehow in a terminal runtime with relaunch — already handled
  if (TERMINAL_RUNTIME_STATES.has(currentRuntimeState) && decision.decision === "LAUNCH_CURSOR") {
    return fail(
      "TERMINAL_TRANSACTION",
      "REJECT",
      "Runtime is terminal; launch refused",
    );
  }

  return validatePolicyEvaluation(evaluation);
}

function checkPayloadConsistency(decision: OrchestratorDecision): string | null {
  switch (decision.decision) {
    case "LAUNCH_CURSOR":
    case "REUSE_CURSOR":
      if (!decision.cursorInstruction) {
        return `${decision.decision} requires cursorInstruction`;
      }
      if (decision.humanApproval) return `${decision.decision} must not include humanApproval`;
      if (decision.wait) return `${decision.decision} must not include wait`;
      return null;
    case "REQUEST_HUMAN_APPROVAL":
      if (!decision.humanApproval) return "REQUEST_HUMAN_APPROVAL requires humanApproval";
      if (decision.cursorInstruction) return "REQUEST_HUMAN_APPROVAL must not include cursorInstruction";
      return null;
    case "WAIT":
      if (!decision.wait) return "WAIT requires wait payload";
      if (decision.cursorInstruction) return "WAIT must not include cursorInstruction";
      return null;
    case "NO_ACTION":
      if (decision.cursorInstruction) return "NO_ACTION must not include cursorInstruction";
      if (decision.humanApproval) return "NO_ACTION must not include humanApproval";
      if (decision.wait) return "NO_ACTION must not include wait";
      return null;
    case "ACCEPT_WORKSTREAM":
    case "BLOCK_WORKSTREAM":
      if (decision.cursorInstruction) return `${decision.decision} must not include cursorInstruction`;
      if (!decision.terminal) return `${decision.decision} requires terminal payload`;
      return null;
    default:
      return null;
  }
}

/**
 * Strip prohibition / boundary language so phrases like
 * "do not retune flight" or "without merge" do not false-positive
 * as activation of deferred/human-gated work.
 *
 * Also strips common list markers so Sol bullet lines such as
 * "- Do not implement Stage 3" are still treated as prohibitions.
 */
function actionableScopeText(scopeText: string): string {
  return scopeText
    .split(/\n+/)
    .map((line) => stripLeadingListMarker(line.trim()))
    .filter((line) => {
      if (!line) return false;
      if (
        /^(do not|don't|must not|shall not|never|forbid|prohibited|out of scope|hard prohibition|without)\b/i.test(
          line,
        )
      ) {
        return false;
      }
      if (/\b(without|forbids?|prohibiting)\b/i.test(line)) return false;
      return true;
    })
    .join("\n");
}

/** Normalize markdown/plain list prefixes before prohibition matching. */
function stripLeadingListMarker(line: string): string {
  return line
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function detectDeferredActivation(
  scopeText: string,
  state: ProjectState,
): {
  code: string;
  result: "REJECT" | "REQUIRE_HUMAN";
  message: string;
  approvalType: string;
} | null {
  const text = actionableScopeText(scopeText);

  // Explicit activation of deferred Stage 3 / Star Beam / flight retune
  if (
    /\bstart(?:ing)?\s+stage\s*3\b/.test(text) ||
    /\bbegin(?:ning)?\s+stage\s*3\b/.test(text) ||
    /\bimplement(?:ing)?\s+stage\s*3\b/.test(text)
  ) {
    return {
      code: "DEFERRED_SCOPE",
      result: "REQUIRE_HUMAN",
      message: "Starting Stage 3 / deferred work requires human approval",
      approvalType: "START_DEFERRED_WORK",
    };
  }
  if (
    /\bimplement(?:ing)?\s+star\s*beam\b/.test(text) ||
    /\badd(?:ing)?\s+star\s*beam\b/.test(text)
  ) {
    return {
      code: "DEFERRED_SCOPE",
      result: "REQUIRE_HUMAN",
      message: "Star Beam implementation is deferred and requires human approval",
      approvalType: "START_DEFERRED_WORK",
    };
  }
  if (
    /\bretune\s+flight\b/.test(text) ||
    /\bflight\s+retune\b/.test(text) ||
    /\bchange\s+flight\s+(feel|tuning|model)\b/.test(text)
  ) {
    return {
      code: "FROZEN_SCOPE",
      result: "REQUIRE_HUMAN",
      message: "Flight retuning is FROZEN and requires explicit human reactivation",
      approvalType: "START_DEFERRED_WORK",
    };
  }

  for (const item of state.deferredItems) {
    if (item.status === "FROZEN") {
      const name = item.name.toLowerCase();
      if (text.includes(`implement ${name}`) || text.includes(`start ${name}`)) {
        return {
          code: "FROZEN_SCOPE",
          result: "REQUIRE_HUMAN",
          message: `Frozen item ${item.id} (${item.name}) requires human reactivation`,
          approvalType: "START_DEFERRED_WORK",
        };
      }
    }
  }
  return null;
}

function detectHumanGatedCursorWork(
  scopeText: string,
  workType: string,
): { message: string; approvalType: string } | null {
  const text = actionableScopeText(scopeText);
  if (/\bmerge\s+pr\b/.test(text) || /\bmerge\s+#39\b/.test(text)) {
    return {
      message: "Merge requires human approval and is not autonomously allowed",
      approvalType: "MERGE_PR",
    };
  }
  if (
    /\bdeploy(?:ment)?\s+to\s+production\b/.test(text) ||
    /\bproduction\s+deploy\b/.test(text) ||
    (workType !== "VERIFICATION" && /\bdeploy\s+stage\s*2\b/.test(text))
  ) {
    return {
      message: "Production deployment requires human approval",
      approvalType: "PRODUCTION_DEPLOY",
    };
  }
  return null;
}

function buildIdempotencyKey(
  decision: OrchestratorDecision,
  state: ProjectState,
): string {
  const agent = decision.cursorInstruction?.agentAction ?? "unknown";
  const work = decision.cursorInstruction?.workType ?? "unknown";
  const txn = decision.transactionId ?? state.currentTransaction?.id ?? "none";
  return `${decision.projectId}:${txn}:launch:${agent}:${work}:${state.stateRevision}`;
}

function validatePolicyEvaluation(evaluation: PolicyEvaluation): PolicyEvaluation {
  const validate = getSchemaValidator("policy-evaluation.schema.json");
  const ok = validate(evaluation);
  if (!ok) {
    throw new Error(
      `Policy evaluation failed schema validation: ${formatAjvErrors(validate.errors)}`,
    );
  }
  return evaluation;
}

/** Exported for tests: evaluate a merge-without-approval proposal shape. */
export function humanApprovalRequiredForMerge(decision: OrchestratorDecision): boolean {
  if (decision.decision === "REQUEST_HUMAN_APPROVAL") {
    return decision.humanApproval?.approvalType === "MERGE_PR";
  }
  if (decision.cursorInstruction) {
    const text = `${decision.cursorInstruction.objective}\n${decision.cursorInstruction.prompt}`.toLowerCase();
    return /\bmerge\s+pr\b/.test(text) || /\bmerge\s+#39\b/.test(text);
  }
  return false;
}

export type { RuntimeState };
