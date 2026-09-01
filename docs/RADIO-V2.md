# Radio v2 — Thin Zero-Relay Orchestrator

Radio v1 proved valuable controls but failed operational acceptance twice on orchestration plumbing: structured completion-report schema conformance, then comparing `expectedBaseTipSha` against post-implementation `branchTipSha` as a source-pin contradiction.

Radio v2 removes that protocol/state coupling from the critical execution loop.

> **Worker output is evidence, not Radio state.**

> **Starting SHA and implementation tip are different identities.**

## Why v2 exists

v1 capabilities worth keeping:

- Exact source SHA verification
- Project/repository binding
- Cursor HTTP integration
- Sol integration
- Remote Git verification
- Executable/evidence ancestry checks
- Fail-closed policy
- Genuine human gates

v2 drops fragile worker protocol requirements from the continuation path.

## Five-stage loop

```
PLAN → WORK → VERIFY → DECIDE → DONE | HUMAN | FAILED
                              ↘ WORK (bounded retry)
```

| Stage | Radio does |
|-------|------------|
| **PLAN** | Resolve and pin starting source (`resolvedBaseSha == expectedStartingSha`) |
| **WORK** | Launch one repository-bound Cursor worker (≤ `maxWorkerRuns`) |
| **VERIFY** | Derive deterministic Git facts independently |
| **DECIDE** | Send verified facts + worker narrative to Sol; enforce hard gates |

Terminal outcomes: `DONE`, `HUMAN`, `FAILED_MACHINE`, `FAILED_POLICY`.

## What Radio verifies

Radio independently derives:

- Repository identity and binding
- Remote base SHA at start
- Worker branch existence
- Remote implementation tip SHA
- `startingSha` ancestry to `implementationTipSha`
- Changed files from Git diff
- Fresh commit (`startingSha != implementationTipSha`)
- Publication availability

Radio does **not** falsely claim independent test verification unless a stable API provides exit codes.

## What remains worker-reported

- Test/build narrative
- Product-behavior claims
- Ordinary prose evidence

Stored separately as `workerNarrative` / `workerReported` — never overwriting `verifiedFacts`.

## Sol role

After VERIFY, Sol receives a compact decision packet and chooses one action:

- `ACCEPT`
- `CONTINUE_WORK`
- `VERIFY_MORE`
- `ASK_HUMAN`
- `FAIL`

Sol recommends; Radio enforces deterministic hard gates before `DONE`.

## Hard gates (publication-required work)

- Correct repository
- Correct starting source
- Authorized work types in objective
- Remote implementation branch exists
- Fresh implementation tip
- `isAncestor(startingSha, implementationTipSha)`
- No unresolved contradictions
- Sol recommends `ACCEPT`

## Human gates

Human involvement is for real judgment only:

- Product behavior change outside scope
- Merge / production deploy approval
- Policy-required review
- Ambiguous requirements

**Not** for JSON formatting, enum mismatch, or report-repair loops.

## maxWorkerRuns

Default: **2**. Configurable per objective. Same-agent follow-up counts as one run (simplest semantics). Exceeding the limit yields `FAILED_POLICY` or `HUMAN` — never silent overrun.

## Run artifacts

One directory per run:

```
objective.json
plan.json
worker-request.txt
worker-result.txt
verified-facts.json
decision.json
summary.json
run-state.json
iterations/01/ ...
```

## CLI

Start a new run:

```bash
npm run radio:v2 -- --objective path/to/objective.json [--run-dir dir]
```

Resume an interrupted run:

```bash
npm run radio:v2 -- --resume path/to/run-dir
```

The CLI constructs production adapters (Sol, Cursor, Git verification, project binding) and executes `runV2Loop` / `resumeV2Loop` directly. No programmatic injection is required for operators.

### Required environment

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Sol live decisions |
| `CURSOR_API_KEY` | Cursor worker create/observe |
| `CURSOR_EXECUTION_ENABLED=true` | Authorize live Cursor dispatch |

Optional:

| Variable | Purpose |
|----------|---------|
| `RADIO_MODEL` | Sol model (default `gpt-5.6-sol`) |
| `RADIO_CURSOR_ENV_BELLHOP` | Cursor Cloud environment for Bellhop workers |
| `CURSOR_API_BASE_URL` | Cursor API base (default `https://api.cursor.com`) |

### Terminal states

`DONE`, `HUMAN`, `FAILED_MACHINE`, `FAILED_POLICY` — printed with `runDir=` and summary counters on exit.

### Resume behavior

- **Active worker**: if `run-state.json` has `activeWorker`, resume observes that agent/run (no duplicate create).
- **Post-result**: if iteration worker result is persisted, resume continues at VERIFY → DECIDE.
- **Post-verify**: if verified facts exist, resume continues at DECIDE (may re-query read-only Git).

v1 entrypoints are unchanged. v2 is a separate module (`src/v2/`).

## Live acceptance criterion

After merge and independent review:

1. Run **3 consecutive** small live Bellhop objectives.
2. Each requires: one human launch, zero manual relay, correct binding, source pin verified, worker created by Radio, work performed, branch pushed, Git provenance verified by Radio, Sol continuation automatic, no schema-repair stop.
3. Any plumbing failure resets the streak.

## First live test

Intentionally tiny — Bellhop test-only change. The acceptance test validates Radio, not feature complexity. Do not auto-merge abandoned worker branches.

## v1 isolation

v1 remains in `src/runtime/`, `src/cursor/completion-*`, etc. v2 does not call completion-report repair or v1 evidence reconciliation.
