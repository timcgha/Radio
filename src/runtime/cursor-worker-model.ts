/**
 * Explicit Cursor worker model selection + cost-control policy.
 *
 * Live external execution MUST specify model.id on POST /v1/agents.
 * Implicit/default Cursor model selection fails closed.
 *
 * Exact dollar spend is NOT claimed as enforceable — Cursor usage API exposes
 * token usage, not reliable real-time dollar spend per worker.
 */

import type { CursorApiClient } from "../cursor/api-client.js";

/** Field name on POST /v1/agents create body. */
export const CURSOR_LIVE_MODEL_FIELD = "model.id";

/**
 * Default approved Cursor first-party/included-capacity worker model.
 * Validated against GET /v1/models when the API is available at live create time.
 * Do not assume inclusion solely from the name — allowlist is Radio policy.
 */
export const DEFAULT_APPROVED_CURSOR_WORKER_MODEL = "composer-2";

export type CursorWorkerModelClass =
  | "approved_cost_controlled"
  | "premium_requires_human"
  | "unknown";

export interface CursorWorkerModelPolicy {
  schemaVersion: "cursor-worker-model-1.0";
  /** Required explicit model id for live/fixture create. */
  defaultModelId: string;
  /** Allowlist of cost-controlled worker model ids. */
  approvedModelIds: string[];
  /** Premium / Other Model ids that require human authorization. */
  premiumModelIds: string[];
  /** When true, premium models may proceed after human authorization. */
  premiumModelHumanApproved: boolean;
  /**
   * When true (live HTTP), require model id to appear in GET /v1/models
   * (or aliases) before create. Fixture/mock clients skip discovery.
   */
  requireModelsEndpointValidation: boolean;
}

export interface CursorWorkerModelDecision {
  ok: boolean;
  code:
    | "ALLOW"
    | "MODEL_OMITTED"
    | "MODEL_NOT_APPROVED"
    | "PREMIUM_MODEL_REQUIRES_HUMAN"
    | "MODEL_NOT_IN_CURSOR_CATALOG"
    | "MODELS_ENDPOINT_UNAVAILABLE";
  modelId: string | null;
  modelClass: CursorWorkerModelClass;
  summary: string;
  humanApprovalRequired: boolean;
  /** Exact dollar budget enforcement is NOT supported by Cursor usage API. */
  exactDollarBudgetSupported: false;
}

export interface V1ModelInfo {
  id: string;
  displayName?: string;
  description?: string;
  aliases?: string[];
  parameters?: unknown[];
  variants?: unknown[];
}

export interface V1ModelsResponse {
  items: V1ModelInfo[];
}

export function resolveCursorWorkerModelPolicy(
  env: NodeJS.ProcessEnv = process.env,
): CursorWorkerModelPolicy {
  const defaultModelId =
    env.RADIO_CURSOR_WORKER_MODEL?.trim() ||
    DEFAULT_APPROVED_CURSOR_WORKER_MODEL;

  const approvedRaw =
    env.RADIO_CURSOR_APPROVED_MODELS?.trim() ||
    `${DEFAULT_APPROVED_CURSOR_WORKER_MODEL},composer-2.5,composer`;
  const approvedModelIds = uniqueNonEmpty(
    approvedRaw.split(",").map((s) => s.trim()),
  );
  if (!approvedModelIds.includes(defaultModelId)) {
    approvedModelIds.unshift(defaultModelId);
  }

  const premiumRaw =
    env.RADIO_CURSOR_PREMIUM_MODELS?.trim() ||
    [
      "claude-4.6-sonnet-thinking",
      "claude-4-sonnet-thinking",
      "claude-opus-4",
      "gpt-5",
      "gpt-5.1",
      "o3",
      "o4-mini",
    ].join(",");
  const premiumModelIds = uniqueNonEmpty(
    premiumRaw.split(",").map((s) => s.trim()),
  );

  const premiumModelHumanApproved =
    (env.RADIO_CURSOR_PREMIUM_MODEL_APPROVED ?? "false").toLowerCase() ===
    "true";

  const requireModelsEndpointValidation =
    (env.RADIO_CURSOR_REQUIRE_MODEL_CATALOG ?? "true").toLowerCase() !==
    "false";

  return {
    schemaVersion: "cursor-worker-model-1.0",
    defaultModelId,
    approvedModelIds,
    premiumModelIds,
    premiumModelHumanApproved,
    requireModelsEndpointValidation,
  };
}

function uniqueNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function classifyCursorWorkerModel(
  modelId: string | null | undefined,
  policy: CursorWorkerModelPolicy,
): CursorWorkerModelClass {
  if (!modelId || !modelId.trim()) return "unknown";
  const id = modelId.trim();
  if (policy.approvedModelIds.includes(id)) return "approved_cost_controlled";
  if (policy.premiumModelIds.includes(id)) return "premium_requires_human";
  // Unknown ids are treated as premium/unapproved — fail closed without human.
  return "premium_requires_human";
}

/**
 * Fail-closed evaluation BEFORE POST /v1/agents.
 * Omitted model → MODEL_OMITTED.
 * Unapproved/premium without human auth → PREMIUM_MODEL_REQUIRES_HUMAN.
 */
export function evaluateCursorWorkerModel(input: {
  modelId: string | null | undefined;
  policy: CursorWorkerModelPolicy;
  /** When omitted, policy.defaultModelId is used (still explicit). */
  allowPolicyDefault?: boolean;
}): CursorWorkerModelDecision {
  const exactDollarBudgetSupported = false as const;
  let modelId = input.modelId?.trim() || null;
  if (!modelId && input.allowPolicyDefault) {
    modelId = input.policy.defaultModelId;
  }
  if (!modelId) {
    return {
      ok: false,
      code: "MODEL_OMITTED",
      modelId: null,
      modelClass: "unknown",
      summary:
        "CURSOR_WORKER_MODEL_OMITTED: live Cursor create requires explicit model.id — implicit/default selection is forbidden",
      humanApprovalRequired: false,
      exactDollarBudgetSupported,
    };
  }

  const modelClass = classifyCursorWorkerModel(modelId, input.policy);
  if (modelClass === "approved_cost_controlled") {
    return {
      ok: true,
      code: "ALLOW",
      modelId,
      modelClass,
      summary: `Approved cost-controlled Cursor worker model ${modelId}`,
      humanApprovalRequired: false,
      exactDollarBudgetSupported,
    };
  }

  if (
    modelClass === "premium_requires_human" &&
    input.policy.premiumModelIds.includes(modelId) &&
    input.policy.premiumModelHumanApproved
  ) {
    return {
      ok: true,
      code: "ALLOW",
      modelId,
      modelClass,
      summary: `Premium Cursor worker model ${modelId} authorized by human approval`,
      humanApprovalRequired: false,
      exactDollarBudgetSupported,
    };
  }

  if (input.policy.premiumModelIds.includes(modelId)) {
    return {
      ok: false,
      code: "PREMIUM_MODEL_REQUIRES_HUMAN",
      modelId,
      modelClass,
      summary: `PREMIUM_MODEL_REQUIRES_HUMAN: model ${modelId} requires explicit human authorization before Cursor create`,
      humanApprovalRequired: true,
      exactDollarBudgetSupported,
    };
  }

  return {
    ok: false,
    code: "MODEL_NOT_APPROVED",
    modelId,
    modelClass,
    summary: `MODEL_NOT_APPROVED: model ${modelId} is not on the approved Cursor worker allowlist`,
    humanApprovalRequired: true,
    exactDollarBudgetSupported,
  };
}

/** Resolve aliases from catalog items. */
export function modelIdInCatalog(
  modelId: string,
  items: V1ModelInfo[],
): boolean {
  for (const item of items) {
    if (item.id === modelId) return true;
    if (item.aliases?.includes(modelId)) return true;
  }
  return false;
}

export async function validateModelAgainstCursorCatalog(input: {
  modelId: string;
  client: CursorApiClient;
  policy: CursorWorkerModelPolicy;
}): Promise<CursorWorkerModelDecision> {
  const base = evaluateCursorWorkerModel({
    modelId: input.modelId,
    policy: input.policy,
  });
  if (!base.ok) return base;
  if (!input.policy.requireModelsEndpointValidation) return base;
  if (typeof input.client.listModels !== "function") {
    // Fixture/test clients without listModels — skip catalog check.
    return base;
  }
  try {
    const catalog = await input.client.listModels();
    if (!modelIdInCatalog(input.modelId, catalog.items ?? [])) {
      return {
        ok: false,
        code: "MODEL_NOT_IN_CURSOR_CATALOG",
        modelId: input.modelId,
        modelClass: base.modelClass,
        summary: `MODEL_NOT_IN_CURSOR_CATALOG: ${input.modelId} was not returned by GET /v1/models`,
        humanApprovalRequired: false,
        exactDollarBudgetSupported: false,
      };
    }
    return base;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "MODELS_ENDPOINT_UNAVAILABLE",
      modelId: input.modelId,
      modelClass: base.modelClass,
      summary: `MODELS_ENDPOINT_UNAVAILABLE: cannot validate model against GET /v1/models (${message})`,
      humanApprovalRequired: false,
      exactDollarBudgetSupported: false,
    };
  }
}

export interface CursorUsageTelemetrySnapshot {
  schemaVersion: "cursor-usage-telemetry-1.0";
  objectiveId: string | null;
  agentId: string;
  runId: string;
  workerModel: string | null;
  capturedAt: string;
  phase: "before" | "after" | "terminal";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
  } | null;
  usageCaptureStatus: "captured" | "missing" | "skipped" | "error";
  /** Cursor usage API does not expose reliable real-time dollar spend. */
  exactDollarSpend: null;
  exactDollarBudgetSupported: false;
  runtimeMs: number | null;
  notes: string[];
}

export function buildUsageTelemetrySnapshot(input: {
  objectiveId: string | null;
  agentId: string;
  runId: string;
  workerModel: string | null;
  phase: CursorUsageTelemetrySnapshot["phase"];
  usage: CursorUsageTelemetrySnapshot["usage"];
  usageCaptureStatus: CursorUsageTelemetrySnapshot["usageCaptureStatus"];
  runtimeMs?: number | null;
  notes?: string[];
  capturedAt?: string;
}): CursorUsageTelemetrySnapshot {
  return {
    schemaVersion: "cursor-usage-telemetry-1.0",
    objectiveId: input.objectiveId,
    agentId: input.agentId,
    runId: input.runId,
    workerModel: input.workerModel,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    phase: input.phase,
    usage: input.usage,
    usageCaptureStatus: input.usageCaptureStatus,
    exactDollarSpend: null,
    exactDollarBudgetSupported: false,
    runtimeMs: input.runtimeMs ?? null,
    notes: input.notes ?? [],
  };
}

export function usageDeltaTokens(
  before: CursorUsageTelemetrySnapshot | null,
  after: CursorUsageTelemetrySnapshot | null,
): number | null {
  if (!before?.usage || !after?.usage) return null;
  return after.usage.totalTokens - before.usage.totalTokens;
}
