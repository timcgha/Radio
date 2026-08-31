/**
 * Objective-aware work-order scope derivation.
 *
 * Historical Stage-2 pilot boilerplate (Star Beam / Starting Stage 3 out of
 * scope) must not remain active after a human Stage-3 ObjectiveAuthority.
 * Current enforced scope is derived from the active objective + decision;
 * historical project notes remain documentation only.
 */

import type { ObjectiveAuthority, WorkType } from "../types.js";
import { resolveProjectConfig } from "../projects/registry.js";

export class WorkOrderScopeContradictionError extends Error {
  readonly code = "WORK_ORDER_SCOPE_CONTRADICTION" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkOrderScopeContradictionError";
  }
}

export interface WorkOrderScopeSections {
  inScope: string[];
  outOfScope: string[];
  allowedProductChanges: string[];
  protectedSemantics: string[];
  hardProhibitions: string[];
  /** True when Stage 3 / Star Beam are authorized by current objective. */
  stage3Authorized: boolean;
}

export function isStage3ObjectiveAuthorized(
  authority: ObjectiveAuthority | null | undefined,
): boolean {
  if (!authority) return false;
  const summary = authority.summary.toLowerCase();
  // Human Stage-3 objectives name Stage 3 and/or Star Beam in the summary.
  return /\bstage\s*3\b/.test(summary) || /\bstar\s*beam\b/.test(summary);
}

/**
 * Build enforced current scope for the work order.
 * Without ObjectiveAuthority: retain Stage-2 verification pilot boundaries.
 */
export function buildObjectiveAwareWorkOrderScope(input: {
  projectKey: string;
  objectiveAuthority?: ObjectiveAuthority | null;
  workType: WorkType | string;
  repository: string;
}): WorkOrderScopeSections {
  const project = resolveProjectConfig(input.projectKey);
  const authority = input.objectiveAuthority ?? null;
  const stage3Authorized = isStage3ObjectiveAuthorized(authority);

  if (project.key === "cyber-assurance") {
    return buildCyberAssuranceWorkOrderScope({
      authority,
      workType: input.workType,
      repository: input.repository,
    });
  }

  if (!authority) {
    return stage2VerificationPilotScope(input.repository);
  }

  if (stage3Authorized) {
    return stage3AuthorizedScope(authority, input.workType);
  }

  // Objective present but Stage 3 not authorized (e.g. Stage-2 bounded work).
  return stage2ObjectiveAwareScope(authority, input.repository);
}

function buildCyberAssuranceWorkOrderScope(input: {
  authority: ObjectiveAuthority | null;
  workType: WorkType | string;
  repository: string;
}): WorkOrderScopeSections {
  const implementation =
    input.workType === "IMPLEMENTATION" ||
    input.workType === "DESIGN" ||
    input.workType === "RECOVERY";
  const authority = input.authority;
  const outOfScope = [
    "Wave 2 work or deferred Wave 2 scope.",
    "Failure Controller changes.",
    "Merge of any pull request.",
    "Production deploy or automatic deployment.",
    "Creating specialists or an API Parent.",
    ...(authority?.prohibitedScope.map(
      (item) => `Objective prohibited: ${item}`,
    ) ?? []),
  ];
  return {
    stage3Authorized: false,
    inScope: [
      `Verify Cyber Assurance repository identity at ${input.repository} before execution.`,
      "Verify Radio-authorized source pins (branch + full SHA) before any product inspection or edit.",
      "Perform only the authorized Wave 1 verification-integrity / recovery work in requestedWork.",
      "Run the repository's npm test, typecheck, lint, build, and transaction-specific verification-integrity tests as required.",
      "Return a structured completion report suitable for Radio ingestion.",
    ],
    outOfScope: uniqueStrings(outOfScope),
    allowedProductChanges: implementation
      ? [
          "Wave 1 verification-integrity fixes and supporting tests as authorized by requestedWork.",
          "UX Wave 1 recovery evidence updates required by verificationCriteria.",
        ]
      : [],
    protectedSemantics: [
      "Wave 1 verification-integrity semantics and false-pass guardrails.",
      "Immutable historical acceptance boundaries unless explicitly authorized.",
      "Human specialist review gate before merge/deploy/Wave 2.",
    ],
    hardProhibitions: [
      "Do NOT start Wave 2.",
      "Do NOT modify Failure Controller.",
      "Do NOT make unauthorized product code edits.",
      "Do NOT merge.",
      "Do NOT deploy.",
      "Do NOT create specialists or an API Parent.",
      "Do NOT create or merge a PR.",
    ],
  };
}

function stage2VerificationPilotScope(repository: string): WorkOrderScopeSections {
  return {
    stage3Authorized: false,
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
    hardProhibitions: [
      "Do NOT make gameplay or product code edits.",
      "Do NOT merge.",
      "Do NOT deploy.",
      "Do NOT start Stage 3.",
      "Do NOT retune flight.",
      "Do NOT create specialists or an API Parent.",
      "Do NOT create or merge a PR.",
    ],
  };
}

function stage2ObjectiveAwareScope(
  authority: ObjectiveAuthority,
  _repository: string,
): WorkOrderScopeSections {
  const outOfScope = [
    "Any gameplay code change or product edit unless explicitly authorized by requestedWork.",
    "Starting Stage 3.",
    "Star Beam or Star Beam crates.",
    "Deployment.",
    "Creating specialists or an API Parent.",
    ...authority.prohibitedScope.map((item) => `Objective prohibited: ${item}`),
  ];
  return {
    stage3Authorized: false,
    inScope: [
      "Verify repository identity and Radio-authorized source pins before execution.",
      "Perform only the authorized Stage-2-bounded requested work.",
      "Return a structured completion report suitable for Radio ingestion.",
    ],
    outOfScope: uniqueStrings(outOfScope),
    allowedProductChanges: [],
    protectedSemantics: [
      "Stage 1.5 A-thrust flight model and coast behavior.",
      "Core control contract.",
      "Existing earlier-level behavior.",
      "Stage 2 content/encounter behavior.",
      "Human playtest gate before merge/deploy/Stage 3.",
    ],
    hardProhibitions: [
      "Do NOT make unauthorized gameplay or product code edits.",
      "Do NOT merge.",
      "Do NOT deploy.",
      "Do NOT start Stage 3.",
      "Do NOT retune flight unless explicitly authorized.",
      "Do NOT create specialists or an API Parent.",
      "Do NOT create or merge a PR.",
    ],
  };
}

function stage3AuthorizedScope(
  authority: ObjectiveAuthority,
  workType: WorkType | string,
): WorkOrderScopeSections {
  const implementation =
    workType === "IMPLEMENTATION" || workType === "DESIGN";

  const inScope = [
    "Materialize and verify the Radio-authorized ObjectiveAuthority source (branch + full SHA) before any product inspection or edit.",
    "Implement and/or verify Bellhop Level 4 Stage 3 planet sequence and Star Beam as authorized by the current objective and requestedWork.",
    "Run the repository's existing deterministic Bellhop test suite and build check as required by verificationCriteria.",
    "Confirm no Stage 4+ work, merge, or deployment occurred.",
    "Return a structured completion report suitable for Radio ingestion.",
  ];

  const outOfScope = [
    "Stage 4 or later content.",
    "Level 4 Stage 4.",
    "Unrelated broad flight retuning.",
    "Unrelated refactoring outside Stage 3 needs.",
    "Merge of any pull request.",
    "Production deploy or automatic deployment.",
    "Budget expansion.",
    "Creating specialists or an API Parent.",
    "Radio implementation changes.",
    ...authority.prohibitedScope.map((item) => `Objective prohibited: ${item}`),
  ];

  // Explicitly ensure Stage-2 historical bans are NOT carried as active scope.
  const filteredOut = uniqueStrings(outOfScope).filter(
    (item) =>
      !/\bstar\s*beam\b/i.test(item) &&
      !/\bstarting stage 3\b/i.test(item) &&
      !/^starting stage 3\.?$/i.test(item.trim()),
  );

  const allowedProductChanges = implementation
    ? [
        "Stage 3 planet sequence gameplay, progression, and presentation as authorized by requestedWork.",
        "Star Beam gameplay and supporting assets/tests as authorized by requestedWork.",
        "Stage 3 automated tests and verification harness updates required by verificationCriteria.",
      ]
    : [];

  return {
    stage3Authorized: true,
    inScope,
    outOfScope: filteredOut,
    allowedProductChanges,
    protectedSemantics: [
      "Accepted Stage 2 foundation behavior unless Stage 3 specs require integration changes.",
      "Core control contract except where Stage 3 specifications explicitly extend it.",
      "Human product/playtest gate before merge/deploy/Stage 4.",
    ],
    hardProhibitions: [
      "Do NOT implement Stage 4 or later.",
      "Do NOT merge.",
      "Do NOT deploy.",
      "Do NOT expand budgets.",
      "Do NOT create specialists or an API Parent.",
      "Do NOT perform unrelated broad flight retuning.",
      "Do NOT create or merge a PR unless explicitly human-gated and authorized.",
    ],
  };
}

/**
 * Fail closed when rendered enforced scope would contradict requestedWork.
 * Prefers never generating the contradiction; this is a last-line invariant.
 */
export function assertWorkOrderScopeConsistent(input: {
  requestedWork: string;
  outOfScope: string[];
  hardProhibitions: string[];
}): "WORK_ORDER_SCOPE_CONSISTENT" {
  const requested = input.requestedWork.toLowerCase();
  const enforced = [...input.outOfScope, ...input.hardProhibitions];

  const starBeamRequested = /\bstar\s*beam\b/.test(requested);
  const stage3Requested =
    /\bstage\s*3\b/.test(requested) ||
    /\bstart(?:ing)?\s+stage\s*3\b/.test(requested);

  for (const item of enforced) {
    const line = item.toLowerCase();
    if (starBeamRequested && /\bstar\s*beam\b/.test(line)) {
      throw new WorkOrderScopeContradictionError(
        "WORK_ORDER_SCOPE_CONTRADICTION: requestedWork authorizes Star Beam but enforced scope prohibits Star Beam",
      );
    }
    if (
      stage3Requested &&
      (/\bstarting stage 3\b/.test(line) ||
        /\bdo not start stage 3\b/.test(line))
    ) {
      throw new WorkOrderScopeContradictionError(
        "WORK_ORDER_SCOPE_CONTRADICTION: requestedWork authorizes Stage 3 but enforced scope prohibits Starting Stage 3",
      );
    }
  }
  return "WORK_ORDER_SCOPE_CONSISTENT";
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Re-derive hard prohibitions for prompt rendering from the already-built
 * work-order scope (schema does not carry a separate hardProhibitions field).
 */
export function deriveHardProhibitionsFromWorkOrderScope(scope: {
  outOfScope: string[];
  allowedProductChanges: string[];
}): string[] {
  const outJoined = scope.outOfScope.join("\n").toLowerCase();
  const stage3Active =
    scope.allowedProductChanges.some((c) =>
      /\bstar\s*beam\b|\bstage\s*3\b/i.test(c),
    ) ||
    (!/\bstar\s*beam\b/.test(outJoined) &&
      !/\bstarting stage 3\b/.test(outJoined) &&
      scope.allowedProductChanges.length > 0);

  if (stage3Active) {
    return [
      "Do NOT implement Stage 4 or later.",
      "Do NOT merge.",
      "Do NOT deploy.",
      "Do NOT expand budgets.",
      "Do NOT create specialists or an API Parent.",
      "Do NOT perform unrelated broad flight retuning.",
      "Do NOT create or merge a PR unless explicitly human-gated and authorized.",
    ];
  }

  if (
    /\bstar\s*beam\b/.test(outJoined) ||
    /\bstarting stage 3\b/.test(outJoined)
  ) {
    return [
      "Do NOT make gameplay or product code edits.",
      "Do NOT merge.",
      "Do NOT deploy.",
      "Do NOT start Stage 3.",
      "Do NOT retune flight.",
      "Do NOT create specialists or an API Parent.",
      "Do NOT create or merge a PR.",
    ];
  }

  return [
    "Do NOT merge.",
    "Do NOT deploy.",
    "Do NOT create specialists or an API Parent.",
    "Do NOT create or merge a PR.",
  ];
}
