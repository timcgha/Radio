import fs from "node:fs";
import OpenAI from "openai";
import type {
  OrchestratorDecision,
  RuntimeState,
  SolContext,
  SolPhase2Assessment,
  SolPhase2Continuation,
} from "../types.js";
import {
  formatAjvErrors,
  getSchemaValidator,
  loadSchema,
  newId,
  nowIso,
  readJsonFile,
} from "../util/io.js";
import { validateDecision } from "./decision-validator.js";
import { deriveModelFacingDecisionSchema } from "./schema-compat.js";

export interface SolCallResult {
  decision: OrchestratorDecision;
  model: string;
  mode: "live" | "fixture";
  requestId: string | null;
  rawText: string;
  schemaCompatNotes: string[];
  usage: unknown;
}

export interface SolPhase2CallResult extends SolCallResult {
  assessment: SolPhase2Assessment;
  continuation: SolPhase2Continuation;
}

export interface CallSolOptions {
  context: SolContext;
  projectId: string;
  workstreamId: string;
  transactionId: string;
  /** Authoritative radioRuntime.state used to narrow model-facing transition enums. */
  currentRuntimeState: RuntimeState;
  model: string;
  mode: "live" | "fixture";
  fixturePath?: string;
  apiKey?: string;
}

/**
 * Call GPT-5.6 Sol via OpenAI Responses API with Structured Outputs,
 * or load a checked-in fixture in fixture mode.
 * Phase 0/1 path — returns a canonical Orchestrator Decision only.
 */
export async function callSol(options: CallSolOptions): Promise<SolCallResult> {
  if (options.mode === "fixture") {
    return loadFixtureDecision(options);
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for npm run pilot:bellhop. " +
        "Set the environment variable to run the live Sol dry run. " +
        "Use npm run pilot:bellhop:fixture for offline deterministic execution.",
    );
  }

  const canonical = loadSchema("decision.schema.json") as Record<string, unknown>;
  const { schema: modelFacingSchema, transformations } =
    deriveModelFacingDecisionSchema(canonical, {
      currentRuntimeState: options.currentRuntimeState,
    });

  const client = new OpenAI({ apiKey });
  const model = options.model;

  const response = await client.responses.create({
    model,
    store: false,
    reasoning: { effort: "high" },
    input: [
      { role: "system", content: options.context.system },
      { role: "user", content: options.context.user },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "radio_orchestrator_decision",
        strict: true,
        schema: modelFacingSchema,
      },
    },
  } as Parameters<typeof client.responses.create>[0]);

  const rawText = extractResponseText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Sol response was not valid JSON: ${(err as Error).message}`,
    );
  }

  const withIds = ensureIdentity(parsed, options);
  const decision = validateDecision(withIds);

  return {
    decision,
    model,
    mode: "live",
    requestId: (response as { id?: string }).id ?? null,
    rawText,
    schemaCompatNotes: transformations,
    usage: (response as { usage?: unknown }).usage ?? null,
  };
}

/**
 * Phase 2: exactly one Sol call that interprets untrusted worker evidence
 * AND proposes the next canonical orchestration decision.
 */
export async function callSolPhase2Continuation(
  options: CallSolOptions,
): Promise<SolPhase2CallResult> {
  if (options.mode === "fixture") {
    return loadFixturePhase2Continuation(options);
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for live Phase 2 Sol continuation. " +
        "Use npm run pilot:bellhop:phase2:fixture for offline deterministic execution.",
    );
  }

  const modelFacingSchema = buildPhase2ModelFacingSchema(
    options.currentRuntimeState,
  );
  const client = new OpenAI({ apiKey });

  const response = await client.responses.create({
    model: options.model,
    store: false,
    reasoning: { effort: "high" },
    input: [
      { role: "system", content: options.context.system },
      { role: "user", content: options.context.user },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "radio_phase2_sol_continuation",
        strict: true,
        schema: modelFacingSchema.schema,
      },
    },
  } as Parameters<typeof client.responses.create>[0]);

  const rawText = extractResponseText(response);
  return finalizePhase2Continuation(rawText, options, {
    mode: "live",
    requestId: (response as { id?: string }).id ?? null,
    schemaCompatNotes: modelFacingSchema.transformations,
    usage: (response as { usage?: unknown }).usage ?? null,
  });
}

function loadFixtureDecision(options: CallSolOptions): SolCallResult {
  if (!options.fixturePath) {
    throw new Error("fixturePath is required in fixture mode");
  }
  if (!fs.existsSync(options.fixturePath)) {
    throw new Error(`Fixture not found: ${options.fixturePath}`);
  }

  const parsed = readJsonFile<unknown>(options.fixturePath);
  // Allow Phase 2-shaped fixtures when callers reuse them for decision-only paths.
  const decisionRaw = unwrapDecision(parsed);
  const withIds = ensureIdentity(decisionRaw, {
    ...options,
    forceFreshTimestamps: true,
  });
  const decision = validateDecision(withIds);

  return {
    decision,
    model: options.model,
    mode: "fixture",
    requestId: null,
    rawText: JSON.stringify(parsed, null, 2),
    schemaCompatNotes: [
      "Fixture mode: no OpenAI API call; canonical Ajv validation still applied",
    ],
    usage: null,
  };
}

function loadFixturePhase2Continuation(
  options: CallSolOptions,
): SolPhase2CallResult {
  if (!options.fixturePath) {
    throw new Error("fixturePath is required in fixture mode");
  }
  if (!fs.existsSync(options.fixturePath)) {
    throw new Error(`Fixture not found: ${options.fixturePath}`);
  }
  const parsed = readJsonFile<unknown>(options.fixturePath);
  const rawText = JSON.stringify(parsed, null, 2);
  return finalizePhase2Continuation(rawText, options, {
    mode: "fixture",
    requestId: null,
    schemaCompatNotes: [
      "Fixture mode: no OpenAI API call; Phase 2 continuation + decision Ajv validation applied",
    ],
    usage: null,
  });
}

function finalizePhase2Continuation(
  rawText: string,
  options: CallSolOptions,
  meta: {
    mode: "live" | "fixture";
    requestId: string | null;
    schemaCompatNotes: string[];
    usage: unknown;
  },
): SolPhase2CallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Sol Phase 2 continuation was not valid JSON: ${(err as Error).message}`,
    );
  }

  // Accept legacy decision-only fixtures by wrapping with a diagnostic assessment.
  if (
    parsed &&
    typeof parsed === "object" &&
    !("assessment" in (parsed as object)) &&
    "decision" in (parsed as object) === false &&
    "decisionId" in (parsed as object)
  ) {
    parsed = {
      assessment: {
        resultClass: "UNKNOWN",
        confidence: "LOW",
        summary:
          "Legacy decision-only fixture wrapped for Phase 2 continuation path.",
        materialFindings: [],
        sourceIntegrityAssessment: "Not assessed in legacy fixture wrapper.",
        requiresHumanJudgment: true,
        structuredWorkerReportStatus: "UNAVAILABLE_OR_INVALID",
      },
      decision: parsed,
    };
  }

  // If fixture is { assessment, decision } — validate wrapper then decision.
  // If fixture mistakenly nests only decision at top with assessment — ok.
  if (
    parsed &&
    typeof parsed === "object" &&
    "decision" in (parsed as object) === false &&
    "decisionId" in (parsed as object)
  ) {
    parsed = {
      assessment: defaultUnknownAssessment(),
      decision: parsed,
    };
  }

  const validateContinuation = getSchemaValidator(
    "sol-phase2-continuation.schema.json",
  );
  if (!validateContinuation(parsed)) {
    throw new Error(
      `Sol Phase 2 continuation schema validation failed: ${formatAjvErrors(validateContinuation.errors)}`,
    );
  }

  const continuation = parsed as {
    assessment: SolPhase2Assessment;
    decision: unknown;
  };

  const withIds = ensureIdentity(continuation.decision, {
    ...options,
    forceFreshTimestamps: options.mode === "fixture",
  });
  const decision = validateDecision(withIds);

  const full: SolPhase2Continuation = {
    assessment: continuation.assessment,
    decision,
  };

  return {
    assessment: continuation.assessment,
    decision,
    continuation: full,
    model: options.model,
    mode: meta.mode,
    requestId: meta.requestId,
    rawText,
    schemaCompatNotes: meta.schemaCompatNotes,
    usage: meta.usage,
  };
}

function unwrapDecision(parsed: unknown): unknown {
  if (
    parsed &&
    typeof parsed === "object" &&
    "decision" in (parsed as object) &&
    (parsed as { decision: unknown }).decision &&
    typeof (parsed as { decision: unknown }).decision === "object"
  ) {
    return (parsed as { decision: unknown }).decision;
  }
  return parsed;
}

function defaultUnknownAssessment(): SolPhase2Assessment {
  return {
    resultClass: "UNKNOWN",
    confidence: "LOW",
    summary: "Assessment unavailable in fixture wrapper.",
    materialFindings: [],
    sourceIntegrityAssessment: "Not assessed.",
    requiresHumanJudgment: true,
    structuredWorkerReportStatus: "UNAVAILABLE_OR_INVALID",
  };
}

function buildPhase2ModelFacingSchema(currentRuntimeState: RuntimeState): {
  schema: Record<string, unknown>;
  transformations: string[];
} {
  const continuationCanonical = loadSchema(
    "sol-phase2-continuation.schema.json",
  ) as Record<string, unknown>;
  const decisionCanonical = loadSchema("decision.schema.json") as Record<
    string,
    unknown
  >;
  const { schema: decisionSchema, transformations } =
    deriveModelFacingDecisionSchema(decisionCanonical, {
      currentRuntimeState,
    });

  const properties = {
    ...(continuationCanonical.properties as Record<string, unknown>),
  };
  properties.decision = decisionSchema;

  // Merge $defs from decision schema for $ref resolution inside nested decision.
  const decisionDefs = (decisionSchema.$defs ?? {}) as Record<string, unknown>;
  const schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["assessment", "decision"],
    properties,
    $defs: decisionDefs,
  };

  return {
    schema,
    transformations: [
      ...transformations,
      "Phase 2 model-facing schema nests assessment + derived decision schema",
      "Canonical sol-phase2-continuation.schema.json + decision.schema.json remain authoritative locally",
    ],
  };
}

function ensureIdentity(
  parsed: unknown,
  options: CallSolOptions & { forceFreshTimestamps?: boolean },
): unknown {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Sol decision must be an object");
  }
  const obj = { ...(parsed as Record<string, unknown>) };
  obj.projectId = options.projectId;
  obj.workstreamId = options.workstreamId;
  obj.transactionId = options.transactionId;
  if (!obj.decisionId || typeof obj.decisionId !== "string") {
    obj.decisionId = newId("dec");
  }
  if (
    options.forceFreshTimestamps ||
    !obj.generatedAt ||
    typeof obj.generatedAt !== "string"
  ) {
    obj.generatedAt = nowIso();
  }
  return obj;
}

function extractResponseText(response: unknown): string {
  const r = response as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  if (typeof r.output_text === "string" && r.output_text.trim()) {
    return r.output_text;
  }

  const chunks: string[] = [];
  for (const item of r.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") {
        chunks.push(c.text);
      }
      if (c.type === "text" && typeof c.text === "string") {
        chunks.push(c.text);
      }
    }
  }
  if (chunks.length === 0) {
    throw new Error("Sol Responses API returned no text output");
  }
  return chunks.join("");
}
