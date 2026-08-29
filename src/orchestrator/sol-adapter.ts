import fs from "node:fs";
import OpenAI from "openai";
import type {
  OrchestratorDecision,
  RuntimeState,
  SolContext,
} from "../types.js";
import { loadSchema, newId, nowIso, readJsonFile } from "../util/io.js";
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

  // Prefer Responses API with Structured Outputs + high reasoning effort.
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

  // Ensure identity fields match the request even if the model drifts.
  const withIds = ensureIdentity(parsed, options);

  // Canonical schema remains authoritative.
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

function loadFixtureDecision(options: CallSolOptions): SolCallResult {
  if (!options.fixturePath) {
    throw new Error("fixturePath is required in fixture mode");
  }
  if (!fs.existsSync(options.fixturePath)) {
    throw new Error(`Fixture not found: ${options.fixturePath}`);
  }

  const parsed = readJsonFile<unknown>(options.fixturePath);
  const withIds = ensureIdentity(parsed, {
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
