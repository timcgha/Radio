# CURSOR-WORK-ORDER-CONTRACT.md

**System:** Radio — Autonomous Software Orchestration  
**Component:** Cursor Work Order  
**Status:** v0.1 draft  
**Purpose:** Define the standardized, machine-readable envelope Radio sends to Cursor after a Sol orchestration decision passes policy.

---

## 1. Core Principle

> **A Cursor work order is an execution contract, not a conversational suggestion.**

The work order translates an approved orchestration decision into a bounded job for the Cursor factory.

It must tell the worker:

- what it is being asked to do;
- what repository state is authoritative;
- what agent mode is required;
- what is in scope;
- what is explicitly out of scope;
- what evidence must be produced;
- what budgets and stop conditions apply;
- what terminal verdicts are legal;
- what Git/PR behavior is permitted;
- how the final completion report must be formatted.

A work order must be complete enough that the worker does not need to infer missing product decisions from stale chat history.

---

## 2. Relationship to Other Radio Artifacts

### Input

A work order is created only after:

1. GPT-5.6 Sol returns a valid `decision.schema.json` decision;
2. Radio Policy Engine evaluates it;
3. policy result is `ALLOW`.

### Output

Cursor executes the work order and returns a completion report conforming to the future `cursor-completion-report.schema.json`.

### Authority

The work order may narrow scope or impose stricter constraints than global policy.

It may not weaken Radio policy.

If the work order conflicts with hard Radio policy, Radio policy wins.

---

## 3. Supported Agent Actions

Every work order must state the required agent action near the top of both:

- the structured work order; and
- the rendered Cursor prompt.

Supported values:

### `REUSE_CURRENT_AGENT`

Use when:

- an eligible current agent already owns the transaction context;
- policy permits reuse;
- the task is narrow and bounded;
- no fresh specialist independence is required.

### `FRESH_ORDINARY_AGENT_REQUIRED`

Use when:

- a clean independent worker is needed;
- specialist delegation is not required;
- a single ordinary agent can own implementation or verification.

### `FRESH_API_CREATED_PARENT_AUTO_REQUIRED`

Use when:

- specialist delegation is required;
- the autonomous Parent loop is required;
- design → critique → implementation → verification → dual certification is part of the job.

In this mode the human does **not** manually call an API.

A normal fresh Cursor Cloud Agent acts as a bootstrap agent. The bootstrap agent uses the repository’s approved launcher/API tooling to create the actual API Parent Auto.

The bootstrap agent must not implement the requested product work.

---

## 4. Work Order Identity

Each work order must contain:

- `workOrderId`
- `projectId`
- `workstreamId`
- `transactionId`
- `decisionId`
- `createdAt`
- `idempotencyKey`

The tuple should uniquely identify the external operation.

A repeated delivery of the same work order must not create duplicate agents or duplicate execution.

---

## 5. Source State

Every work order must declare the source state Radio expects Cursor to verify.

Fields include:

- repository URL;
- canonical main branch;
- canonical main SHA when relevant;
- source/base branch;
- expected source branch tip SHA;
- expected executable ancestor if relevant;
- working branch strategy;
- whether branch creation is required.

### Precheck rule

Cursor must verify pinned source state before implementation.

If a required branch or SHA differs:

> STOP. Do not guess.

Return a precheck-blocked completion report.

---

## 6. Work Types

Supported v0.1 work types:

- `PRECHECK`
- `DESIGN`
- `IMPLEMENTATION`
- `VERIFICATION`
- `REVIEW`
- `REMEDIATION`
- `RECOVERY`
- `CLOSEOUT`
- `REPORT_REPAIR`

A work order has exactly one primary work type.

A complex Parent transaction may internally perform design, implementation, verification, and review, but the overall transaction still has one primary classification such as `IMPLEMENTATION` or `RECOVERY`.

---

## 7. Objective

The objective should answer:

> What concrete outcome must this transaction produce?

A good objective is:

- bounded;
- outcome-oriented;
- product-specific;
- verifiable.

Avoid vague objectives such as:

> Improve the app.

Prefer:

> Close remaining Wave 1 verification-integrity blockers without beginning Wave 2 product scope.

---

## 8. Scope

Each work order must explicitly contain:

### In scope

The files, behaviors, findings, requirements, or user journeys that may be changed.

### Out of scope

Adjacent work that must not be started.

### Allowed product changes

For recovery/verification transactions, specify whether product code may change and under what conditions.

### Protected semantics

List behavior that must remain unchanged, such as:

- persisted schema;
- workflow state machine;
- SLA thresholds;
- seed chronology;
- accepted historical provenance.

Scope boundaries should be explicit enough to prevent “while I was here” redesign.

---

## 9. Requirements

Requirements should be given stable IDs.

Example:

- `REQ-001`
- `REQ-002`

Each requirement should include:

- statement;
- severity/importance;
- source/rationale when useful;
- acceptance method;
- whether it is product, test, browser, evidence, docs, or policy-related.

The worker must not silently reinterpret a requirement that conflicts with authoritative context.

If requirements conflict:

- report the conflict;
- stop when necessary;
- do not invent a compromise that changes product intent.

---

## 10. Agent Plan

The work order should declare the approved worker structure.

### Ordinary agent

No specialist delegation.

### API Parent Auto

The plan may contain:

- Sol design specialist;
- Opus design critique specialist;
- Parent implementation;
- deterministic gates;
- browser verification;
- Sol final review;
- Opus final review;
- one optional remediation;
- fresh re-review pair.

The Parent owns implementation.

Specialists remain read-only.

Do not create additional helper/specialist agents unless the work order explicitly permits them.

---

## 11. Specialist Plan

When specialists are required, declare:

- role;
- model;
- mode;
- read-only expectation;
- expected output/verdict;
- when the specialist is called.

Example:

### Design Sol

- model: `gpt-5.6-sol-high`
- role: design
- mode: repository-supported design mode
- read-only: true

### Adversarial Opus

- model: `claude-opus-5-thinking-high`
- role: critique
- read-only: true

### Final Sol

- mode: `REVIEW_IMPLEMENTATION`
- read-only: true
- allowed verdicts: `PASS`, `CHANGES_REQUIRED`

### Final Opus

- read-only: true
- allowed verdicts: `PASS`, `CHANGES_REQUIRED`

A mode-gate failure does not count as a successful independent review.

---

## 12. Budgets

Every work order must state applicable budgets.

At minimum:

- remediation budget;
- specialist review-cycle budget;
- max agent count where applicable.

Default complex-transaction remediation budget:

`1`

If budget is exhausted:

- do not continue remediating;
- halt with the blocked terminal verdict.

A worker may not create a new recovery transaction by itself unless the work order explicitly grants that authority.

---

## 13. Verification Plan

The work order must specify required verification.

Potential gates:

- focused tests;
- domain tests;
- full npm tests;
- typecheck;
- lint;
- build;
- historical provenance checks;
- browser verification;
- requirement→test mapping;
- SHA/evidence freeze checks.

The worker must record actual commands and results when the completion contract asks for them.

---

## 14. Browser Verification Plan

When UI behavior is in scope, the work order should declare:

- browser method;
- required routes;
- personas;
- viewport matrix;
- critical journeys;
- click-bound requirements;
- route assertions;
- mobile bounding/touch requirements;
- fail-closed criteria;
- allowed infrastructure fallback, if any.

### Critical journey rule

When a journey is intended to prove user navigation, direct `page.goto()` shortcuts after journey entry are not acceptable unless explicitly permitted for reset/setup.

### Evidence binding

Browser evidence must identify the exact `FINAL_EXECUTABLE_SHA` it certifies.

---

## 15. Git Plan

Every work order must state:

- expected base branch;
- expected base tip;
- new branch name or branch creation strategy;
- whether current branch may be reused;
- protected branches;
- commit expectations;
- whether push is required.

Default:

- do not implement directly on `main`;
- do not rewrite accepted history;
- do not force-push unless explicitly approved.

---

## 16. PR Plan

The work order must declare:

- whether PR creation is allowed;
- whether PR creation is required;
- whether human approval is required first;
- whether merge is prohibited.

Default Radio v0.1:

- implementation may prepare or open a PR only when policy/work order allows;
- merge is prohibited without human approval;
- the worker must never fabricate a PR number or URL.

If environment approval prevents opening the PR, return an explicit state such as:

`PR_NOT_OPENED_PENDING_USER_APPROVAL`

---

## 17. Executable Freeze

For certifiable implementation work:

1. finish all executable code/test/browser-runner changes;
2. commit them;
3. record `FINAL_EXECUTABLE_SHA`;
4. run required deterministic and browser evidence from that exact commit;
5. permit only approved evidence/review metadata changes afterward;
6. record `EVIDENCE_TIP_SHA`.

If executable code changes after the freeze:

- create a new executable SHA;
- invalidate stale browser/review evidence;
- rerun required certification.

---

## 18. Completion Contract

The work order must declare required terminal verdicts.

Example:

- `UX_WAVE1_VERIFICATION_READY_FOR_REVIEW`
- `UX_WAVE1_VERIFICATION_BLOCKED`

Cursor must end with exactly one allowed terminal verdict.

The completion report should include required fields such as:

- bootstrap agent ID;
- API Parent agent ID;
- branch;
- SHAs;
- files changed;
- tests;
- browser results;
- specialist IDs/verdicts;
- remediation usage;
- blockers;
- PR state;
- recommended next action;
- final verdict.

---

## 19. Final Report Formatting

Every Cursor/Cloud Agent prompt generated by Radio must require:

> Return the entire final completion report inside exactly one fenced `text` code block. Nothing before it. Nothing after it. No nested fences. One contiguous block.

This makes completion reports easy to transport manually during transition and easy to capture programmatically later.

---

## 20. Stop Conditions

A work order must contain explicit stop conditions.

Typical stop conditions:

- source SHA/branch mismatch;
- required repository resource missing;
- specialist mode cannot be safely enforced;
- remediation budget exhausted;
- final reviewer still returns `CHANGES_REQUIRED` after allowed remediation;
- acceptance evidence cannot be produced;
- requested work requires unapproved scope expansion;
- human product decision is required;
- policy-protected behavior would need modification.

When a stop condition triggers:

- stop;
- preserve evidence;
- return the blocked verdict;
- do not improvise around the boundary.

---

## 21. No-Silent-Scope-Expansion Rule

If the worker discovers an adjacent issue:

### Blocking current objective

It may be fixed only if:

- the work order permits necessary blocking fixes; and
- the fix does not cross a protected product/policy boundary.

### Nonblocking

Record it and defer it.

Do not enlarge the current transaction solely because another improvement is visible.

---

## 22. Product Truth Rule

The worker must preserve truth across:

- UI copy;
- workflow behavior;
- test assertions;
- browser evidence;
- completion reports.

Examples:

- do not claim email sent if no event exists;
- do not call an unverified reviewer PASS;
- do not describe request-level counts as control-level counts;
- do not call a browser journey click-bound if it used direct navigation shortcuts.

---

## 23. Work Order Rendering

Radio may store the structured work order as JSON and render a human-readable Cursor prompt from it.

The renderer must not silently drop:

- agent action;
- source-state pins;
- scope constraints;
- budgets;
- acceptance gates;
- stop conditions;
- final report requirements.

The rendered prompt is an execution representation of the structured contract.

If structured work order and rendered prompt disagree, execution must stop and the work order must be regenerated.

---

## 24. Bootstrap Contract for API Parent Auto

For `FRESH_API_CREATED_PARENT_AUTO_REQUIRED`:

The bootstrap prompt must state:

1. this agent is only the bootstrap agent;
2. it must not implement the product work;
3. it must use approved repository launcher/API tooling;
4. the actual Parent must use source `api`;
5. Parent model must be default/Auto unless work order says otherwise;
6. required specialists must be attached/configured;
7. starting ref must match the work order;
8. automatic PR creation must follow the work order;
9. bootstrap must return the Parent agent ID and verified handoff state;
10. the actual Parent owns the full transaction.

If the bootstrap cannot create the required Parent exactly:

- stop;
- do not fall back to implementing in the bootstrap agent.

---

## 25. Ordinary Agent Contract

For `FRESH_ORDINARY_AGENT_REQUIRED`:

- one fresh independent agent owns the task;
- no Sol/Opus specialist delegation;
- obey the same source-state, scope, verification, Git, and completion contracts;
- do not silently upgrade itself to a Parent/specialist workflow.

---

## 26. Reuse Contract

For `REUSE_CURRENT_AGENT`:

The work order must identify the eligible agent.

The agent may be reused only for the same active transaction/context and only when policy permits.

Typical use:

- completion-report repair;
- narrow closeout;
- read-only verification;
- permitted remediation;
- bounded continuation.

Do not reuse a blocked/exhausted transaction as a way to avoid creating a new recovery.

---

## 27. Work Order Immutability

Once execution begins, the work order is immutable.

A material change requires:

- a new work-order revision or new work order;
- policy reevaluation;
- ledger record.

Minor operational metadata such as returned agent ID may be attached without changing the original intent.

Do not mutate the original objective or constraints in place after launch.

---

## 28. Work Order Revision

If revision is needed before launch:

- increment `revision`;
- preserve same `workOrderId`;
- record superseded revision.

If work has already begun and objective/scope changes materially:

- create a new work order;
- do not repurpose the running job.

---

## 29. Idempotency

The work order contains the idempotency key used for the external execution action.

A repeated work order with the same key must resolve to:

- existing in-flight agent;
- already-completed action;
- or safe no-op.

It must not launch a duplicate worker.

---

## 30. Security / Secret Handling

Work orders must never embed:

- API keys;
- passwords;
- bearer tokens;
- private secrets.

Reference approved environment/tooling instead.

Completion reports must redact secrets and sensitive credentials.

---

## 31. Minimal Example

```json
{
  "schemaVersion": "1.0",
  "workOrderId": "wo-20260829-001",
  "revision": 1,
  "projectId": "cyber-assurance-demo",
  "workstreamId": "ux-wave1",
  "transactionId": "ux-wave1-verification-integrity",
  "decisionId": "dec-20260829-009",
  "idempotencyKey": "cyber-assurance-demo:ux-wave1-verification-integrity:launch-parent:1",
  "agentAction": "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
  "workType": "RECOVERY",
  "objective": "Close remaining Wave 1 verification-integrity blockers without starting Wave 2.",
  "source": {
    "repository": "https://github.com/timcgha/Cyber-assurance-demo",
    "canonicalMainBranch": "main",
    "canonicalMainSha": "9767444943737695ba2379802a77254c8bdc0f4f",
    "baseBranch": "cursor/ux-wave1-action-truth-recovery",
    "expectedBaseTipSha": "c4452b17cb22bedf45563c748869368253c6ed19"
  },
  "budgets": {
    "maxRemediationPasses": 1
  },
  "completion": {
    "allowedTerminalVerdicts": [
      "UX_WAVE1_VERIFICATION_READY_FOR_REVIEW",
      "UX_WAVE1_VERIFICATION_BLOCKED"
    ]
  }
}
```

The real schema requires additional execution details.

---

## 32. One-Sentence Contract

> **A Cursor work order is Radio's immutable, policy-approved execution envelope that tells the Cursor factory exactly what to build or verify, from which authoritative state, under which constraints and budgets, and what evidence and terminal verdict must be returned.**
