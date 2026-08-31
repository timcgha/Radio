# POLICY-ENGINE-CONTRACT.md

**System:** Radio — Autonomous Software Orchestration  
**Component:** Policy Engine  
**Status:** v0.1 draft  
**Purpose:** Define the hard, deterministic rules that decide whether a GPT-5.6 Sol orchestration decision is legal to execute.

---

## 1. Core Principle

> **The LLM reasons; Radio enforces.**

GPT-5.6 Sol proposes the next orchestration action.

The Policy Engine decides whether Radio is allowed to execute it.

The Policy Engine is deterministic. It does not use an LLM to decide whether a rule applies.

A structurally valid Sol decision may still be rejected by policy.

---

## 2. Responsibilities

The Policy Engine must:

- validate a Sol decision against the current authoritative project state;
- enforce human-approval boundaries;
- enforce remediation, recovery, agent, and cost budgets;
- prevent duplicate or conflicting agent launches;
- prevent direct modification of protected branches;
- enforce legal runtime-state transitions;
- protect deferred/frozen work from accidental activation;
- enforce required acceptance gates;
- reject stale decisions based on superseded project state;
- protect Radio's own authority rules from autonomous weakening;
- return a machine-readable evaluation explaining exactly why a decision is allowed or rejected.

The Policy Engine must not:

- redesign the requested feature;
- generate product requirements;
- reinterpret failed evidence as acceptable;
- silently downgrade blockers;
- repair an illegal Sol decision itself;
- use prose ambiguity to bypass a hard rule.

---

## 3. Authoritative Inputs

Each evaluation receives an immutable snapshot of:

### 3.1 Proposed Sol decision

Validated first against `decision.schema.json`.

### 3.2 Project state

Current `PROJECT-STATE.json`, including:

- project ID;
- canonical main SHA;
- active workstream;
- active transaction;
- branch/tip state;
- active agent;
- remediation budget;
- remediation usage;
- blockers;
- deferred/frozen items;
- pending human decision;
- runtime state.

### 3.3 Policy configuration

Radio-owned configuration defining:

- human approval gates;
- agent limits;
- remediation limits;
- recovery limits;
- protected branches;
- accepted agent actions;
- acceptance requirements;
- cost limits;
- allowed state transitions.

Sol cannot modify this configuration.

### 3.4 Run ledger

Append-only events relevant to:

- prior launches;
- active work;
- idempotency keys;
- remediation usage;
- prior human approvals;
- prior terminal states;
- already-completed external actions.

### 3.5 Verified external state

When required:

- repository branch/SHA state;
- Cursor agent status;
- PR state;
- test/build evidence;
- specialist-review evidence.

External state must be read from the relevant system, not assumed from conversation history.

---

## 4. Policy Evaluation Output

The Policy Engine returns exactly one outcome:

### `ALLOW`

The Sol decision is legal and may be executed.

### `REJECT`

The proposed action violates policy or is inconsistent with authoritative state.

Radio must not execute it.

The orchestrator may receive one bounded opportunity to choose a different legal action when appropriate.

### `REQUIRE_HUMAN`

The proposed action is conceptually valid but crosses a human authority boundary.

Radio must create or reuse a human approval request rather than execute the action.

### `NOOP`

The requested action has already been completed or is no longer necessary.

Radio must not duplicate it.

---

## 5. Evaluation Order

Rules are evaluated in this order.

Earlier failures take precedence over later rules.

### P0 — Contract integrity

1. Decision validates against `decision.schema.json`.
2. `projectId` matches current project.
3. `workstreamId` matches current workstream where one exists.
4. `transactionId` matches current transaction where required.
5. Decision is based on the current state revision/version.
6. Required decision-specific payloads are present.
7. Incompatible payloads are absent.

Failure result: `REJECT`.

### P1 — Terminal-state protection

If the transaction/workstream is already terminal:

- do not relaunch implementation;
- do not consume remediation;
- do not reopen the transaction implicitly.

Allowed outcomes are limited to legal post-terminal actions such as human approval, explicitly approved new recovery, or `NO_ACTION`.

Failure result: `REJECT` or `NOOP`.

### P2 — Idempotency and duplicate protection

Before an external action:

1. derive its idempotency key;
2. check the run ledger;
3. check current external state.

If the exact action already succeeded:

`NOOP`.

If an equivalent action is currently running:

`REJECT` or convert the orchestration state to a legal `WAIT` path through a new Sol decision.

The Policy Engine itself does not rewrite the decision.

### P3 — Active-agent protection

Default:

`maxEquivalentActiveAgents = 1`.

A new equivalent worker may not be launched when one is already active unless explicit parallelism was approved in policy/state.

`REUSE_CURSOR` must identify an existing eligible agent.

`LAUNCH_CURSOR` must not use `REUSE_CURRENT_AGENT`.

### P4 — Human authority boundary

If an action requires human approval and valid unconsumed approval is absent:

return `REQUIRE_HUMAN`.

Default human approval gates include:

- merge PR;
- production deployment;
- material product requirement change;
- unapproved architecture change;
- unapproved persisted schema change;
- major scope expansion;
- starting deferred/frozen work;
- budget override;
- Radio policy/self-modification.

### P5 — Deferred/frozen scope protection

If the proposed action activates a deferred item:

- require the item's resume condition;
- require human approval when specified.

For `FROZEN` work, explicit human reactivation is always required.

No worker may reopen frozen work merely because it would simplify the current task.

### P6 — Budget enforcement

Validate:

- remediation passes;
- specialist-review cycles;
- Cursor agent count;
- recovery transaction count;
- estimated spend, when available.

Default remediation rule:

`maxRemediationPassesPerTransaction = 1`.

If used equals budget:

another remediation is illegal.

Result: `REJECT`.

A new recovery transaction is not a remediation and must follow recovery policy.

### P7 — Runtime state transition

The requested `stateTransition.from` must equal current runtime state.

The requested transition must appear in the allowed transition table.

The Policy Engine must reject stale or impossible transitions.

### P8 — Repository/branch protection

Default rules:

- never implement directly on protected `main`;
- worker base branch must exist;
- expected starting SHA must match authoritative branch tip when pinned;
- branch drift that invalidates the work order causes rejection/precheck failure;
- an implementation transaction must use its approved branch strategy.

A Sol prompt cannot waive these checks.

### P9 — Agent-action legality

Supported agent actions:

- `REUSE_CURRENT_AGENT`
- `FRESH_ORDINARY_AGENT_REQUIRED`
- `FRESH_API_CREATED_PARENT_AUTO_REQUIRED`

Rules:

#### Reuse current agent

Allowed only when:

- eligible agent exists;
- same transaction/context is still valid;
- remediation/authority is not exhausted;
- requested work does not require fresh independence;
- no fresh specialist delegation is required.

#### Fresh ordinary agent

Allowed only when:

- no specialist delegation is required;
- no equivalent active agent exists;
- task does not require Parent Auto policy.

#### Fresh API Parent Auto

Required when:

- specialist delegation is part of the approved workflow;
- design → critique → implementation → certification loop is required;
- recovery transaction explicitly requires independent specialists.

### P10 — Remediation/recovery distinction

A remediation:

- stays inside the same transaction;
- consumes remediation budget.

A recovery:

- must have a new transaction ID;
- must have explicit recovery scope;
- receives a new remediation budget;
- must not masquerade as continuation of the exhausted transaction.

If an exhausted transaction requests another remediation under a new label:

`REJECT`.

### P11 — Acceptance evidence

`ACCEPT_WORKSTREAM` is a Sol recommendation only. Radio independently evaluates
whether the objective's structural completion requirements are satisfied before
any successful objective completion (`ACCEPTED` / `OBJECTIVE_COMPLETE`).

When an objective defines `completionRequirements` on ObjectiveAuthority, Radio
enforces those requirements deterministically after Sol — including structured
worker report validity, remote publication, fresh executable SHA, and evidence
tip verification. Sol cannot override failed deterministic evidence checks.

For complex reviewed work without explicit completion requirements, default
acceptance expectations remain:

- required focused tests pass;
- full test suite passes;
- typecheck passes;
- lint passes or only explicitly allowed historical warnings remain;
- build passes;
- required browser verification passes;
- browser evidence targets `FINAL_EXECUTABLE_SHA`;
- post-executable executable diff is empty;
- required Sol final review = PASS;
- required Opus final review = PASS;
- no unresolved acceptance-blocking findings;
- exact terminal verdict matches the workstream contract.

A Cursor report claiming success is not sufficient if the required evidence is absent.

### P12 — Blocked-state integrity

`BLOCK_WORKSTREAM` requires:

- terminal block verdict;
- blocker summary;
- reason autonomous authority is exhausted or progress is unsafe;
- no illegal action payload.

Blocking is valid even when many technical gates pass.

### P13 — Human approval integrity

A human approval is valid only when:

- approval ID exists;
- approval applies to the current project/workstream/transaction/action;
- it has not been consumed;
- it has not expired if expiration is used;
- current state has not materially drifted from the approval basis.

An approval to open a PR is not approval to merge it.

An approval to start one recovery is not approval for unlimited recoveries.

### P14 — Self-modification protection

Sol may not autonomously change:

- human approval requirements;
- remediation budgets;
- protected branches;
- agent limits;
- security constraints;
- acceptance evidence requirements;
- policy evaluation order;
- Radio's own self-modification rule.

Any such change requires explicit human approval and a separate policy-change transaction.

### P15 — Proposed state update filtering

`proposedStateUpdates` are advisory.

Radio may apply only fields explicitly allowlisted for that decision type.

Sol may not directly modify:

- policy configuration;
- budget ceilings;
- historical acceptance records;
- canonical accepted SHAs;
- run-ledger history;
- human approvals;
- deferred/frozen status without authorized transition.

---

## 6. Runtime State Transition Table

Default v0.1 legal transitions:

| From | To |
|---|---|
| IDLE | PLANNING |
| PLANNING | IMPLEMENTING |
| PLANNING | READY_FOR_HUMAN |
| PLANNING | BLOCKED |
| IMPLEMENTING | WAITING_FOR_AGENT |
| WAITING_FOR_AGENT | VERIFYING |
| WAITING_FOR_AGENT | BLOCKED |
| VERIFYING | REVIEWING |
| VERIFYING | REMEDIATING |
| VERIFYING | BLOCKED |
| REVIEWING | REMEDIATING |
| REVIEWING | READY_FOR_HUMAN |
| REVIEWING | BLOCKED |
| REMEDIATING | WAITING_FOR_AGENT |
| REMEDIATING | VERIFYING |
| REMEDIATING | BLOCKED |
| READY_FOR_HUMAN | WAITING_FOR_HUMAN |
| WAITING_FOR_HUMAN | ACCEPTED |
| WAITING_FOR_HUMAN | BLOCKED |
| WAITING_FOR_HUMAN | PLANNING |
| ACCEPTED | IDLE |
| BLOCKED | IDLE |

A new recovery transaction normally begins after the prior transaction is terminal and a new transaction record is created.

It does not transition the old transaction from `BLOCKED` back to `REMEDIATING`.

---

## 7. Decision-Specific Contracts

### 7.1 `NO_ACTION`

Must have:

- no Cursor instruction;
- no human approval payload;
- no wait payload;
- no new terminal mutation unless already reflected in state.

Use when no external action is needed.

### 7.2 `WAIT`

Must have:

- populated `wait`;
- concrete resume condition;
- no Cursor launch/reuse payload;
- no terminal acceptance claim.

Typical use:

- existing Cursor agent is still running;
- waiting for a human decision;
- bounded external retry window.

### 7.3 `LAUNCH_CURSOR`

Must have:

- populated `cursorInstruction`;
- fresh agent action;
- valid work type;
- valid branch/start state;
- available agent/budget capacity;
- no equivalent active worker;
- no unapproved human-gated scope.

### 7.4 `REUSE_CURSOR`

Must have:

- `agentAction = REUSE_CURRENT_AGENT`;
- existing eligible agent;
- same transaction;
- remaining authority;
- work compatible with reuse.

Do not reuse a transaction whose remediation authority is exhausted.

### 7.5 `REQUEST_HUMAN_APPROVAL`

Must have:

- populated `humanApproval`;
- approval type matching the gated action;
- clear requested action;
- current evidence summary;
- no execution of the gated action before approval.

If an identical pending approval already exists:

`NOOP`.

### 7.6 `ACCEPT_WORKSTREAM`

Must have:

- all required acceptance evidence;
- no acceptance-blocking findings;
- valid terminal payload;
- no Cursor action payload;
- legal state transition.

This decision does not itself imply merge authority.

### 7.7 `BLOCK_WORKSTREAM`

Must have:

- terminal blocked verdict;
- blocker evidence;
- explanation of why progress cannot legally/safely continue;
- no hidden remediation or scope expansion.

---

## 8. Approval Consumption

Human approvals are single-purpose capabilities.

An approval record should contain:

- approval ID;
- project ID;
- workstream ID;
- transaction ID;
- action type;
- target object if applicable;
- state revision / relevant SHA basis;
- decision;
- created time;
- consumed time.

After execution, mark the approval consumed.

Do not reuse the same approval for a materially different action.

---

## 9. Idempotency Contract

Every externally meaningful operation must derive a deterministic idempotency key.

Recommended form:

`<projectId>:<transactionId>:<actionType>:<target>:<attempt>`

Examples:

`cyber-assurance:txn-17:launch-cursor:parent:1`

`cyber-assurance:txn-17:open-pr:cursor/ux-wave1:1`

Before execution:

1. look up key in run ledger;
2. reconcile with external system;
3. execute only if not already successful/in-flight.

A process crash after a successful external call must not create duplicate work after restart.

---

## 10. Stale Decision Protection

Every Sol decision should be evaluated against a project-state revision or deterministic state fingerprint.

If state changed materially after Sol produced the decision:

`REJECT` with `STALE_DECISION`.

Examples:

- active agent completed;
- branch tip changed;
- human approved/rejected something;
- remediation budget changed;
- blocker list changed;
- PR already opened.

Radio should ask Sol to reason again from current state.

---

## 11. Required Error Codes

The Policy Engine should return stable codes including:

- `SCHEMA_INVALID`
- `PROJECT_MISMATCH`
- `WORKSTREAM_MISMATCH`
- `TRANSACTION_MISMATCH`
- `STALE_DECISION`
- `TERMINAL_TRANSACTION`
- `DUPLICATE_ACTION_COMPLETED`
- `EQUIVALENT_ACTION_IN_FLIGHT`
- `ACTIVE_AGENT_CONFLICT`
- `REUSE_AGENT_NOT_AVAILABLE`
- `HUMAN_APPROVAL_REQUIRED`
- `HUMAN_APPROVAL_INVALID`
- `DEFERRED_SCOPE`
- `FROZEN_SCOPE`
- `REMEDIATION_BUDGET_EXHAUSTED`
- `RECOVERY_BUDGET_EXHAUSTED`
- `AGENT_BUDGET_EXHAUSTED`
- `COST_BUDGET_EXHAUSTED`
- `ILLEGAL_STATE_TRANSITION`
- `PROTECTED_BRANCH`
- `STARTING_SHA_MISMATCH`
- `ILLEGAL_AGENT_ACTION`
- `RECOVERY_MASQUERADING_AS_REMEDIATION`
- `ACCEPTANCE_GATES_INCOMPLETE`
- `FINAL_REVIEW_NOT_PASS`
- `BROWSER_EVIDENCE_INVALID`
- `EXECUTABLE_EVIDENCE_SHA_MISMATCH`
- `UNRESOLVED_BLOCKING_FINDINGS`
- `INVALID_BLOCK_DECISION`
- `SELF_MODIFICATION_REQUIRES_HUMAN`
- `ILLEGAL_STATE_UPDATE`
- `POLICY_INTERNAL_ERROR`

Codes should remain stable even if human-readable messages evolve.

---

## 12. Policy Evaluation Result

The machine-readable result should contain:

- policy schema version;
- evaluation ID;
- decision ID;
- result (`ALLOW`, `REJECT`, `REQUIRE_HUMAN`, `NOOP`);
- primary code;
- human-readable summary;
- all triggered rules;
- current runtime state;
- proposed runtime state;
- whether execution is permitted;
- whether Sol should be asked to choose again;
- whether human input is required;
- required approval type if applicable;
- idempotency key if applicable.

Use `policy-evaluation.schema.json` for the output contract.

---

## 13. Example — Allowed Cursor Launch

State:

- no active agent;
- transaction active;
- remediation unused;
- approved branch exists;
- no human-gated scope.

Sol proposes:

`LAUNCH_CURSOR` with `FRESH_API_CREATED_PARENT_AUTO_REQUIRED`.

Policy:

`ALLOW`.

Radio executes the Cursor adapter call and records the event.

---

## 14. Example — Second Remediation Rejected

State:

- remediation budget = 1;
- remediations used = 1.

Sol proposes:

`REUSE_CURSOR` / `REMEDIATION`.

Policy:

`REJECT`.

Code:

`REMEDIATION_BUDGET_EXHAUSTED`.

The orchestrator must choose between a legal new recovery path, human approval if required, or blocking the workstream.

---

## 15. Example — Merge Requires Human

State:

- implementation certified;
- PR ready;
- merge approval absent.

Sol proposes an action whose effect is merge.

Policy:

`REQUIRE_HUMAN`.

Code:

`HUMAN_APPROVAL_REQUIRED`.

Radio requests human approval.

No merge occurs before approval.

---

## 16. Example — Acceptance Claim Rejected

State:

- tests pass;
- Sol final review PASS;
- Opus final review CHANGES_REQUIRED.

Sol proposes:

`ACCEPT_WORKSTREAM`.

Policy:

`REJECT`.

Code:

`FINAL_REVIEW_NOT_PASS`.

A majority vote does not override a required reviewer.

---

## 17. Example — Existing Agent Means Wait, Not Duplicate

State:

- equivalent Parent agent running.

Sol proposes:

`LAUNCH_CURSOR`.

Policy:

`REJECT`.

Code:

`ACTIVE_AGENT_CONFLICT`.

Radio does not silently launch another agent.

Sol should be asked for a new decision and normally return `WAIT`.

---

## 18. Example — Deferred Work

State:

- productionization is deferred;
- no human approval exists.

Sol proposes a Cursor work order adding production authentication/database work during UX remediation.

Policy:

`REQUIRE_HUMAN` or `REJECT`, depending on the decision type.

Code:

`DEFERRED_SCOPE`.

The adjacent improvement does not become legal simply because it is technically sensible.

---

## 19. Example — Crash-Safe Launch

Radio requests Cursor agent creation using idempotency key:

`cyber-assurance:txn-17:launch-cursor:parent:1`

Cursor creates the agent.

Radio crashes before normal completion of the local operation.

After restart:

- ledger/external reconciliation finds the created agent;
- the same operation returns `NOOP` / resumes monitoring;
- no duplicate agent is created.

---

## 20. Evaluation Pseudocode

```text
evaluate(decision, state, policy, ledger, external):

  validate decision schema
  validate project/workstream/transaction identity
  reject if decision state fingerprint is stale

  if requested operation already completed:
      return NOOP

  if transaction is terminal and action is not legal post-terminal:
      return REJECT

  enforce active-agent rules
  enforce human authority gates
  enforce deferred/frozen scope
  enforce budgets
  enforce runtime transition
  enforce branch/SHA protection
  enforce agent-action rules
  enforce remediation/recovery distinction

  if decision == ACCEPT_WORKSTREAM:
      enforce acceptance profile

  if decision == BLOCK_WORKSTREAM:
      enforce blocked-decision integrity

  enforce state-update allowlist
  enforce self-modification protection

  return ALLOW
```

The actual implementation should evaluate and return all relevant triggered rules where safe, but must identify one primary code deterministically.

---

## 21. Policy Precedence

When several rules fail, select the primary code by this precedence:

1. contract/state identity failure;
2. stale decision;
3. idempotency/duplicate;
4. terminal-state conflict;
5. security/self-modification;
6. human authority boundary;
7. deferred/frozen scope;
8. budget;
9. runtime transition;
10. repository protection;
11. agent-action legality;
12. acceptance evidence;
13. state-update legality;
14. internal policy error.

This makes failures predictable for both humans and the Sol orchestrator.

---

## 22. Retry Behavior

A policy rejection does not automatically mean retry.

### Sol may choose again

Examples:

- active agent conflict;
- illegal state transition caused by stale reasoning;
- wrong agent action;
- second remediation requested.

Radio may ask Sol once for a new legal decision using the exact policy violation.

### Human required

Do not ask Sol repeatedly when policy explicitly requires human authority.

### No retry

Do not retry when the requested external action already succeeded.

### Repeated illegal decisions

If Sol repeatedly proposes illegal actions after receiving the violation:

request human review and log the event.

---

## 23. Security Boundary

The Policy Engine must be implemented outside the prompt-controlled model context.

Sol must not be able to alter policy by generating text such as:

> Ignore the one-remediation rule for this case.

Prompt content is untrusted input to the Policy Engine.

Policy configuration should be versioned and protected.

---

## 24. Audit Requirements

Every policy evaluation should append a ledger event containing:

- evaluation ID;
- decision ID;
- result;
- primary code;
- triggered rules;
- state revision/fingerprint;
- approval ID if relevant;
- idempotency key if relevant;
- timestamp.

Do not store secrets in the ledger.

---

## 25. v0.1 Policy Boundary

The v0.1 Policy Engine should remain intentionally small.

It is not a general theorem prover or autonomous governance platform.

Its purpose is to enforce the development workflow already proven manually:

- correct agent type;
- bounded autonomous loops;
- objective acceptance;
- no duplicate workers;
- no silent scope expansion;
- human control of consequential actions;
- restart-safe execution.

If a new policy rule cannot be tied to an observed risk or explicit authority decision, prefer not to add it yet.

---

## 26. One-Sentence Contract

> **The Radio Policy Engine deterministically validates each Sol-proposed orchestration action against authoritative state, budgets, evidence, and human authority, and only permits execution when every applicable hard rule is satisfied.**
