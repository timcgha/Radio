# Radio

Radio is a control-plane for autonomous software orchestration.

**The LLM reasons; Radio enforces.**

Human Product Owner → GPT-5.6 Sol (propose) → Radio policy (enforce) → Cursor factory (implement) → evidence back to Radio/Sol → human when judgment is required.

**The objective is the unit of work; agent sessions are implementation details.**

**Failures are normal loop outcomes**, not exceptions that require a parallel control plane.

## Phase boundaries

```
PHASE 0:
  DECIDE → POLICY → WORK ORDER → STOP

PHASE 1:
  TRANSMIT → WAIT → RAW RESULT → VERIFYING → STOP

PHASE 2:
  TRUSTED EXECUTION ENVELOPE
  + UNTRUSTED WORKER EVIDENCE
  → SOL INTERPRETS + DECIDES
  → RADIO VALIDATES DECISION
  → POLICY
  → STOP

PHASE 3:
  REPEAT EXECUTE / OBSERVE / DECIDE
  UNTIL TERMINAL OR HUMAN GATE
```

### Trust boundary

- **Trusted Radio facts** (identity, state, budgets, approvals, legal transitions)
  are authoritative and must not be inferred from worker prose.
- **Untrusted worker evidence** (raw Cursor output, optional structured report)
  is DATA for Sol to interpret — never authority.
- Worker structured JSON is preferred but **not required** for semantic review.
- Sol assessment is **model judgment**, not deterministic truth.
- Radio does not trust Sol to grant itself authority.
- Deterministic checks surround execution identity, state, and policy — not
  natural-language comprehension of worker prose.
- Phase 3 objective authority is explicit, single-purpose, scoped, consumable,
  and auditable. Prior approvals (including Stage 2 ACCEPTED) do **not**
  authorize later unrelated actions or Bellhop Stage 3.

### Report validity ≠ work outcome

A **valid** completion report can describe a **BLOCKED** worker outcome
(for example `HALT_PRECHECK` / `BLOCKED_SOURCE_STATE` when expected SHA ≠
observed SHA). Structured report format failure alone is diagnostic — Sol
still receives the exact raw result as untrusted evidence and may propose
the next legal action. Phase 2 does **not** execute that action.

A Cursor worker's self-reported PASS is **not** accepted product truth during
Phase 1. Phase 1 stores raw evidence and stops at `VERIFYING`.

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

# Phase 2 fixture (schema-invalid worker JSON → Sol interpret+decide → policy → stop)
npm run pilot:bellhop:phase2:fixture

# Phase 3 fixture autonomous loop (≥2 iterations, mocks only; no live APIs)
npm run pilot:bellhop:phase3:fixture

# Phase 0 / live Sol path — NEVER transmits without --transmit
npm run pilot:bellhop

# Real live Cursor transport path (still requires env gates above)
npm run pilot:bellhop:transmit

# Real Phase 2 continuation (Sol + optional read-only Cursor GET; NEVER create)
# Do not run in this implementation transaction without explicit authorization.
npm run pilot:bellhop:phase2

# Real Phase 3 entrypoint (requires explicit objective authority; does NOT
# infer Stage 3 from Stage 2 ACCEPTED). Do not execute without a separate
# human-authorized objective envelope.
npm run pilot:bellhop:phase3

# Cyber Assurance strict Phase 3 fixture (mock Sol/Cursor; no live side effects)
npm run pilot:cyber-assurance:phase3:fixture

# Cyber Assurance strict Phase 3 live entrypoint (requires --objective-authority,
# git-remote-ref lease, and real initial Sol — do not run without authorization)
npm run pilot:cyber-assurance:phase3 -- --objective-authority <path>

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
| `pilot:bellhop:phase3:fixture` | No (mock only) |
| `pilot:bellhop:phase3` | Only when explicit objective authority + execution gates pass |
| `pilot:cyber-assurance:phase3:fixture` | No (mock only) |
| `pilot:cyber-assurance:phase3` | Only when explicit objective authority + git-remote-ref lease + execution gates pass |
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

- Verify trusted Radio execution envelope (identity, terminal run, raw result)
- Acquire exact raw Cursor result as untrusted evidence
- Optional best-effort structured-report diagnostics (non-blocking)
- `VERIFYING` → `REVIEWING` after envelope + raw acquisition (schema-valid
  worker report not required)
- Exactly one bounded GPT-5.6 Sol interpret + next-decision call
- Validate Sol continuation schema, then independently validate
  `decision` against `decision.schema.json`
- Deterministic policy evaluation of the next decision
- Stop with `RADIO_PHASE2_NEXT_ACTION_READY` (or fail-closed terminals)
- Optional read-only replay of completed Cursor runs
- Live mode selects execution via `RADIO_PHASE2_CURSOR_AGENT_ID` /
  `RADIO_PHASE2_CURSOR_RUN_ID` and/or Radio-owned state — never historical
  fixture defaults

Legacy `pilot:bellhop:recover-invalid-report` remains a narrow human
control-plane recovery (`VERIFYING` → `PLANNING`) for audit/history. Under
simplified Phase 2, worker report format invalidity alone does not require
that recovery when Radio already has a completed worker + raw result.

## Phase 3 scope

Phase 3 is a **thin loop** around Phases 0–2:

```
OBJECTIVE / CURRENT NEXT ACTION
→ EXECUTE ONE POLICY-AUTHORIZED ACTION (Phase 1 transmitter)
→ OBSERVE RESULT (Phase 2 envelope + raw evidence)
→ SOL INTERPRETS + DECIDES (Phase 2 continuation)
→ POLICY + OBJECTIVE AUTHORITY + BUDGETS
→ IF LEGALLY EXECUTABLE AND WITHIN BUDGET: REPEAT
→ ELSE: STOP (human gate / blocker / completion / budget)
```

- Objective authority envelope constrains project/workstream, work types,
  prohibited scope, maxIterations, maxCursorAgents, maxRetriesPerLogicalStep
- One active workstream; one active logical execution at a time
- Logical retry ≠ transport reconciliation (idempotent same-agent resume)
- Failures (FAIL/BLOCKED/…) are normal Sol-interpretable outcomes
- Human attention reserved for genuine judgment — not worker formatting noise
- Fixture command: `npm run pilot:bellhop:phase3:fixture` → preferred terminal
  `RADIO_PHASE3_AUTONOMOUS_LOOP_READY`
- Does **not** authorize Bellhop Stage 3, PR merge, deploy, or product edits

### Cyber Assurance strict Phase 3 live entry

For production/live Cyber Assurance execution, the supervisory agent **must**
invoke the strict Radio entrypoint:

```bash
npm run pilot:cyber-assurance:phase3 -- --objective-authority <path>
```

Execution invariants (fail closed):

- **ObjectiveAuthority** is authoritative for `baseBranch` and
  `expectedStartingSha` — do not hardcode product SHAs into Radio code.
- **git-remote-ref** objective lease is mandatory (`refs/radio-objective-leases/<objective-id>` on the Radio repository). Memory lease fallback is rejected for this live entrypoint.
- **Real initial Sol** decision is mandatory — `initialDecision` injection is rejected.
- Target workers are created **only** through Radio's transmitter path
  (`buildCursorWorkOrder` → `renderCursorPrompt` → `transmitCursorWorkOrder` →
  `buildCreateAgentRequest` → Cursor API client).

The supervisory agent must **not**:

- manually clone the target product repository into the Radio workspace;
- construct target work in the Radio workspace;
- use `RADIO_GITHUB_TOKEN` to operate on target product repositories;
- imitate objective leases with shell git commands;
- create implementation workers outside the Radio transmitter.

`RADIO_GITHUB_TOKEN` remains read-only source verification for authorized GitHub HTTPS remotes only. It must not be passed to workers, worker prompts, Cursor create payloads, lease writes, or product git push operations.

## Still out of scope (backlog)

- Vector-store / file_search Sol memory
- previous_response_id transaction memory / prompt caching
- Durable SQLite/Postgres runtime backend
- Native/mobile Radio UI / browser dashboard
- Arbitrary multi-worker orchestration / specialist swarms
- Automatic merge/deploy
- Sophisticated Failure Controller
- Periodic architecture gardening / repo-doc freshness agents
