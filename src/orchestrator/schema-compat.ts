/**
 * Derive an OpenAI Structured Outputs–compatible JSON Schema from the
 * canonical decision schema WITHOUT mutating the canonical file.
 *
 * Transformations (documented for Phase 0):
 * 1. Strip unsupported keywords: uniqueItems, $schema, $id, title
 * 2. Convert `const` → single-value `enum`
 * 3. Leave `$defs` / `$ref` intact (supported by Responses API strict mode)
 * 4. Preserve `anyOf` nullable unions used by the decision contract
 *
 * The model response is ALWAYS re-validated against the original
 * canonical schemas/decision.schema.json after receipt.
 */

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
