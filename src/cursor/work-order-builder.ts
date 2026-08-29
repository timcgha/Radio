import type {
  CursorWorkOrder,
  OrchestratorDecision,
  PolicyEvaluation,
  ProjectState,
} from "../types.js";
import { formatAjvErrors, getSchemaValidator, newId, nowIso } from "../util/io.js";

export interface BuildWorkOrderInput {
  state: ProjectState;
  decision: OrchestratorDecision;
  policy: PolicyEvaluation;
}

/**
 * Derive a Cursor work order from state + validated Sol decision + policy.
 * Uses PILOT-WORK-ORDER.json as semantic reference, not a byte-for-byte copy.
 */
export function buildCursorWorkOrder(input: BuildWorkOrderInput): CursorWorkOrder {
  const { state, decision, policy } = input;

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

  const workstreamId = decision.workstreamId ?? state.activeWorkstream?.id;
  const transactionId = decision.transactionId ?? state.currentTransaction?.id;
  if (!workstreamId || !transactionId) {
    throw new Error("workstreamId and transactionId are required");
  }

  const branch =
    state.currentTransaction?.branch ??
    cursor.baseBranch ??
    "cursor/level4-stage2-asteroid-garden-9dce";
  const tip =
    state.currentTransaction?.branchTipSha ??
    cursor.expectedStartingSha ??
    "aa512d6";
  const baseBranch =
    state.currentTransaction?.sourceBaseBranch ??
    state.canonicalState.mainBranch;
  const baseSha =
    state.currentTransaction?.sourceBaseTipSha ??
    state.canonicalState.mainSha;

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
      "Independently verify the existing Level 4 Stage 2 Asteroid Garden branch is technically ready for its required human playtest.",
    source: {
      repository: state.project.repository,
      canonicalMainBranch: state.canonicalState.mainBranch,
      canonicalMainSha: state.canonicalState.mainSha,
      baseBranch: branch,
      expectedBaseTipSha: tip,
      expectedExecutableAncestorSha: baseSha,
      workingBranch: branch,
      createWorkingBranch: false,
    },
    scope: {
      inScope: [
        "Verify actual Bellhop repository identity before any execution.",
        "Verify level3 integration base and Stage 2 branch/tip pins against reported source state.",
        "Run the repository's existing deterministic Bellhop test suite.",
        "Run the repository's existing build check.",
        "Confirm verification leaves no uncommitted product/build diff.",
        "Return a structured completion report suitable for Radio ingestion.",
      ],
      outOfScope: [
        "Any gameplay code change or product edit.",
        "Any Level 4 Stage 1.5 flight retune.",
        "Star Beam or Star Beam crates.",
        "Candy Planet / Crystal Cavern.",
        "Saucer Belt or additional saucers.",
        "Observatory.",
        "Later Snoozles.",
        "Black-hole warp-tunnel finish.",
        "Opening, merging, or modifying PR #39.",
        "Deployment.",
        "Starting Stage 3.",
        "Creating specialists or an API Parent.",
        "Remediation of product/test code.",
      ],
      allowedProductChanges: [],
      protectedSemantics: [
        "Stage 1.5 A-thrust flight model and coast behavior.",
        "Core control contract.",
        "Existing earlier-level behavior.",
        "Stage 2 content/encounter behavior.",
        "Human playtest gate before merge/deploy/Stage 3.",
      ],
    },
    requirements: [
      {
        id: "PILOT-REQ-001",
        class: "POLICY",
        priority: "P0",
        statement: `Verify the Bellhop repository at ${state.project.repository} and confirm the reported source branch/tip before running verification.`,
        acceptanceMethod:
          "Repository is reachable and observed branch/SHA state is recorded; any material mismatch halts precheck rather than guessing.",
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
        acceptanceMethod: "No product files changed; no PR merge/deploy/Stage 3 activity.",
      },
    ],
    agentPlan: {
      bootstrapRequired: false,
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
      maxAgents: Math.max(1, state.budgets.maxCursorAgentsPerTransaction),
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
      postExecutableDiffMustBeEmpty: true,
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
      requiredReportFields: [
        "agent ID",
        "repository identity",
        "observed level3/base SHA",
        "observed Stage 2 branch tip",
        "test command/result/counts",
        "build command/result",
        "working tree result",
        "product files changed YES/NO",
        "flight/gameplay changed YES/NO",
        "PR state",
        "merge attempted YES/NO",
        "deployment attempted YES/NO",
        "remaining blockers",
        "recommended next action",
        "final verdict",
      ],
      finalReportFormat: "EXACTLY_ONE_FENCED_TEXT_BLOCK_NOTHING_BEFORE_OR_AFTER",
    },
    stopConditions: [
      {
        id: "STOP-001",
        condition: "Actual repository cannot be discovered or verified.",
        requiredOutcome: "HALT_PRECHECK",
      },
      {
        id: "STOP-002",
        condition:
          "Observed Stage 2 branch/tip materially differs from the pinned pilot state.",
        requiredOutcome: "HALT_PRECHECK",
      },
      {
        id: "STOP-003",
        condition: "Verification requires a gameplay/product change to become green.",
        requiredOutcome: "REQUEST_HUMAN",
      },
      {
        id: "STOP-004",
        condition: "Full tests or build fail.",
        requiredOutcome: "HALT_BLOCKED",
      },
      {
        id: "STOP-005",
        condition:
          "Verification leaves unexplained product/build changes in the working tree.",
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
