# Phase 0 OpenAI Structured Outputs compatibility

Canonical schema: `schemas/decision.schema.json` (unchanged).

When calling the OpenAI Responses API, Radio derives a model-compatible schema in code via `src/orchestrator/schema-compat.ts`.

## Pipeline

```text
canonical decision.schema.json
        ↓
derive OpenAI-compatible schema (keyword transforms)
        ↓
narrow stateTransition.from/to using current authoritative runtime state
        ↓
GPT-5.6 Sol Structured Output
        ↓
canonical Ajv validation (decision.schema.json)
        ↓
deterministic policy validation (LEGAL_TRANSITIONS)
```

## Transformations

1. Strip `$schema`, `$id`, `title`, `uniqueItems` (unsupported or unnecessary for Structured Outputs).
2. Convert `const` → single-value `enum`.
3. Preserve `$defs` / `$ref` and nullable `anyOf` unions from the canonical contract.
4. **Request-specific transition narrowing:** replace `stateTransition.from` / `stateTransition.to` `$ref`s with enums derived from:
   - `from` = current `radioRuntime.state`
   - `to` = `legalModelTransitionTargets(current)` from `src/policy/transitions.ts`

Narrowing is a **generation constraint**, not an authorization decision. Policy still rejects illegal edges independently. The shared `LEGAL_TRANSITIONS` table remains the single source of runtime transition truth.

## Authority

The model response is always re-validated with Ajv against the **original** canonical `decision.schema.json`. Local canonical validation remains authoritative. Policy independently enforces P7 transition legality.
