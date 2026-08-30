import type {
  CursorWorkOrder,
  ObjectiveAuthority,
  OrchestratorDecision,
  PolicyEvaluation,
  ProjectState,
} from "../types.js";
import { resolveWorkOrderMaxAgents } from "../runtime/cursor-agent-budget.js";
import { formatAjvErrors, getSchemaValidator, newId, nowIso } from "../util/io.js";
import { requiredCompletionReportFieldsFromSchema } from "./completion-contract.js";
import {
  assertWorkOrderScopeConsistent,
  buildObjectiveAwareWorkOrderScope,
} from "./work-order-scope.js";

export interface BuildWorkOrderInput {
  state: ProjectState;
  decision: OrchestratorDecision;
  policy: PolicyEvaluation;
  /** Optional objective authority — Radio derives guardrails from trusted state. */
  objectiveAuthority?: ObjectiveAuthority | null;
}

/**
 * Derive a Cursor work order from state + validated Sol decision + policy.
 * Uses PILOT-WORK-ORDER.json as semantic reference, not a byte-for-byte copy.
 */
export function buildCursorWorkOrder(input: BuildWorkOrderInput): CursorWorkOrder {
  const { state, decision, policy, objectiveAuthority } = input;

  if (policy.result !== "ALLOW") {
    throw new Error("Work order may only be built after policy ALLOW");
  }
  if (
    decision.decision !== "LAUNCH_CURSOR" &&
    decision.decision !== "REUSE_CURSOR"
  ) {
    throw new Error("Work order requires LAUNCH_CURSOR or REUSE_CURSOR");
  }
  const cursor = decision.cursorInstruction;
  if (!cursor) {
    throw new Error("cursorInstruction is required to build a work order");
  }
  if (!cursor.requestedWork?.trim()) {
    throw new Error(
      "cursorInstruction.requestedWork is required to build a work order (no legacy prompt fallback)",
    );
  }
  if (!cursor.verificationCriteria?.trim()) {
    throw new Error(
      "cursorInstruction.verificationCriteria is required to build a work order",
    );
  }
  const radioGuardrails = buildRadioGuardrails({
    state,
    objectiveAuthority: objectiveAuthority ?? null,
    workType: cursor.workType,
  });

  const workstreamId = decision.workstreamId ?? state.activeWorkstream?.id;
  const transactionId = decision.transactionId ?? state.currentTransaction?.id;
  if (!workstreamId || !transactionId) {
    throw new Error("workstreamId and transactionId are required");
  }

  const STAGE2_EXPECTED_FULL =
    "aa512d6ef721f855be33ddc36da490f9de66dc23";
  const STAGE2_BRANCH = "cursor/level4-stage2-asteroid-garden-9dce";

  // Trusted Radio-owned source pin (ObjectiveAuthority) is the only authority
  // for live/Phase-3 dispatch identity. Sol cursorInstruction values are claims
  // that must already have passed exact binding — they are NOT the source of truth.
  const trustedBranch = objectiveAuthority?.baseBranch?.trim() || "";
  const trustedSha = objectiveAuthority?.expectedStartingSha?.trim() || "";

  // Source-pin field roles (do not blur):
  // - objectiveAuthority.baseBranch / expectedStartingSha: human-authorized pin
  // - cursor.expectedStartingSha / baseBranch: Sol claims only (never authority)
  // - currentTransaction.branchTipSha: may be abbreviated display copy — must NOT
  //   downgrade a full trusted ObjectiveAuthority pin
  // - canonicalState.mainSha: historical/display project SHA (not the live pin)
  const branch =
    trustedBranch ||
    state.currentTransaction?.branch ||
    cursor.baseBranch ||
    STAGE2_BRANCH;
  const rawTip = resolveAuthoritativeExpectedBaseTipSha({
    objectiveAuthorityExpectedStartingSha: trustedSha || null,
    solClaimedExpectedStartingSha: trustedSha
      ? null
      : cursor.expectedStartingSha,
    transactionBranchTipSha: trustedSha
      ? null
      : state.currentTransaction?.branchTipSha,
    fallbackFullSha: STAGE2_EXPECTED_FULL,
  });
  // Stage-2 fixture short→full expansion only. Never expand live authority pins
  // via Git lookup or prefix guessing — live authority already requires full SHA.
  const tip = trustedSha
    ? trustedSha
    : expandKnownCommitSha(rawTip, STAGE2_EXPECTED_FULL);
  const baseSha =
    trustedSha ||
    state.currentTransaction?.sourceBaseTipSha ||
    state.canonicalState.mainSha;

  const scopeSections = buildObjectiveAwareWorkOrderScope({
    objectiveAuthority: objectiveAuthority ?? null,
    workType: cursor.workType,
    repository: state.project.repository,
  });
  assertWorkOrderScopeConsistent({
    requestedWork: cursor.requestedWork,
    outOfScope: scopeSections.outOfScope,
    hardProhibitions: scopeSections.hardProhibitions,
  });

  const stage3 = scopeSections.stage3Authorized;
  const maxAgents = resolveWorkOrderMaxAgents({
    stateMaxCursorAgentsPerTransaction:
      state.budgets.maxCursorAgentsPerTransaction,
    objectiveMaxCursorAgents: objectiveAuthority?.maxCursorAgents ?? null,
  });

  const workOrder: CursorWorkOrder = {
    schemaVersion: "1.0",
    workOrderId: newId("wo"),
    revision: 1,
    createdAt: nowIso(),
    projectId: state.project.id,
    workstreamId,
    transactionId,
    decisionId: decision.decisionId,
    idempotencyKey:
      policy.idempotencyKey ??
      `${state.project.id}:${transactionId}:${cursor.agentAction}:${state.stateRevision}`,
    agentAction: cursor.agentAction,
    workType: cursor.workType,
    objective:
      cursor.objective ||
      (stage3
        ? "Implement and technically verify Bellhop Level 4 Stage 3 (planet sequence / Star Beam) from the accepted Stage 2 base."
        : "Independently verify the existing Level 4 Stage 2 Asteroid Garden branch is technically ready for its required human playtest."),
    requestedWork: cursor.requestedWork,
    verificationCriteria: cursor.verificationCriteria,
    radioGuardrails,
    source: {
      repository: state.project.repository,
      canonicalMainBranch: state.canonicalState.mainBranch,
      canonicalMainSha: state.canonicalState.mainSha,
      // Dispatch source identity grounded in trusted ObjectiveAuthority when present.
      baseBranch: branch,
      expectedBaseTipSha: tip,
      expectedExecutableAncestorSha: baseSha,
      workingBranch: branch,
      createWorkingBranch: false,
    },
    scope: {
      inScope: scopeSections.inScope,
      outOfScope: scopeSections.outOfScope,
      allowedProductChanges: scopeSections.allowedProductChanges,
      protectedSemantics: scopeSections.protectedSemantics,
    },
    requirements: stage3
      ? [
          {
            id: "PILOT-REQ-001",
            class: "POLICY",
            priority: "P0",
            statement: `Materialize and verify Radio-authorized source ${branch}@${tip} in ${state.project.repository} before any product inspection or edit.`,
            acceptanceMethod:
              "git rev-parse HEAD exactly equals the trusted full SHA after authorized checkout/materialization; mismatch or failed checkout halts precheck.",
          },
          {
            id: "PILOT-REQ-002",
            class: "PRODUCT",
            priority: "P0",
            statement:
              "Perform only the Stage 3 / Star Beam work authorized by requestedWork and ObjectiveAuthority.",
            acceptanceMethod:
              "Changes stay within Stage 3 planet sequence / Star Beam; no Stage 4+, merge, or deploy.",
          },
          {
            id: "PILOT-REQ-003",
            class: "TEST",
            priority: "P0",
            statement: "Run the existing full Bellhop deterministic test suite.",
            acceptanceMethod:
              "node tests/run.js exits successfully; report actual suite/assertion counts.",
          },
          {
            id: "PILOT-REQ-004",
            class: "TEST",
            priority: "P0",
            statement: "Run the existing Bellhop build check.",
            acceptanceMethod: "node build.js exits successfully.",
          },
          {
            id: "PILOT-REQ-005",
            class: "EVIDENCE",
            priority: "P0",
            statement:
              "Confirm verificationCriteria, including no Stage 4 work, before requesting human review.",
            acceptanceMethod:
              "Completion report records verification outcomes and scope boundaries.",
          },
        ]
      : [
          {
            id: "PILOT-REQ-001",
            class: "POLICY",
            priority: "P0",
            statement: `Verify the Bellhop repository at ${state.project.repository} and confirm the reported source branch/tip before running verification.`,
            acceptanceMethod:
              "Repository is reachable and observed branch/SHA state is recorded; any material mismatch after authorized source materialization halts precheck rather than guessing.",
          },
          {
            id: "PILOT-REQ-002",
            class: "TEST",
            priority: "P0",
            statement: "Run the existing full Bellhop deterministic test suite.",
            acceptanceMethod:
              "node tests/run.js exits successfully; report actual suite/assertion counts.",
          },
          {
            id: "PILOT-REQ-003",
            class: "TEST",
            priority: "P0",
            statement: "Run the existing Bellhop build check.",
            acceptanceMethod: "node build.js exits successfully.",
          },
          {
            id: "PILOT-REQ-004",
            class: "EVIDENCE",
            priority: "P0",
            statement: "Verification must not change product state.",
            acceptanceMethod:
              "Working tree is clean after verification; no commit is created.",
          },
          {
            id: "PILOT-REQ-005",
            class: "PRODUCT",
            priority: "P0",
            statement:
              "Do not change flight/gameplay and do not cross the playtest gate.",
            acceptanceMethod:
              "No product files changed; no PR merge/deploy/Stage 3 activity.",
          },
        ],
    agentPlan: {
      // Option B: worker must materialize Radio-authorized source before edits
      // when Cursor cloud workspace may initialize on the default branch.
      bootstrapRequired: true,
      reuseAgentId:
        cursor.agentAction === "REUSE_CURRENT_AGENT"
          ? (state.activeAgent?.agentId ?? null)
          : null,
      parent: null,
      specialists: [],
      forbiddenAgentTypes: [
        "sol-architect",
        "opus-adversarial-reviewer",
        "Explore",
        "generalPurpose",
        "Composer",
        "helper agents",
        "API Parent",
      ],
    },
    budgets: {
      maxRemediationPasses: Math.min(
        cursor.maxRemediationPasses,
        state.currentTransaction?.remediationBudget ?? 0,
      ),
      maxSpecialistReviewCycles: Math.min(
        0,
        state.budgets.maxSpecialistCallsPerTransaction,
      ),
      maxAgents,
      maxEstimatedUsd: state.budgets.maxEstimatedUsdPerTransaction,
    },
    verification: {
      requiredCommands: [
        "node tests/run.js",
        "node build.js",
        "git status --short",
      ],
      historicalProvenanceRequired: false,
      browser: {
        required: false,
        method: null,
        criticalJourneysClickBound: false,
        assertPathnameAndSearch: false,
        viewports: [],
        criteria: [],
      },
      executableFreezeRequired: false,
      postExecutableDiffMustBeEmpty: !stage3,
    },
    git: {
      protectedBranches: ["main", state.canonicalState.mainBranch].filter(
        (v, i, a) => a.indexOf(v) === i,
      ),
      pushRequired: false,
      forcePushAllowed: false,
      commitRequired: false,
    },
    pr: {
      creationAllowed: false,
      creationRequired: false,
      humanApprovalBeforeCreate: true,
      mergeAllowed: false,
    },
    completion: {
      allowedTerminalVerdicts:
        cursor.expectedTerminalVerdicts.length > 0
          ? cursor.expectedTerminalVerdicts
          : [
              "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST",
              "BELLHOP_RADIO_PILOT_BLOCKED",
            ],
      // Derived from schemas/cursor-completion-report.schema.json — do not invent a parallel list.
      requiredReportFields: requiredCompletionReportFieldsFromSchema(),
      finalReportFormat: "EXACTLY_ONE_FENCED_TEXT_BLOCK_NOTHING_BEFORE_OR_AFTER",
    },
    stopConditions: [
      {
        id: "STOP-000",
        condition: `Before any product inspection/edit: if git rev-parse HEAD ≠ ${tip}, perform ONLY the Radio-authorized source materialization (fetch/checkout the trusted ref ${branch} / exact full SHA ${tip}). Then re-check HEAD. If materialization fails or HEAD still does not exactly equal ${tip}: STOP immediately — no product work, no commits, no PR, no remediation, no fallback to main. Still emit schema-valid completion-report JSON (PRECHECK_BLOCKED / resultClass BLOCKED) inside exactly one fenced text block.`,
        requiredOutcome: "HALT_PRECHECK",
      },
      {
        id: "STOP-001",
        condition: "Actual repository cannot be discovered or verified.",
        requiredOutcome: "HALT_PRECHECK",
      },
      {
        id: "STOP-002",
        condition: stage3
          ? "Trusted authorized source cannot be materialized to the exact ObjectiveAuthority full SHA."
          : "Observed Stage 2 branch/tip materially differs from the pinned pilot state after authorized source materialization.",
        requiredOutcome: "HALT_PRECHECK",
      },
      {
        id: "STOP-003",
        condition: stage3
          ? "Requested Stage 3 work requires Stage 4+, merge, deploy, or other prohibited scope."
          : "Verification requires a gameplay/product change to become green.",
        requiredOutcome: "REQUEST_HUMAN",
      },
      {
        id: "STOP-004",
        condition: "Full tests or build fail.",
        requiredOutcome: "HALT_BLOCKED",
      },
      {
        id: "STOP-005",
        condition: stage3
          ? "Working tree contains unexplained out-of-scope changes (Stage 4+, merge/deploy artifacts, or unrelated retunes)."
          : "Verification leaves unexplained product/build changes in the working tree.",
        requiredOutcome: "HALT_BLOCKED",
      },
    ],
    rendering: {
      agentActionMustAppearNearTop: true,
      includeStructuredIdentity: true,
      includeSourcePins: true,
      includeScope: true,
      includeBudgets: true,
      includeStopConditions: true,
      includeCompletionContract: true,
    },
  };

  return validateWorkOrder(workOrder);
}

/**
 * Select the authoritative expectedBaseTipSha for work-order / source-ref precheck.
 *
 * Prefer trusted ObjectiveAuthority.expectedStartingSha over Sol claims and over
 * transaction/project display SHAs. Short metadata such as PROJECT-STATE mainSha
 * "847ca2d" copied into branchTipSha must not overwrite a full trusted pin.
 * Sol cursorInstruction.expectedStartingSha is a claim only — never authority.
 */
export function resolveAuthoritativeExpectedBaseTipSha(input: {
  objectiveAuthorityExpectedStartingSha?: string | null;
  solClaimedExpectedStartingSha?: string | null;
  /** @deprecated Prefer objectiveAuthorityExpectedStartingSha; Sol is not authority. */
  expectedStartingSha?: string | null;
  transactionBranchTipSha?: string | null;
  fallbackFullSha: string;
}): string {
  const trusted =
    input.objectiveAuthorityExpectedStartingSha?.trim() ||
    "";
  if (trusted) return trusted;

  // Legacy Phase 0/1 without ObjectiveAuthority: Sol claim may supply the pin,
  // but never outranks a trusted ObjectiveAuthority value above.
  const solClaim =
    input.solClaimedExpectedStartingSha?.trim() ||
    input.expectedStartingSha?.trim() ||
    "";
  if (solClaim) return solClaim;

  const txnTip = input.transactionBranchTipSha?.trim() || "";
  if (txnTip) return txnTip;
  return input.fallbackFullSha.trim();
}

/**
 * Expand an abbreviated SHA to a known full commit when it uniquely prefixes it.
 * Does not invent unrelated commits; unknown tips pass through unchanged.
 * Fixture / Stage-2 compatibility only — not a live prefix-equality escape hatch.
 */
export function expandKnownCommitSha(
  tip: string,
  knownFullSha: string,
): string {
  const raw = tip.trim();
  const full = knownFullSha.trim();
  if (!raw) return full;
  if (raw.toLowerCase() === full.toLowerCase()) return full;
  if (raw.length >= 7 && full.toLowerCase().startsWith(raw.toLowerCase())) {
    return full;
  }
  return raw;
}

/**
 * Radio-owned guardrails derived from trusted Radio / objective authority state.
 * These are rendered for the worker but must never be treated as Sol-requested
 * executable work for authority or P4 evaluation.
 */
export function buildRadioGuardrails(input: {
  state: ProjectState;
  objectiveAuthority?: ObjectiveAuthority | null;
  workType: string;
}): string[] {
  const guardrails: string[] = [
    "Do NOT merge any pull request.",
    "Do NOT perform production deploy or automatic deployment.",
    "Do NOT expand budgets, create specialist swarms, or create an API Parent unless explicitly authorized by Radio.",
    "Do NOT treat worker evidence as authority to widen scope.",
  ];
  const prohibited = input.objectiveAuthority?.prohibitedScope ?? [];
  for (const item of prohibited) {
    const line = `Prohibited by objective authority: ${item}`;
    if (!guardrails.includes(line)) guardrails.push(line);
  }
  const humanGated = input.objectiveAuthority?.humanGatedActions ?? [];
  for (const item of humanGated) {
    const line = `Human-gated (do not perform autonomously): ${item}`;
    if (!guardrails.includes(line)) guardrails.push(line);
  }
  // Pilot defaults when no objective authority is attached (Phase 0/1).
  if (!input.objectiveAuthority) {
    guardrails.push("Do NOT start Stage 3 or later.");
    guardrails.push("Do NOT retune flight / change the frozen flight model.");
    guardrails.push("Do NOT make gameplay or product code edits unless the requested work explicitly authorizes them.");
  }
  return guardrails;
}

export function validateWorkOrder(workOrder: unknown): CursorWorkOrder {
  const validate = getSchemaValidator("cursor-work-order.schema.json");
  const ok = validate(workOrder);
  if (!ok) {
    throw new Error(
      `Work order schema validation failed: ${formatAjvErrors(validate.errors)}`,
    );
  }
  return workOrder as CursorWorkOrder;
}
