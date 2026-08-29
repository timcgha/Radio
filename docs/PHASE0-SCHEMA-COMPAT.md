# Phase 0 OpenAI Structured Outputs compatibility

Canonical schema: `schemas/decision.schema.json` (unchanged).

When calling the OpenAI Responses API, Radio derives a model-compatible schema in code via `src/orchestrator/schema-compat.ts`.

## Transformations

1. Strip `$schema`, `$id`, `title`, `uniqueItems` (unsupported or unnecessary for Structured Outputs).
2. Convert `const` → single-value `enum`.
3. Preserve `$defs` / `$ref` and nullable `anyOf` unions from the canonical contract.

## Authority

The model response is always re-validated with Ajv against the **original** canonical `decision.schema.json`. Local canonical validation remains authoritative.
