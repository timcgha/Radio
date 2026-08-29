/**
 * Derive an OpenAI Structured Outputs–compatible JSON Schema from the
 * canonical decision schema WITHOUT mutating the canonical file.
 *
 * Transformations (documented for Phase 0):
 * 1. Strip unsupported keywords: uniqueItems, $schema, $id, title
 * 2. Convert `const` → single-value `enum`
 * 3. Leave `$defs` / `$ref` intact (supported by Responses API strict mode)
 * 4. Preserve `anyOf` nullable unions used by the decision contract
 * 5. Narrow stateTransition.from/to using current authoritative runtime state
 *    and the shared LEGAL_TRANSITIONS table (generation constraint only)
 *
 * The model response is ALWAYS re-validated against the original
 * canonical schemas/decision.schema.json after receipt.
 */

import {
  legalModelTransitionTargets,
} from "../policy/transitions.js";
import type { RuntimeState } from "../types.js";

const STRIP_KEYS = new Set([
  "$schema",
  "$id",
  "title",
  "uniqueItems",
  "examples",
  "default",
]);

export interface SchemaCompatResult {
  schema: Record<string, unknown>;
  transformations: string[];
}

export interface DeriveModelFacingSchemaOptions {
  currentRuntimeState: RuntimeState;
}

/**
 * OpenAI keyword compatibility only — does not authorize transitions.
 */
export function deriveOpenAiCompatibleDecisionSchema(
  canonical: Record<string, unknown>,
): SchemaCompatResult {
  const transformations: string[] = [
    "Removed $schema/$id/title/uniqueItems (OpenAI Structured Outputs unsupported or unnecessary)",
    "Converted const → enum[const] where present",
    "Canonical schemas/decision.schema.json remains authoritative for local Ajv validation",
  ];

  const schema = transformNode(canonical) as Record<string, unknown>;
  // OpenAI Responses API expects a root object schema without meta wrapper noise.
  delete schema.$schema;
  delete schema.$id;
  delete schema.title;

  return { schema, transformations };
}

/**
 * Full model-facing schema: OpenAI compatibility + request-specific transition narrowing.
 *
 * Narrowing is a generation constraint derived from the shared transition table.
 * It is NOT an authorization decision; policy still validates independently.
 */
export function deriveModelFacingDecisionSchema(
  canonical: Record<string, unknown>,
  options: DeriveModelFacingSchemaOptions,
): SchemaCompatResult {
  const { schema, transformations } =
    deriveOpenAiCompatibleDecisionSchema(canonical);

  const narrowNotes = narrowStateTransitionFields(
    schema,
    options.currentRuntimeState,
  );

  return {
    schema,
    transformations: [...transformations, ...narrowNotes],
  };
}

/**
 * Constrain stateTransition.from/to on a derived (mutable clone) schema.
 * Replaces $ref-backed runtimeState fields with request-specific enums.
 */
export function narrowStateTransitionFields(
  schema: Record<string, unknown>,
  currentRuntimeState: RuntimeState,
): string[] {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || typeof properties !== "object") {
    throw new Error(
      "Derived decision schema missing properties; cannot narrow stateTransition",
    );
  }

  const stateTransition = properties.stateTransition as
    | Record<string, unknown>
    | undefined;
  if (!stateTransition || typeof stateTransition !== "object") {
    throw new Error(
      "Derived decision schema missing stateTransition; cannot narrow transitions",
    );
  }

  const stProps = stateTransition.properties as
    | Record<string, unknown>
    | undefined;
  if (!stProps || typeof stProps !== "object") {
    throw new Error(
      "Derived decision schema stateTransition missing properties",
    );
  }

  const legalTo = legalModelTransitionTargets(currentRuntimeState);

  stProps.from = {
    type: "string",
    enum: [currentRuntimeState],
  };
  stProps.to = {
    type: "string",
    enum: legalTo,
  };

  return [
    `Narrowed stateTransition.from to current runtime state ${currentRuntimeState}`,
    `Narrowed stateTransition.to to legal targets from ${currentRuntimeState}: ${legalTo.join(", ")}`,
    "Transition narrowing is a Sol generation constraint; policy still enforces LEGAL_TRANSITIONS independently",
  ];
}

function transformNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(transformNode);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }

  const input = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (STRIP_KEYS.has(key)) continue;

    if (key === "const") {
      out.enum = [value];
      continue;
    }

    out[key] = transformNode(value);
  }

  return out;
}
