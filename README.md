# Radio

Radio is a control-plane for autonomous software orchestration.

**The LLM reasons; Radio enforces.**

Human Product Owner → GPT-5.6 Sol (propose) → Radio policy (enforce) → Cursor factory (implement) → evidence back to Radio/Sol → human when judgment is required.

## Phase 0 architecture

Phase 0 is a dry-run vertical slice. It does **not** call Cursor.

```
project state
  → bounded Sol context
  → GPT-5.6 Sol structured decision
  → canonical schema validation
  → deterministic policy evaluation
  → Cursor work order (if ALLOW)
  → rendered Cursor prompt
  → STOP
```

Cursor execution is **not implemented** in Phase 0. Even if `CURSOR_EXECUTION_ENABLED=true`, there is no Cursor adapter capable of making an external Cursor call.

## Setup

```bash
npm install
```

Copy `.env.example` and set:

```bash
export OPENAI_API_KEY=...   # required only for the live Sol dry run
export RADIO_MODEL=gpt-5.6-sol   # optional
export CURSOR_EXECUTION_ENABLED=false
```

Do not commit secrets.

## Commands

```bash
# Deterministic unit/integration tests (no paid API calls)
npm test

# Full Phase 0 fixture dry run (checked-in Sol decision; no OpenAI call)
npm run pilot:bellhop:fixture

# Live Sol dry run (requires OPENAI_API_KEY)
npm run pilot:bellhop

# Typecheck / build
npm run typecheck
npm run build
```

## Bellhop Pilot 01

Canonical project brain:

- `projects/bellhop/`
- Radio doctrine/contracts: `docs/`
- Schemas: `schemas/`

`projects/cyber-assurance/` may exist in the repo but must not enter Bellhop Sol context, policy, work orders, or prompts.

Artifacts for each run are written under:

```
artifacts/runs/<run-id>/
  decision.json
  decision-envelope.json
  policy-evaluation.json
  work-order.json
  cursor-prompt.txt
  run-summary.json
```

## Decision fingerprint note

`decision.schema.json` has no fingerprint field. Phase 0 stores the request fingerprint on `decision-envelope.json` and policy compares that envelope fingerprint to the loaded authoritative state fingerprint. See `docs/PHASE0-DECISION-ENVELOPE.md`.

## Out of scope (Phase 0)

- Cursor API adapter / launch / polling
- Completion-report ingestion
- Project-state mutation loop
- Remediation, specialists, API Parent, merge, deploy
- UI, database, queue, vector DB
