# Radio

Radio is a control-plane for autonomous software orchestration.

**The LLM reasons; Radio enforces.**

Human Product Owner → GPT-5.6 Sol (propose) → Radio policy (enforce) → Cursor factory (implement) → evidence back to Radio/Sol → human when judgment is required.

## Phase boundaries

```
PHASE 0:
  DECIDE → POLICY → WORK ORDER → STOP

PHASE 1:
  TRANSMIT → WAIT → RAW RESULT → VERIFYING → STOP

PHASE 2:
  VALIDATE RESULT → RECONCILE → REVIEW
  → SOL NEXT DECISION → POLICY → STOP

PHASE 3 (future):
  EXECUTE / CONTINUE LOOP UNTIL HUMAN GATE
```

### Report validity ≠ work outcome

A **valid** completion report can describe a **BLOCKED** worker outcome
(for example `HALT_PRECHECK` / `BLOCKED_SOURCE_STATE` when expected SHA ≠
observed SHA). Radio validates the report deterministically; Sol then
reasons about the next legal orchestration action. Phase 2 does **not**
execute that action.

A Cursor worker's self-reported PASS (for example
`BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST` inside raw result text)
is **not** accepted product truth during Phase 1. Phase 1 stores raw
evidence and stops at `VERIFYING`. Phase 2 performs strict extraction,
canonical schema validation, identity binding, and evidence reconciliation
before any Sol continuation.

Radio uses the **Cursor Cloud Agents API v1** (public beta): durable
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
       preflight GET /v1/me → create agent+run
       → poll exact run → store raw result/usage → VERIFYING
  → [Phase 2] completion ingestion (no Cursor create)
       extract fenced report → schema validate → bind → reconcile
       → VERIFYING → REVIEWING → one Sol continuation → policy → STOP
```

### Live Cursor authorization (three-part gate)

Real live Cursor **create** dispatch requires **all three**:

1. Explicit live transmitter command: `npm run pilot:bellhop:transmit` (`--transmit`)
2. `CURSOR_EXECUTION_ENABLED=true`
3. `CURSOR_API_KEY` present

Phase 2 does **not** require `CURSOR_EXECUTION_ENABLED=true`. It never
creates workers. It may use `CURSOR_API_KEY` only for **read-only**
retrieval of an already completed run (`GET /v1/agents/{id}/runs/{runId}`).

### Fixture isolation

Fixture commands structurally forbid external Cursor create and use only
mock adapters / checked-in fixtures. They never mutate checked-in
`projects/bellhop/PROJECT-STATE.json`.

Phase 0/1 fixtures seed from `fixtures/state/bellhop-planning-seed.json`
(immutable PLANNING snapshot). Canonical `PROJECT-STATE.json` may reflect
live pilot progress (for example VERIFYING after Phase 1 transmit).

### Bellhop pilot source pin

The Bellhop Stage 2 pilot keeps the authoritative expected commit
`aa512d6ef721f855be33ddc36da490f9de66dc23` (short display `aa512d6`).

## Setup

```bash
npm install
```

Copy `.env.example` and set:

```bash
export OPENAI_API_KEY=...          # required only for live Sol
export RADIO_MODEL=gpt-5.6-sol     # optional
export CURSOR_API_KEY=...          # live Cursor create OR Phase 2 read-only replay
export CURSOR_EXECUTION_ENABLED=false
```

Do not commit secrets. Do not enable `CURSOR_EXECUTION_ENABLED` without explicit human authorization.

## Commands

```bash
# Deterministic unit/integration tests (no paid API calls)
npm test

# Phase 0 dry-run / Sol fixture — NEVER transmits
npm run pilot:bellhop:fixture

# Phase 1 fixture transmitter (mock Cursor v1 client; NEVER live HTTP)
npm run pilot:bellhop:transmit:fixture

# Phase 2 fixture (blocked-source report → next action ready; no OpenAI/Cursor create)
npm run pilot:bellhop:phase2:fixture

# Phase 0 / live Sol path — NEVER transmits without --transmit
npm run pilot:bellhop

# Real live Cursor transport path (still requires env gates above)
npm run pilot:bellhop:transmit

# Real Phase 2 continuation (Sol + optional read-only Cursor GET; NEVER create)
# Do not run in this implementation transaction without explicit authorization.
npm run pilot:bellhop:phase2

# Typecheck / build
npm run typecheck
npm run build
```

| Command | Can live-dispatch Cursor create? |
|---|---|
| `pilot:bellhop` | No |
| `pilot:bellhop:fixture` | No |
| `pilot:bellhop:transmit:fixture` | No (mock only) |
| `pilot:bellhop:phase2:fixture` | No |
| `pilot:bellhop:phase2` | No (read-only GET only) |
| `pilot:bellhop:transmit` | Only if `CURSOR_EXECUTION_ENABLED=true` **and** `CURSOR_API_KEY` present |

## Bellhop Pilot 01

Canonical project brain:

- `projects/bellhop/`
- Radio doctrine/contracts: `docs/`
- Schemas: `schemas/`

`projects/cyber-assurance/` may exist in the repo but must not enter Bellhop Sol context, policy, work orders, prompts, or Phase 2 continuation context.

Artifacts for each run are written under `artifacts/runs/<run-id>/`.

Phase 2 artifacts include (among others):

```
raw-cursor-result.txt
completion-report.json
completion-validation.json
completion-reconciliation.json
continuation-context.json
next-decision.json
next-decision-envelope.json
next-policy-evaluation.json
phase2-summary.json
completed-agent-snapshot.json
```

## Decision fingerprint note

`decision.schema.json` has no fingerprint field. Radio stores the request fingerprint on `decision-envelope.json` and policy compares that envelope fingerprint to the loaded authoritative state fingerprint. See `docs/PHASE0-DECISION-ENVELOPE.md`.

## Phase 2 scope

- Strict fenced-`text` completion-report extraction
- Canonical `cursor-completion-report.schema.json` validation
- Work-order / agent / source identity binding
- Deterministic evidence reconciliation
- `VERIFYING` → `REVIEWING` (+ transaction status reconciliation)
- Exactly one bounded GPT-5.6 Sol continuation decision
- Deterministic policy evaluation of the next decision
- Stop with `RADIO_PHASE2_NEXT_ACTION_READY` (or fail-closed terminals)
- Optional read-only replay of completed Cursor runs

## Still out of scope (Phase 3+)

- Executing the next decision / autonomous loop
- Creating Cursor workers from Phase 2
- Remediation, specialists, API Parent
- Merge / deploy / Stage 3
- Failure Controller
- Durable state backend beyond git-persisted `PROJECT-STATE.json` (pilot-acceptable; not long-term architecture)
- UI, database, queue, vector DB
