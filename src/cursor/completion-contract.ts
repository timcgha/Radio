/**
 * Canonical worker completion-output contract.
 *
 * Derives the worker-facing required structure from
 * schemas/cursor-completion-report.schema.json so prompt instructions cannot
 * silently drift from Phase 2 ingestion.
 *
 * Phase 2 remains fail-closed: prose inside the text fence is never accepted.
 */

import type { CursorWorkOrder } from "../types.js";
import { loadSchema } from "../util/io.js";

export const COMPLETION_SCHEMA_FILE = "cursor-completion-report.schema.json";
export const COMPLETION_SCHEMA_VERSION = "1.0";

export const WORKER_OBSERVED = "<<WORKER_OBSERVED>>" as const;
export const WORKER_FILL_STRING = "<<WORKER_FILL:string>>" as const;
export const WORKER_FILL_ISO = "<<WORKER_FILL:iso8601>>" as const;
export const WORKER_FILL_BOOL = "<<WORKER_FILL:boolean>>" as const;
export const WORKER_FILL_NULLABLE_SHA = "<<WORKER_FILL:sha_or_null>>" as const;

export interface CompletionContractIdentity {
  /** Planned/actual ordinary agent id when known before launch. */
  plannedAgentId?: string | null;
}

export interface CompletionSchemaShape {
  requiredTopLevel: string[];
  resultClassEnum: string[];
  executionStatusEnum: string[];
  schemaVersionConst: string;
}

interface JsonSchemaNode {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  additionalProperties?: boolean;
  anyOf?: JsonSchemaNode[];
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
}

let cachedSchema: JsonSchemaNode | null = null;

export function loadCompletionReportSchema(): JsonSchemaNode {
  if (!cachedSchema) {
    cachedSchema = loadSchema(COMPLETION_SCHEMA_FILE) as JsonSchemaNode;
  }
  return cachedSchema;
}

/**
 * Deterministic extraction of schema facts used by prompts and drift tests.
 */
export function getCompletionSchemaShape(): CompletionSchemaShape {
  const schema = loadCompletionReportSchema();
  const requiredTopLevel = [...(schema.required ?? [])].sort();
  const resultClassEnum = (schema.properties?.resultClass?.enum ?? []).map(String);
  const executionStatusEnum = (
    schema.properties?.execution?.properties?.status?.enum ?? []
  ).map(String);
  const schemaVersionConst = String(
    schema.properties?.schemaVersion?.const ?? COMPLETION_SCHEMA_VERSION,
  );
  return {
    requiredTopLevel,
    resultClassEnum,
    executionStatusEnum,
    schemaVersionConst,
  };
}

/**
 * Build a concrete completion-report template from the canonical schema,
 * pre-populating Radio-supplied immutable identity values from the work order.
 */
export function buildCompletionReportTemplate(
  workOrder: CursorWorkOrder,
  identity: CompletionContractIdentity = {},
): Record<string, unknown> {
  const shape = getCompletionSchemaShape();
  const plannedAgentId =
    typeof identity.plannedAgentId === "string" && identity.plannedAgentId.length > 0
      ? identity.plannedAgentId
      : null;

  const ordinaryAgent = plannedAgentId
    ? {
        agentId: plannedAgentId,
        role: "ORDINARY_AGENT",
        source: "api",
        model: null,
        status: WORKER_OBSERVED,
        verdict: WORKER_OBSERVED,
      }
    : {
        agentId: "<<RADIO_ASSIGNS_PLANNED_bc-uuid_AT_LAUNCH — do not invent>>",
        role: "ORDINARY_AGENT",
        source: "api",
        model: null,
        status: WORKER_OBSERVED,
        verdict: WORKER_OBSERVED,
      };

  return {
    schemaVersion: shape.schemaVersionConst,
    reportId: WORKER_FILL_STRING,
    workOrderId: workOrder.workOrderId,
    workOrderRevision: workOrder.revision,
    projectId: workOrder.projectId,
    workstreamId: workOrder.workstreamId,
    transactionId: workOrder.transactionId,
    decisionId: workOrder.decisionId,
    generatedAt: WORKER_FILL_ISO,
    execution: {
      agentAction: workOrder.agentAction,
      workType: workOrder.workType,
      bootstrapAgent: null,
      primaryAgent: null,
      ordinaryAgent,
      startedAt: WORKER_FILL_ISO,
      completedAt: WORKER_FILL_ISO,
      status: WORKER_OBSERVED,
    },
    repositoryState: {
      repository: workOrder.source.repository,
      canonicalMainBranch: workOrder.source.canonicalMainBranch,
      expectedCanonicalMainSha: workOrder.source.canonicalMainSha,
      observedCanonicalMainSha: WORKER_FILL_NULLABLE_SHA,
      baseBranch: workOrder.source.baseBranch,
      expectedBaseTipSha: workOrder.source.expectedBaseTipSha,
      observedBaseTipSha: WORKER_FILL_NULLABLE_SHA,
      workingBranch: WORKER_OBSERVED,
      startingWorkingSha: WORKER_FILL_NULLABLE_SHA,
      branchTipSha: WORKER_FILL_NULLABLE_SHA,
      sourcePinsMatched: WORKER_FILL_BOOL,
      finalExecutableSha: null,
      evidenceTipSha: null,
    },
    changeSummary: {
      filesChanged: [],
      productFilesChanged: [],
      testFilesChanged: [],
      browserEvidenceFilesChanged: [],
      documentationMetadataFilesChanged: [],
      productStateMachineChanged: false,
      persistedSchemaChanged: false,
      protectedSemanticsChanged: false,
      scopeExpanded: false,
      summary: WORKER_FILL_STRING,
    },
    requirementResults: [],
    testResults: [],
    browserVerification: {
      required: false,
      method: null,
      verdict: "NOT_REQUIRED",
      targetExecutableSha: null,
      boundToFinalExecutableSha: false,
      fallbackUsed: false,
      fallbackReason: null,
      viewports: [],
      journeys: [],
      criteria: [],
      consoleNetworkHandling: {
        uncaughtApplicationErrors: 0,
        http5xxCount: 0,
        reactRuntimeErrors: 0,
        failedMutationCalls: 0,
        knownBenignNoise: [],
      },
      artifactRefs: [],
    },
    specialistReviews: [],
    remediation: {
      budget: workOrder.budgets.maxRemediationPasses,
      passesUsed: 0,
      exhausted: workOrder.budgets.maxRemediationPasses === 0,
      commitShas: [],
      findingsAddressed: [],
      findingsRemaining: [],
      executableChangedAfterRemediation: false,
    },
    evidenceBinding: {
      finalExecutableSha: null,
      evidenceTipSha: null,
      browserBoundToExecutable: false,
      finalReviewsBoundToExecutable: false,
      postExecutableExecutableDiffPresent: false,
      summariesContainBothShas: false,
    },
    historicalProvenance: [],
    blockers: [],
    deferredFindings: [],
    gitPr: {
      branchPushed: false,
      remoteBranch: null,
      branchTipSha: null,
      prCreationAllowed: workOrder.pr.creationAllowed,
      prCreationRequired: workOrder.pr.creationRequired,
      prState: "NOT_APPLICABLE",
      prNumber: null,
      prUrl: null,
      mergeState: "NOT_APPLICABLE",
      mergeAttempted: false,
    },
    resultClass: WORKER_OBSERVED,
    terminalVerdict: WORKER_OBSERVED,
    summary: WORKER_FILL_STRING,
    recommendedNextAction: {
      kind: WORKER_OBSERVED,
      summary: WORKER_FILL_STRING,
      requiresHumanApproval: WORKER_FILL_BOOL,
    },
    integrity: {
      workOrderIdentityMatched: true,
      allowedTerminalVerdict: true,
      requiredFieldsComplete: true,
      reportHash: null,
      stateFingerprint: null,
      artifactRefs: [],
    },
  };
}

/**
 * Immutable Radio-supplied field paths that the worker must not alter.
 */
export function listImmutableIdentityInstructions(
  workOrder: CursorWorkOrder,
  identity: CompletionContractIdentity = {},
): string[] {
  const lines: string[] = [
    `schemaVersion = "${COMPLETION_SCHEMA_VERSION}" (const)`,
    `workOrderId = "${workOrder.workOrderId}"`,
    `workOrderRevision = ${workOrder.revision}`,
    `projectId = "${workOrder.projectId}"`,
    `workstreamId = "${workOrder.workstreamId}"`,
    `transactionId = "${workOrder.transactionId}"`,
    `decisionId = "${workOrder.decisionId}"`,
    `execution.agentAction = "${workOrder.agentAction}"`,
    `execution.workType = "${workOrder.workType}"`,
    `repositoryState.repository = "${workOrder.source.repository}"`,
    `repositoryState.canonicalMainBranch = "${workOrder.source.canonicalMainBranch}"`,
    `repositoryState.expectedCanonicalMainSha = ${jsonLit(workOrder.source.canonicalMainSha)}`,
    `repositoryState.baseBranch = "${workOrder.source.baseBranch}"`,
    `repositoryState.expectedBaseTipSha = ${jsonLit(workOrder.source.expectedBaseTipSha)}`,
  ];
  if (identity.plannedAgentId) {
    lines.push(
      `execution.ordinaryAgent.agentId = "${identity.plannedAgentId}" (planned Radio agent identity — do not invent another)`,
    );
    lines.push(`execution.ordinaryAgent.role = "ORDINARY_AGENT"`);
  }
  return lines;
}

/**
 * Render the mandatory completion-output section for Cursor worker prompts.
 */
export function renderCompletionContractSection(
  workOrder: CursorWorkOrder,
  identity: CompletionContractIdentity = {},
): string {
  const shape = getCompletionSchemaShape();
  const template = buildCompletionReportTemplate(workOrder, identity);
  const immutable = listImmutableIdentityInstructions(workOrder, identity);
  const allowedVerdicts = workOrder.completion.allowedTerminalVerdicts;

  const lines: string[] = [];
  lines.push("==================================================");
  lines.push("CRITICAL COMPLETION-OUTPUT CONTRACT (MANDATORY)");
  lines.push("==================================================");
  lines.push(
    "Technical verification instructions determine WHAT work is performed.",
  );
  lines.push(
    "This completion-report schema determines HOW the final result is returned.",
  );
  lines.push("BOTH are mandatory. The completion format is not optional.");
  lines.push("");
  lines.push(
    "FIRST substantive worker action: repository-integrity precheck (git rev-parse HEAD).",
  );
  lines.push(
    "LAST worker action: emit the canonical JSON completion report exactly as specified below.",
  );
  lines.push("");
  lines.push("RETURN RULES (fail-closed if violated):");
  lines.push(
    "1. Return the ENTIRE completion report inside EXACTLY ONE fenced `text` code block.",
  );
  lines.push("Nothing before it.");
  lines.push("Nothing after it.");
  lines.push("No nested fences.");
  lines.push("One contiguous block.");
  lines.push("2. Inside that fence: VALID JSON ONLY.");
  lines.push(
    `3. The JSON MUST conform exactly to schemas/${COMPLETION_SCHEMA_FILE}.`,
  );
  lines.push("4. No prose around the JSON. No prose headings inside the fence.");
  lines.push("5. No comments. No trailing commas. No markdown wrappers inside the fence.");
  lines.push(
    "6. No additional wrapper object beyond the schema root. No omitted required fields.",
  );
  lines.push("");
  lines.push(
    `finalReportFormat: ${workOrder.completion.finalReportFormat}`,
  );
  lines.push(
    `Canonical schema required top-level fields: ${shape.requiredTopLevel.join(", ")}`,
  );
  lines.push(
    `resultClass enum (choose exactly one): ${shape.resultClassEnum.join(" | ")}`,
  );
  lines.push(
    `execution.status enum (choose exactly one): ${shape.executionStatusEnum.join(" | ")}`,
  );
  lines.push(
    `allowed terminalVerdict values for this work order: ${allowedVerdicts.join(" | ")}`,
  );
  lines.push("");
  lines.push("IMMUTABLE RADIO-SUPPLIED VALUES (do not alter):");
  for (const item of immutable) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("WORKER-OBSERVED VALUES:");
  lines.push(
    `- Replace every ${WORKER_OBSERVED} / ${WORKER_FILL_STRING} / ${WORKER_FILL_ISO} / ${WORKER_FILL_BOOL} / ${WORKER_FILL_NULLABLE_SHA} placeholder with real observed values.`,
  );
  lines.push(
    "- Do not invent Radio identity fields. Do not guess agent IDs when Radio supplied one.",
  );
  lines.push(
    "- runId is bound by Radio from transport evidence when required; do not invent a runId field unless the schema requires it (it does not).",
  );
  lines.push("");
  lines.push("ONE COMPLETION FORMAT FOR ALL OUTCOMES:");
  lines.push(
    "- PASS / READY / ACCEPTED → schema-valid JSON (same structure).",
  );
  lines.push(
    "- FAIL / FAILED → schema-valid JSON (same structure).",
  );
  lines.push(
    "- BLOCKED / PRECHECK_BLOCKED / HALT_PRECHECK → schema-valid JSON (same structure).",
  );
  lines.push("- Narrative prose is NEVER an acceptable completion body.");
  lines.push("");
  lines.push("BLOCKED / HALT_PRECHECK OUTCOME (still must emit valid JSON):");
  lines.push(
    "If git rev-parse HEAD ≠ authorized expectedBaseTipSha (or any STOP/precheck fires):",
  );
  lines.push("- STOP substantive work immediately.");
  lines.push("- Perform NO tests, NO build, NO product edits, NO commit, NO PR, NO remediation.");
  lines.push("- STILL return exactly one fenced `text` block containing schema-valid JSON.");
  lines.push("- Encode facts using canonical fields, for example:");
  lines.push('  - execution.status = "PRECHECK_BLOCKED"');
  lines.push('  - resultClass = "BLOCKED"');
  lines.push(
    `  - terminalVerdict = one allowed blocked verdict (e.g. "${allowedVerdicts.find((v) => /BLOCKED/i.test(v)) ?? allowedVerdicts[allowedVerdicts.length - 1]}")`,
  );
  lines.push("  - repositoryState.sourcePinsMatched = false");
  lines.push(
    "  - repositoryState.expectedBaseTipSha / observedBaseTipSha = expected vs observed SHAs",
  );
  lines.push(
    '  - testResults[*].result = "NOT_RUN"; changeSummary product arrays empty; gitPr.prState = "NOT_APPLICABLE"; remediation.passesUsed = 0',
  );
  lines.push(
    "  - blockers[] must include an acceptance-blocking precheck blocker",
  );
  lines.push("");
  lines.push(
    "CONCRETE COMPLETION-REPORT TEMPLATE (derived from schemas/cursor-completion-report.schema.json):",
  );
  lines.push(
    "Copy this object, replace WORKER placeholders, keep IMMUTABLE Radio values exact, then emit ONLY that JSON inside the single `text` fence:",
  );
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(template, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(
    "IMPORTANT: The `json` fence above is instructional scaffolding inside THIS prompt only.",
  );
  lines.push(
    "Your FINAL reply must contain exactly one fenced `text` code block whose body is the filled JSON object — and nothing else.",
  );
  return lines.join("\n");
}

/**
 * Required top-level field names from the canonical schema (sorted).
 * Single source for drift tests — do not maintain a parallel list.
 */
export function requiredCompletionReportFieldsFromSchema(): string[] {
  return getCompletionSchemaShape().requiredTopLevel;
}

function jsonLit(value: string | null): string {
  return JSON.stringify(value);
}
