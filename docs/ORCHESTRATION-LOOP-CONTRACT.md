# ORCHESTRATION-LOOP-CONTRACT.md

**System:** Radio — Autonomous Software Orchestration  
**Component:** Runtime Orchestration Loop  
**Status:** v0.1 draft  
**Purpose:** Define exactly how Radio stitches project state, GPT-5.6 Sol decisions, deterministic policy evaluation, Cursor work orders, Cursor completion reports, human approvals, and the append-only run ledger into one restart-safe execution loop.

---

## 1. Core Principle

> **Radio is a persistent state machine wrapped around model reasoning and external workers.**

GPT-5.6 Sol decides what should happen next.

The Policy Engine decides whether that proposed action is legal.

The Cursor Adapter performs approved development work.

The Run Ledger records what actually happened.

`PROJECT-STATE.json` records the current authoritative orchestration state.

The Human Product Owner is invoked only when the next legal action crosses a human authority boundary or requires genuine product judgment.

Radio must never rely on conversational continuity to know what is happening.

---

## 2. Runtime Objective

The runtime loop exists to transform this manual sequence:

```text
Human copies Cursor report
→ gives it to Sol
→ Sol decides next step
→ Human copies new prompt
→ gives it to Cursor
→ waits
→ repeats
```

into:

```text
READ STATE
→ RECONCILE
→ BUILD SOL CONTEXT
→ REQUEST DECISION
→ VALIDATE DECISION
→ EVALUATE POLICY
→ EXECUTE APPROVED ACTION
→ WAIT / INGEST RESULT
→ VALIDATE RESULT
→ UPDATE STATE
→ APPEND LEDGER
→ REPEAT
```

until one of these is true:

- work is ready for human approval;
- work is accepted;
- work is blocked;
- Radio is waiting on an external agent;
- Radio is waiting on a human;
- no action is required.

---

## 3. Runtime Components

Radio v0.1 should contain the following logical components.

### 3.1 State Store

Responsibilities:

- load `PROJECT-STATE.json`;
- validate it against `project-state.schema.json`;
- expose current state revision;
- perform atomic state mutation;
- increment `stateRevision`;
- update `stateUpdatedAt`;
- persist state safely.

The State Store is authoritative for volatile orchestration state.

### 3.2 Run Ledger

Responsibilities:

- append one JSON event per meaningful orchestration event;
- validate each event against `run-ledger-event.schema.json`;
- maintain monotonic `sequence`;
- record state revision before/after;
- support restart reconciliation;
- support idempotency lookup.

The ledger is append-only.

### 3.3 Context Builder

Responsibilities:

Build the minimum sufficient Sol input from:

- `ORCHESTRATOR-CONTEXT.md`;
- project-specific `PROJECT-CONTEXT.md`;
- `PROJECT-STATE.json`;
- relevant `DECISION-LOG.md` entries;
- relevant `DEFERRED-BACKLOG.md` entries;
- current work order/report/evidence;
- policy summary;
- immediate human instruction, if any.

The Context Builder should not blindly send the entire project history.

### 3.4 Sol Adapter

Responsibilities:

- call GPT-5.6 Sol through the OpenAI API;
- require structured output conforming to `decision.schema.json`;
- return the raw model response and parsed decision;
- never execute the decision directly.

### 3.5 Decision Validator

Responsibilities:

- validate Sol output against `decision.schema.json`;
- reject malformed responses;
- surface validation errors back to the runtime;
- allow one bounded structured-output repair attempt when appropriate.

### 3.6 Policy Engine

Responsibilities:

Evaluate the proposed decision according to:

`POLICY-ENGINE-CONTRACT.md`

Possible outcomes:

- `ALLOW`
- `REJECT`
- `REQUIRE_HUMAN`
- `NOOP`

### 3.7 Work Order Builder

Responsibilities:

For legal Cursor actions:

- construct an immutable work order;
- validate against `cursor-work-order.schema.json`;
- render the Cursor prompt;
- verify structured work order and rendered prompt are consistent;
- persist work-order artifact;
- assign idempotency key.

### 3.8 Cursor Adapter

Responsibilities:

- create fresh ordinary agents;
- create/bootstrap API Parent Auto agents;
- reuse eligible agents;
- query status;
- retrieve completion output;
- preserve agent IDs/run IDs;
- never duplicate an in-flight equivalent operation.

### 3.9 Completion Report Validator

Responsibilities:

- parse structured completion report;
- validate against `cursor-completion-report.schema.json`;
- reconcile report facts with repository/API state;
- reject inconsistent/stale evidence;
- distinguish report validity from product success.

### 3.10 Human Approval Interface

v0.1 may be CLI-based.

Responsibilities:

- present a concise approval request;
- capture `APPROVE`, `REJECT`, or `REVISE`;
- bind approval to project/workstream/transaction/action/state revision;
- persist approval;
- prevent reuse for unrelated actions.

---

## 4. Runtime States

Radio uses these runtime states:

```text
IDLE
PLANNING
IMPLEMENTING
WAITING_FOR_AGENT
VERIFYING
REVIEWING
REMEDIATING
READY_FOR_HUMAN
WAITING_FOR_HUMAN
ACCEPTED
BLOCKED
```

These states describe Radio’s orchestration position, not product workflow state.

---

## 5. State Meaning

### `IDLE`

No autonomous transaction is actively progressing.

Radio may:

- await a new human objective;
- create a new workstream/transaction;
- reconcile existing terminal state.

### `PLANNING`

Radio is preparing or requesting a Sol orchestration decision.

Typical activities:

- context assembly;
- decision request;
- work-order planning;
- recovery proposal.

### `IMPLEMENTING`

A legal implementation/recovery action has been approved and is being launched.

This should normally be short-lived.

### `WAITING_FOR_AGENT`

An external Cursor agent is running.

Radio must monitor the existing agent.

Do not ask Sol to select a new development action while the owned agent remains actively running unless the approved transaction explicitly allows parallelism.

### `VERIFYING`

Radio/worker is running or validating deterministic/browser evidence.

### `REVIEWING`

Final specialist review or certification evidence is being evaluated.

### `REMEDIATING`

The one approved remediation pass is active.

### `READY_FOR_HUMAN`

Autonomous work has reached a human authority boundary and the approval request is being prepared.

### `WAITING_FOR_HUMAN`

A concrete human decision is pending.

Do not continue the gated action before approval.

### `ACCEPTED`

The current transaction/workstream has reached its accepted terminal condition.

### `BLOCKED`

Autonomous progress is exhausted, unsafe, or requires a new explicitly authorized transaction.

---

## 6. Legal Transition Table

The runtime must enforce only legal transitions.

```text
IDLE
  → PLANNING

PLANNING
  → IMPLEMENTING
  → READY_FOR_HUMAN
  → BLOCKED

IMPLEMENTING
  → WAITING_FOR_AGENT
  → BLOCKED

WAITING_FOR_AGENT
  → VERIFYING
  → REVIEWING
  → BLOCKED

VERIFYING
  → REVIEWING
  → REMEDIATING
  → READY_FOR_HUMAN
  → BLOCKED

REVIEWING
  → REMEDIATING
  → READY_FOR_HUMAN
  → ACCEPTED
  → BLOCKED

REMEDIATING
  → WAITING_FOR_AGENT
  → VERIFYING
  → BLOCKED

READY_FOR_HUMAN
  → WAITING_FOR_HUMAN

WAITING_FOR_HUMAN
  → ACCEPTED
  → BLOCKED
  → PLANNING

ACCEPTED
  → IDLE

BLOCKED
  → IDLE
```

A new recovery transaction is created after the previous transaction is terminal.

Do **not** mutate a blocked transaction back into remediation.

---

## 7. Main Runtime Loop

Conceptual algorithm:

```text
while radio is running:

    state = load_and_validate_project_state()

    reconcile_state_with_ledger_and_external_systems(state)

    if active_agent_exists_and_is_running:
        transition_or_remain(WAITING_FOR_AGENT)
        poll_with_backoff()
        continue

    if pending_human_decision_exists:
        transition_or_remain(WAITING_FOR_HUMAN)
        wait_for_human()
        continue

    if completed_agent_report_is_pending_ingestion:
        validate_and_ingest_report()
        update_state()
        continue

    if terminal_transaction_requires_no_further_action:
        remain_terminal_or_transition_to_IDLE()
        continue

    context = build_sol_context(state)

    decision = request_structured_sol_decision(context)

    validate_decision_schema(decision)

    policy_result = evaluate_policy(decision, state)

    record_decision_and_policy(policy_result)

    handle(policy_result, decision)
```

The runtime should be event-driven where practical, but this loop is the conceptual source of truth.

---

## 8. Startup Sequence

On every Radio start:

### Step 1 — Load state

Read:

`PROJECT-STATE.json`

Validate against:

`project-state.schema.json`

If invalid:

- do not continue autonomous execution;
- emit `RADIO_ERROR`;
- request human repair.

### Step 2 — Read ledger tail

Read enough of `RUN-LEDGER.jsonl` to determine:

- latest sequence;
- latest state mutation;
- in-flight external operations;
- active idempotency keys;
- unconsumed approvals;
- pending agent creation/completion.

### Step 3 — Reconcile

Compare:

- state file;
- ledger;
- Cursor API;
- repository state where relevant;
- PR state where relevant.

### Step 4 — Repair safe drift

Radio may automatically repair purely operational drift when authoritative truth is unambiguous.

Example:

State says agent `RUNNING`.
Cursor says agent `COMPLETED`.

Radio may:

- append `CURSOR_AGENT_STATUS_CHANGED`;
- update state to completion-processing;
- ingest result.

### Step 5 — Escalate ambiguous drift

If systems disagree materially and authority is unclear:

- do not guess;
- set `lastError`;
- log reconciliation failure;
- request human review.

---

## 9. State Mutation Contract

Every successful state mutation must:

1. read current state revision;
2. validate expected revision;
3. calculate updated state;
4. validate updated state against schema;
5. atomically persist new state;
6. increment `stateRevision`;
7. update `stateUpdatedAt`;
8. append a ledger event containing revision before/after.

Use optimistic concurrency even in v0.1.

A stale process must not overwrite newer state.

---

## 10. State Fingerprint

Radio should calculate a deterministic state fingerprint for orchestration-critical fields.

Suggested inputs:

- project ID;
- canonical main SHA;
- active workstream ID/status;
- transaction ID/status;
- branch/tip;
- final executable SHA;
- evidence tip SHA;
- remediation budget/usage;
- active agent ID/status;
- pending human approval;
- blockers;
- runtime state.

Canonicalize JSON and hash it.

The fingerprint is used to detect stale Sol decisions.

A Sol decision produced against fingerprint `A` must be rejected if authoritative state is now materially `B`.

---

## 11. Sol Decision Cycle

### Step 1 — Build context

Provide:

- durable Radio context;
- relevant project context;
- current state;
- current transaction;
- relevant decisions;
- relevant deferred items;
- latest Cursor report/evidence;
- human instruction if any;
- legal action set.

### Step 2 — Request structured output

Require output conforming to:

`decision.schema.json`

### Step 3 — Validate

If schema invalid:

- log `SOL_DECISION_SCHEMA_REJECTED`;
- allow one bounded repair call with validation errors;
- if still invalid, block/escalate.

### Step 4 — Check freshness

Decision must include/reference the state revision/fingerprint it reasoned from.

If stale:

- log `STALE_DECISION_REJECTED`;
- do not execute;
- request a new decision from current state.

### Step 5 — Policy evaluation

Pass decision to deterministic policy.

The Sol Adapter has no execution authority.

---

## 12. Handling `ALLOW`

If policy returns `ALLOW`:

### `NO_ACTION`

Record and remain/transition appropriately.

### `WAIT`

Persist wait condition.

Do not create external work.

### `LAUNCH_CURSOR`

1. create work order;
2. validate schema;
3. render prompt;
4. persist work order;
5. append `WORK_ORDER_CREATED`;
6. transition to `IMPLEMENTING`;
7. invoke Cursor Adapter using idempotency key;
8. persist returned agent identity;
9. transition to `WAITING_FOR_AGENT`.

### `REUSE_CURSOR`

Same pattern, except:

- validate eligible agent;
- no fresh agent creation;
- record reused agent/work order linkage.

### `ACCEPT_WORKSTREAM`

Validate acceptance evidence one final time.

Then:

- set transaction/workstream accepted;
- record exact terminal verdict;
- append acceptance ledger event;
- transition `ACCEPTED`.

### `BLOCK_WORKSTREAM`

Persist blockers and terminal verdict.

Then:

- append blocked event;
- transition `BLOCKED`.

---

## 13. Handling `REJECT`

If policy returns `REJECT`:

1. append `POLICY_REJECTED_SOL_DECISION`;
2. do not execute action;
3. determine whether policy allows Sol to choose again.

Examples where a new Sol decision is appropriate:

- stale decision;
- active-agent conflict;
- illegal agent action;
- exhausted remediation where a recovery/block decision is needed.

Give Sol:

- rejected decision;
- exact policy code;
- current state;
- allowed alternatives.

Allow one bounded re-decision for the same runtime cycle.

If Sol repeatedly returns illegal decisions:

- stop;
- request human review;
- log control-plane error.

---

## 14. Handling `REQUIRE_HUMAN`

When policy returns `REQUIRE_HUMAN`:

1. construct approval request;
2. bind to current state revision/fingerprint;
3. append `HUMAN_APPROVAL_REQUESTED`;
4. set `pendingHumanDecision`;
5. transition to `READY_FOR_HUMAN`;
6. then `WAITING_FOR_HUMAN`;
7. stop autonomous execution of the gated action.

---

## 15. Human Approval Cycle

When human responds:

### APPROVE

- validate approval is still fresh;
- persist approval result;
- append `HUMAN_APPROVAL_GRANTED`;
- mark/retain approval as unconsumed until action executes;
- transition to `PLANNING`;
- ask Sol for the next legal decision with the approval present.

The Policy Engine should now permit the specific gated action.

After execution:

- append `HUMAN_APPROVAL_CONSUMED`.

### REJECT

- append `HUMAN_APPROVAL_REJECTED`;
- clear pending approval;
- transition to `PLANNING` or `BLOCKED` depending on context.

### REVISE

- append `HUMAN_APPROVAL_REVISED`;
- capture human instruction;
- transition to `PLANNING`;
- Sol reasons from the revised instruction.

---

## 16. Cursor Launch Sequence

For a new agent:

```text
POLICY ALLOW
→ CREATE WORK ORDER
→ WRITE WORK ORDER ARTIFACT
→ APPEND WORK_ORDER_CREATED
→ APPEND CURSOR_AGENT_CREATE_REQUESTED
→ CALL CURSOR API
→ RECORD AGENT ID
→ APPEND CURSOR_AGENT_CREATED
→ UPDATE ACTIVE AGENT
→ WAITING_FOR_AGENT
```

The idempotency key must exist before the external API call.

If the process crashes after Cursor creates the agent but before local state updates, restart reconciliation must discover the existing operation instead of creating a duplicate.

---

## 17. API Parent Bootstrap Sequence

For:

`FRESH_API_CREATED_PARENT_AUTO_REQUIRED`

the runtime may initially use the same bootstrap model currently used manually.

Sequence:

```text
Radio creates bootstrap work order
→ fresh ordinary Cursor bootstrap agent launched
→ bootstrap uses repository launcher/API
→ actual Parent Auto created
→ bootstrap returns Parent ID/handoff
→ Radio validates handoff
→ active worker becomes API Parent
→ Radio monitors Parent
```

Desired later optimization:

If Cursor’s API can be called directly from Radio with equivalent safety and authentication, Radio may eliminate the bootstrap hop.

Do not require this optimization for v0.1.

---

## 18. Agent Monitoring

Radio polls active agent status with bounded backoff.

Suggested v0.1:

- initial interval: 15–30 seconds;
- gradually back off to ~60 seconds;
- do not poll more aggressively without need.

On each poll:

- record only meaningful status changes;
- update `lastObservedAt`;
- avoid filling ledger with redundant unchanged-status events.

If agent remains running:

`WAITING_FOR_AGENT`.

If completed:

- retrieve completion report;
- append `CURSOR_AGENT_COMPLETED`;
- proceed to report validation.

If failed/unreachable:

- classify;
- do not automatically create a replacement unless policy/Sol explicitly authorizes it.

---

## 19. Completion Report Ingestion

Phase 2 simplified sequence:

```text
VERIFY TRUSTED EXECUTION ENVELOPE
→ ACQUIRE RAW CURSOR RESULT (exact, untrusted)
→ OPTIONAL BEST-EFFORT STRUCTURED REPORT DIAGNOSTICS
→ VERIFYING → REVIEWING
→ BUILD BOUNDED CONTEXT (trusted Radio facts + untrusted worker evidence)
→ ONE GPT-5.6 SOL INTERPRET + DECIDE CALL
→ VALIDATE SOL CONTINUATION SCHEMA
→ INDEPENDENTLY VALIDATE output.decision
→ DETERMINISTIC POLICY
→ STOP (NEXT_ACTION_READY; do not execute)
```

Structured worker JSON remains preferred and is included as supplemental
evidence when `STRUCTURED_WORKER_REPORT_STATUS=VALID`.

If structured report is prose / malformed JSON / schema-invalid:

- record diagnostics;
- do **not** block Sol solely for format failure;
- still send the exact raw result as UNTRUSTED EXTERNAL WORKER EVIDENCE.

If trusted execution-envelope validation fails (identity, nonterminal run,
missing raw result, stale/conflicting state):

- STOP BEFORE SOL.

Worker content never creates human approval, budget, legal transition, or
execution authority.

---

## 20. Completion Report → State Update Rules

Examples:

### Branch / SHA

Observed verified branch state may update:

- transaction branch;
- branch tip SHA;
- final executable SHA;
- evidence tip SHA.

### Reviews

Final specialist verdicts update transaction review state.

### Remediation

If report proves remediation was consumed:

- increment `remediationsUsed`;
- recompute `remediationBudgetExhausted`.

### Blockers

Replace/update current transaction blocker projection from validated report.

### PR

Verified PR state updates transaction PR state.

Do not update historical acceptance merely because a worker reports it.

Historical acceptance changes require a separate explicit accepted event.

---

## 21. Remediation Flow

Initial final review finds blocker.

Sol proposes remediation.

Policy checks:

```text
remediationsUsed < remediationBudget
```

If allowed:

1. append `REMEDIATION_AUTHORIZED`;
2. increment usage at the correct authorization/execution boundary;
3. transition `REMEDIATING`;
4. create reuse work order when current Parent remains eligible;
5. agent fixes;
6. rerun required gates;
7. refreeze executable if changed;
8. run fresh Sol review;
9. run fresh Opus review.

If blockers remain:

- remediation budget is exhausted;
- transaction must halt;
- no second remediation.

---

## 22. Recovery Flow

A recovery is a new transaction.

Sequence:

```text
CURRENT TRANSACTION = BLOCKED
→ Sol may recommend new recovery
→ Policy checks recovery budget / human gate
→ if allowed:
     create new transaction ID
     increment recoverySequence
     assign new branch/base
     reset remediation usage for new transaction
     preserve previous terminal transaction history
     transition PLANNING
```

Never edit the old blocked transaction into a new recovery state.

---

## 23. Human Boundary Examples

Radio must stop for human approval before:

- merge;
- production deploy;
- starting frozen work;
- material requirement change;
- unapproved schema change;
- major scope expansion;
- budget override;
- Radio policy weakening.

Radio may continue autonomously for:

- approved implementation;
- testing;
- browser verification;
- specialist review;
- one permitted remediation;
- bounded report repair;
- waiting/polling;
- safe state reconciliation.

---

## 24. Idempotency Model

Every externally meaningful action gets a deterministic key.

Examples:

```text
cyber-assurance:txn-17:launch-parent:1
cyber-assurance:txn-17:reuse-parent:remediation-1
cyber-assurance:txn-17:open-pr:1
```

Before execution:

1. inspect ledger;
2. inspect external system;
3. classify:
   - not started;
   - in flight;
   - completed;
   - failed.

Only `not started` permits a fresh execution.

---

## 25. Crash Recovery Scenarios

### Scenario A — Crash before external call

Ledger contains work order, but no successful external execution.

Radio may safely retry using the same idempotency key.

### Scenario B — Crash after agent created, before state updated

Ledger/external reconciliation finds the agent.

Radio records reconciliation and resumes monitoring.

No duplicate launch.

### Scenario C — Crash while waiting

On restart, Radio reads active agent and resumes polling.

### Scenario D — Crash after completion report received

If raw report artifact exists but state not updated:

- validate report;
- apply idempotently;
- do not ask Cursor to rerun.

### Scenario E — Crash after approval granted

Approval record remains.

Radio checks whether approval was consumed.

If not, resume planning/execution of the exact approved action.

---

## 26. Atomic Persistence Strategy

v0.1 can remain file-based.

Recommended approach:

1. write new state to temporary file;
2. fsync if practical;
3. atomic rename over `PROJECT-STATE.json`;
4. append ledger event;
5. fsync ledger if practical.

For stronger consistency, an implementation may choose:

- ledger-first event sourcing;
- SQLite;
- Postgres later.

Do not introduce a database merely because it is more sophisticated.

File + JSONL is sufficient for v0.1 if carefully implemented.

---

## 27. Ordering Between State and Ledger

A pragmatic v0.1 rule:

- external intent is logged before external side effects;
- external result is logged immediately after reconciliation;
- state mutation records revision before/after.

The runtime must be able to detect partial completion after a crash.

Use explicit lifecycle events such as:

```text
CURSOR_AGENT_CREATE_REQUESTED
CURSOR_AGENT_CREATED
```

rather than one ambiguous event.

---

## 28. Sol Context Refresh Rules

Always rebuild Sol context when:

- state revision changes;
- agent completes;
- policy rejects a decision;
- human responds;
- branch/SHA changes;
- a new blocker appears;
- remediation is consumed;
- a new transaction begins.

Do not reuse stale model reasoning after a material state change.

---

## 29. Model Retry Rules

### Network/API failure

Retry with bounded exponential backoff.

### Invalid structured output

Allow one structured repair attempt.

### Repeated illegal decision

Do not loop indefinitely.

After one policy-informed re-decision attempt:

- stop;
- request human review.

### Low confidence

If Sol marks confidence `LOW` and the choice could materially alter scope/product semantics:

policy should route to human approval rather than autonomous execution.

---

## 30. Cursor Retry Rules

Radio should not automatically retry a Cursor launch merely because the first call timed out.

First reconcile:

- was agent actually created?
- is operation in flight?
- did API return ambiguous failure?

Only retry if authoritative evidence shows the original action did not occur.

---

## 31. Report Repair Flow

If execution completed but report is malformed:

```text
REPORT INVALID
→ Policy decides whether REPORT_REPAIR is legal
→ Prefer REUSE_CURRENT_AGENT when eligible
→ Read-only closeout
→ no product code changes
→ reconstructed report must cite observed repository/evidence
```

Do not rerun implementation just to obtain nicer reporting.

---

## 32. CLI v0.1

A minimal CLI may provide:

```text
radio start
radio status
radio approve <approval-id>
radio reject <approval-id>
radio revise <approval-id>
radio stop
radio events --tail 20
radio inspect-state
```

Possible display:

```text
RADIO v0.1

Project: Cyber Assurance Demo
Workstream: UX Wave 1
Transaction: Verification Integrity Recovery
State: WAITING_FOR_AGENT

Agent:
bc-...

Started:
12 minutes ago

Next:
Waiting for Cursor completion
```

No web dashboard is required for v0.1.

---

## 33. Suggested Runtime Directory

```text
radio/
  context/
    ORCHESTRATOR-CONTEXT.md

  projects/
    cyber-assurance/
      PROJECT-CONTEXT.md
      PROJECT-STATE.json
      DECISION-LOG.md
      DEFERRED-BACKLOG.md
      RUN-LEDGER.jsonl

  schemas/
    decision.schema.json
    policy-evaluation.schema.json
    cursor-work-order.schema.json
    cursor-completion-report.schema.json
    project-state.schema.json
    run-ledger-event.schema.json

  src/
    runtime/
      loop.ts
      startup.ts
      reconcile.ts
      transitions.ts

    state/
      store.ts
      fingerprint.ts
      ledger.ts

    orchestrator/
      context-builder.ts
      sol-adapter.ts
      decision-validator.ts

    policy/
      engine.ts

    cursor/
      adapter.ts
      work-order-builder.ts
      prompt-renderer.ts
      completion-validator.ts

    human/
      approvals.ts
      cli.ts

  artifacts/
    work-orders/
    decisions/
    reports/
    approvals/
```

---

## 34. Core Invariants

Radio must always preserve these invariants.

### Invariant 1

At most one equivalent active worker exists unless parallelism was explicitly approved.

### Invariant 2

A transaction cannot consume more remediation passes than its budget.

### Invariant 3

A blocked transaction is never silently reopened as remediation.

### Invariant 4

A Sol decision is not executed unless Policy returns `ALLOW`.

### Invariant 5

A human-gated action is not executed without valid unconsumed approval.

### Invariant 6

A Cursor completion report cannot directly mutate Radio authority or trusted
execution identity. Raw worker output is untrusted evidence. Structured
report validation is preferred diagnostics, not a gate that prevents Sol from
interpreting a completed execution's raw result. Trusted execution-envelope
checks (identity, terminal status, raw presence) remain deterministic and
fail-closed before Sol.

### Invariant 7

`FINAL_EXECUTABLE_SHA` evidence must certify the exact executable.

### Invariant 8

Every meaningful state mutation increments `stateRevision`.

### Invariant 9

Every external action is idempotency-protected.

### Invariant 10

Radio policy cannot be weakened by model output.

---

## 35. Minimum v0.1 Acceptance Tests

### State

- loads valid project state;
- rejects invalid project state;
- increments revision atomically;
- rejects stale write.

### Ledger

- sequence is monotonic;
- event schema validates;
- restart can reconstruct in-flight external action;
- duplicate idempotency key is detected.

### Sol

- valid structured decision accepted;
- malformed decision rejected;
- stale decision rejected.

### Policy

- second remediation rejected;
- merge without approval requires human;
- deferred scope blocked;
- duplicate active agent rejected;
- acceptance with failed reviewer rejected.

### Cursor

- work order rendered correctly;
- agent launch recorded;
- duplicate launch not repeated;
- completed report ingested;
- malformed structured report is diagnostic (Sol may still interpret raw evidence);
- empty/missing raw result or identity mismatch fails closed before Sol.

### Human

- approval bound to action;
- approval cannot be reused;
- stale approval rejected.

### Crash recovery

- crash after agent creation resumes same agent;
- crash after report receipt does not rerun worker;
- crash while waiting resumes polling.

### End-to-end

Given an approved bounded task:

```text
IDLE
→ PLANNING
→ IMPLEMENTING
→ WAITING_FOR_AGENT
→ VERIFYING/REVIEWING
→ READY_FOR_HUMAN
→ WAITING_FOR_HUMAN
→ ACCEPTED
```

without human copy/paste between Sol and Cursor.

---

## 36. Pilot Success Criterion

The first real pilot should use an actual bounded Cyber Assurance development task after the current active recovery reaches a clean stopping point.

Success means:

1. human provides/approves the objective;
2. Radio asks Sol for the next action;
3. Radio launches the correct Cursor agent;
4. Radio waits without human transport;
5. Radio ingests Cursor’s result;
6. Radio asks Sol what happens next;
7. Radio performs any permitted bounded recovery/remediation;
8. Radio stops at the human merge/decision boundary;
9. no duplicate agents or illegal transitions occur;
10. all state can be reconstructed after restart.

---

## 37. Explicit Non-Goals for This Runtime

Do not add to v0.1:

- multi-project concurrency;
- arbitrary agent swarms;
- autonomous merge;
- autonomous production deploy;
- vector-memory service;
- workflow designer UI;
- self-tuning policy;
- distributed queue infrastructure;
- complex event bus;
- Kubernetes;
- dedicated database unless file persistence proves inadequate.

---

## 38. Implementation Guidance

Prefer TypeScript/Node for v0.1 because:

- existing project/launcher tooling already uses the JS/TS ecosystem;
- JSON Schema tooling is mature;
- API integration is straightforward;
- it keeps the development stack cohesive.

Recommended implementation style:

- small pure functions for policy/transitions;
- explicit discriminated unions;
- schema validation at every external boundary;
- append-only raw artifacts;
- minimal dependency footprint;
- deterministic tests for all authority rules.

---

## 39. First Build Slice

Do not implement everything at once.

The smallest useful vertical slice is:

```text
Load state
→ build Sol context
→ call Sol
→ validate decision
→ policy evaluate
→ render one Cursor work order
→ stop before launching Cursor
```

Then:

```text
add Cursor launch + polling
```

Then:

```text
add completion ingestion
```

Then:

```text
add human approval
```

Then:

```text
add restart/idempotency hardening
```

This keeps failures understandable.

---

## 40. One-Sentence Contract

> **The Radio orchestration loop is a restart-safe, policy-constrained state machine that repeatedly turns authoritative project state into a structured Sol decision, executes only legal actions, ingests verified Cursor evidence, persists the result, and continues until human judgment or a terminal state is reached.**
