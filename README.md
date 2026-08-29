# Radio

Radio is a control-plane for autonomous software orchestration.

**The LLM reasons; Radio enforces.**

Human Product Owner → GPT-5.6 Sol (propose) → Radio policy (enforce) → Cursor factory (implement) → evidence back to Radio/Sol → human when judgment is required.

## Phase 0 / Phase 1 architecture

```
project state
  → bounded Sol context
  → GPT-5.6 Sol structured decision
  → canonical schema validation
  → deterministic policy evaluation
  → Cursor work order (if ALLOW)
  → rendered Cursor prompt
  → [Phase 1] Cursor transmitter (gated)
       launch → poll → ingest completion report → validate → update state/ledger
  → stop at human boundary when required
```

### Cursor execution gate

Live Cursor dispatch requires **both**:

- `CURSOR_API_KEY` present
- `CURSOR_EXECUTION_ENABLED=true`

The API key alone is **not** authorization to launch Cursor.

## Setup

```bash
npm install
```

Copy `.env.example` and set:

```bash
export OPENAI_API_KEY=...          # required only for live Sol
export RADIO_MODEL=gpt-5.6-sol     # optional
export CURSOR_API_KEY=...          # required only for live Cursor dispatch
export CURSOR_EXECUTION_ENABLED=false
```

Do not commit secrets. Do not enable `CURSOR_EXECUTION_ENABLED` without explicit human authorization.

## Commands

```bash
# Deterministic unit/integration tests (no paid API calls)
npm test

# Phase 0 fixture dry run (checked-in Sol decision; no Cursor call)
npm run pilot:bellhop:fixture

# Phase 1 fixture transmitter (mock Cursor client; no network)
npm run pilot:bellhop:phase1-fixture

# Live Sol (+ live Cursor only if both execution gates are set)
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
  completion-report.json          # Phase 1 when transmitted
  completion-validation.json      # Phase 1
  cursor-conversation.json        # Phase 1
  run-summary.json
```

Phase 1 fixture mode writes working state/ledger under the run directory and does not mutate checked-in `projects/bellhop/PROJECT-STATE.json`.

## Decision fingerprint note

`decision.schema.json` has no fingerprint field. Radio stores the request fingerprint on `decision-envelope.json` and policy compares that envelope fingerprint to the loaded authoritative state fingerprint. See `docs/PHASE0-DECISION-ENVELOPE.md`.

## Phase 1 scope

- Cursor Cloud Agents API adapter (v0 launch/status/conversation)
- Idempotent launch via run ledger
- Completion-report parse + schema validation
- Project-state mutation + append-only ledger after validated completion

## Still out of scope

- Remediation, specialists, API Parent
- Merge / deploy / Stage 3
- UI, database, queue, vector DB
