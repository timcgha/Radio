# Radio

Radio is a control-plane for autonomous software orchestration.

**The LLM reasons; Radio enforces.**

Human Product Owner → GPT-5.6 Sol (propose) → Radio policy (enforce) → Cursor factory (implement) → evidence back to Radio/Sol → human when judgment is required.

## Phase boundaries

```
PHASE 0:
  DECIDE → POLICY → WORK ORDER → STOP

PHASE 1:
  DECIDE → POLICY → WORK ORDER → TRANSMIT → WAIT
  → STORE RAW CURSOR RESULT → VERIFYING → STOP

PHASE 2 (future):
  semantic completion-report ingestion, validation,
  reconciliation, and continuation
```

A Cursor worker's self-reported PASS (for example
`BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST` inside raw result text)
is **not** accepted product truth during Phase 1. The final Cursor result is
untrusted external evidence. Radio Phase 1 stores it raw and stops at
`VERIFYING`.

Radio Phase 1 uses the **Cursor Cloud Agents API v1** (public beta): durable
agent + individual run. Legacy v0 is not the intended transport.

## Architecture sketch

```
project state
  → bounded Sol context
  → GPT-5.6 Sol structured decision
  → canonical schema validation
  → deterministic policy evaluation
  → Cursor work order (if ALLOW)
  → rendered Cursor prompt
  → [Phase 1] Cursor v1 transmitter (gated)
       create agent+run → poll exact run → store raw result/usage → VERIFYING
  → STOP (Phase 2 semantic ingestion is out of scope)
```

### Cursor execution gate

Live Cursor dispatch requires **both**:

- `CURSOR_API_KEY` present
- `CURSOR_EXECUTION_ENABLED=true`

The API key alone is **not** authorization to launch Cursor.
Default remains `CURSOR_EXECUTION_ENABLED=false`.

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

# Phase 1 fixture transmitter (mock Cursor v1 client; no network)
npm run pilot:bellhop:transmit:fixture

# Compatibility alias for the Phase 1 fixture
npm run pilot:bellhop:phase1-fixture

# Live Sol (+ live Cursor only if both execution gates are set)
npm run pilot:bellhop
npm run pilot:bellhop:transmit

# Typecheck / build
npm run typecheck
npm run build
```

No fixture command makes a real Cursor API request.

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
  cursor-dispatch-intent.json   # Phase 1 planned agent id
  cursor-create-response.json   # Phase 1 agent+run create
  cursor-run-final.json         # Phase 1 raw terminal run API payload
  cursor-result.txt             # Phase 1 raw result string (byte-for-byte)
  cursor-usage.json             # Phase 1 when usage available
  run-summary.json
```

Phase 1 fixture mode writes working state/ledger under the run directory and does not mutate checked-in `projects/bellhop/PROJECT-STATE.json`.

## Decision fingerprint note

`decision.schema.json` has no fingerprint field. Radio stores the request fingerprint on `decision-envelope.json` and policy compares that envelope fingerprint to the loaded authoritative state fingerprint. See `docs/PHASE0-DECISION-ENVELOPE.md`.

## Phase 1 scope

- Cursor Cloud Agents API **v1** adapter (`POST /v1/agents`, `GET` agent/run/usage)
- Client-supplied `agentId` (`bc-<uuid>`) idempotency + 409 reconciliation
- Durable agent + individual run identity
- Raw terminal result persistence (`cursor-result.txt`)
- Usage observability when available
- Stop at `VERIFYING` / `RADIO_PHASE1_RAW_RESULT_READY`

## Still out of scope (Phase 2+)

- Completion-report parse / schema validation / semantic ingestion
- `READY_FOR_HUMAN` / `pendingHumanDecision` from Cursor self-report
- Remediation, specialists, API Parent
- Merge / deploy / Stage 3
- UI, database, queue, vector DB
