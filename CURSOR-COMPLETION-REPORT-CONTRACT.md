# CURSOR-COMPLETION-REPORT-CONTRACT.md

**System:** Radio — Autonomous Software Orchestration  
**Component:** Cursor Completion Report  
**Status:** v0.1 draft  
**Purpose:** Define the standardized, machine-readable result envelope Cursor returns to Radio after executing a policy-approved work order.

---

## 1. Core Principle

> **A Cursor completion report is evidence-bearing execution output, not a narrative status update.**

The report must tell Radio, in a machine-readable and auditable way:

- what work order was executed;
- which agent(s) performed it;
- what repository state was used;
- what changed;
- what tests and browser checks ran;
- what specialist reviewers concluded;
- whether remediation was used;
- which exact executable SHA was certified;
- whether evidence is bound to that executable;
- what blockers remain;
- what PR state exists;
- which terminal verdict the transaction reached.

Radio should not need to infer critical state from prose.

---

## 2. Relationship to Other Radio Artifacts

### Input contract

Cursor executes a work order conforming to:

`cursor-work-order.schema.json`

### Output contract

Cursor returns a completion report conforming to:

`cursor-completion-report.schema.json`

### Orchestrator use

Radio ingests the report, validates it, reconciles it against repository/API state, updates project state, and then sends the relevant evidence to GPT-5.6 Sol for the next orchestration decision.

### Authority

A completion report does not override:

- Radio Policy Engine;
- authoritative repository state;
- human approvals;
- hard budgets;
- accepted historical provenance.

If the report conflicts with verified external state, external state wins and the report is marked invalid or inconsistent.

---

## 3. Report Identity

Every report must include:

- `schemaVersion`
- `reportId`
- `workOrderId`
- `workOrderRevision`
- `projectId`
- `workstreamId`
- `transactionId`
- `decisionId`
- `generatedAt`

These fields bind the report to the exact work order that produced it.

A report for one transaction must never be reused for another.

---

## 4. Execution Identity

The report must identify all relevant agents.

Potential roles:

- bootstrap agent;
- API Parent agent;
- fresh ordinary agent;
- Sol design specialist;
- Opus design specialist;
- Sol final implementation reviewer;
- Opus final implementation reviewer;
- remediation reviewers when applicable.

Each agent record should contain:

- agent ID;
- role;
- source where relevant;
- model where known;
- status;
- verdict where applicable.

If a specialist was required but failed a mode gate, the report must say so explicitly.

Do not silently treat Parent synthesis as independent specialist review.

---

## 5. Source-State Confirmation

The report must record the repository state Cursor actually verified.

At minimum:

- repository;
- canonical main SHA observed;
- source/base branch;
- source/base tip SHA observed;
- working branch;
- starting working-branch SHA if applicable;
- whether the work order’s expected pins matched.

If pinned source state did not match:

- implementation must not proceed unless the work order explicitly allows reconciliation;
- report terminal result should reflect precheck blocking.

---

## 6. Change Summary

The report must summarize:

- files changed;
- executable/product files changed;
- test files changed;
- browser/evidence files changed;
- documentation/metadata files changed;
- whether product state machine changed;
- whether persisted schema changed;
- whether protected semantics changed;
- whether scope expanded.

For significant changes, include a concise human-readable summary.

Do not claim `NO` merely because a change was unintended; report actual state.

---

## 7. Requirement Results

Each work-order requirement should have a result.

For every requirement:

- requirement ID;
- status;
- summary;
- evidence references;
- blocker status if failed.

Allowed statuses:

- `PASS`
- `FAIL`
- `PARTIAL`
- `NOT_RUN`
- `NOT_APPLICABLE`
- `BLOCKED`

A requirement may not be marked PASS solely because a related test suite passed if the test does not actually prove the requirement.

---

## 8. Test Results

The report must record all required verification commands.

For each command:

- command;
- category;
- result;
- exit code when available;
- passed/failed/skipped counts when available;
- warning summary;
- artifact/evidence reference when applicable.

Categories may include:

- focused;
- domain;
- full;
- typecheck;
- lint;
- build;
- provenance;
- policy/self-check;
- other.

Do not compress a failed command into an overall PASS.

---

## 9. Browser Verification

When browser verification is required, report:

- method;
- executable SHA under test;
- browser verdict;
- viewports;
- personas;
- journeys;
- criterion results;
- route assertions;
- mobile bounding/touch results;
- console/network error handling;
- evidence artifact paths/hashes.

Supported browser verdicts may include:

- `PASS_NATIVE_COMPUTERUSE`
- `PASS_PARENT_PLAYWRIGHT_FALLBACK`
- `PASS_PARENT_PLAYWRIGHT_CHROMIUM`
- `FAIL_APPLICATION`
- `BLOCKED_INFRASTRUCTURE`
- `INVALID_EVIDENCE`
- `NOT_REQUIRED`

If fallback was used, report exact reason.

A browser journey should not be called click-bound if direct navigation bypassed the interaction being certified.

---

## 10. Specialist Reviews

Each specialist review record should include:

- agent ID;
- specialist role;
- model;
- mode where applicable;
- review round;
- verdict;
- blocker count;
- findings summary;
- whether the review targeted the final executable SHA.

Allowed verdicts include:

- `PASS`
- `CHANGES_REQUIRED`
- `DRAFT_COMPLETE`
- `DESIGN_READY`
- `MODE_GATE_BLOCKED`
- `BLOCKED`
- `NOT_RUN`

For final certification, a required specialist review only counts as PASS if:

- the reviewer actually performed the intended review;
- the review targeted the relevant executable/evidence;
- verdict is exactly `PASS`.

---

## 11. Remediation Record

If remediation was allowed, report:

- budget;
- passes used;
- whether exhausted;
- remediation commit(s);
- findings addressed;
- findings remaining;
- whether executable SHA changed after remediation.

If remediation budget was zero or unused, say so explicitly.

If blocking findings remain after the permitted remediation and fresh re-review, the transaction must halt.

---

## 12. Executable and Evidence Binding

For certifiable implementation work, the report must track:

### `FINAL_EXECUTABLE_SHA`

The exact product/test/browser-runner commit certified.

### `EVIDENCE_TIP_SHA`

The later evidence/review metadata tip if applicable.

### Binding checks

Report:

- browser evidence bound to executable SHA yes/no;
- specialist final reviews target executable SHA yes/no;
- post-executable executable diff present yes/no;
- evidence summaries contain both SHAs yes/no.

If executable code changes after the supposed freeze:

- prior certification evidence is stale;
- report must not claim ready status without recertification.

---

## 13. Historical Provenance

When the work order requires preservation of a previously accepted historical stage/release, report:

- historical artifact name;
- accepted executable SHA;
- acceptance commit SHA;
- result;
- whether historical state was altered.

A later repository HEAD must not be substituted for the accepted historical boundary.

---

## 14. Blockers

Every unresolved blocker must be explicit.

For each blocker:

- ID;
- severity;
- class;
- summary;
- evidence;
- whether it blocks terminal acceptance;
- whether human judgment is required;
- recommended next legal action when appropriate.

Recommended classes:

- product;
- test;
- browser evidence;
- documentation;
- cosmetic/historical;
- human product decision;
- infrastructure/control plane;
- policy;
- other.

Do not downgrade blockers merely to reach a preferred terminal verdict.

---

## 15. Deferred Findings

Nonblocking findings discovered during the transaction should be reported separately from blockers.

Each deferred finding should include:

- ID;
- summary;
- reason deferred;
- suggested backlog destination;
- whether it was already known/deferred before this transaction.

Do not silently implement deferred scope unless authorized.

---

## 16. PR / Git State

The report must state:

- branch pushed yes/no;
- remote branch name;
- branch tip SHA;
- PR creation allowed/required;
- PR state;
- PR number;
- PR URL;
- merge state;
- whether merge was attempted.

Allowed PR states may include:

- `NOT_APPLICABLE`
- `NOT_OPENED`
- `NOT_OPENED_PENDING_USER_APPROVAL`
- `OPEN`
- `DRAFT`
- `CLOSED`
- `MERGED`

Do not fabricate PR identifiers.

---

## 17. Completion State

Every report must include one exact `terminalVerdict`.

The verdict must be one of the work order’s allowed terminal verdicts.

Examples:

- `UX_WAVE1_VERIFICATION_READY_FOR_REVIEW`
- `UX_WAVE1_VERIFICATION_BLOCKED`
- `PRECHECK_BLOCKED`
- `POSTMERGE_FAILED`

The report must also classify the result as:

- `READY`
- `ACCEPTED`
- `BLOCKED`
- `FAILED`
- `NOOP`

The human-readable summary may explain the verdict, but Radio uses the structured value.

---

## 18. Recommended Next Action

Cursor may recommend the next legal action, but this recommendation is advisory.

Examples:

- open PR;
- request human approval;
- create new recovery transaction;
- wait;
- no further action.

Radio/Sol decides the actual next action after policy evaluation.

Cursor must not create an unauthorized recovery transaction merely because it recommends one.

---

## 19. Report Integrity

The report should include self-integrity metadata:

- schema version;
- generated time;
- source work-order ID/revision;
- report hash when Radio later implements canonical hashing;
- evidence artifact references;
- state snapshot/fingerprint when available.

Radio should validate:

- schema;
- work-order identity;
- transaction identity;
- branch/SHA consistency;
- required report fields;
- terminal verdict allowlist.

---

## 20. Human-Readable Report

A human-readable completion report may accompany the structured JSON.

During the transition period, Cursor prompts must continue to require:

> Return the entire final completion report inside exactly one fenced `text` code block. Nothing before it. Nothing after it. No nested fences. One contiguous block.

The human-readable report should contain the same facts as the structured report.

If human-readable prose conflicts with structured fields, Radio should treat the report as inconsistent and require reconciliation rather than guessing.

---

## 21. Bootstrap Completion Report

For `FRESH_API_CREATED_PARENT_AUTO_REQUIRED`, the bootstrap agent returns a narrow handoff report containing:

- bootstrap agent ID;
- actual API Parent agent ID;
- Parent URL/run ID if available;
- source `api`;
- Parent model/default identity;
- starting ref;
- work branch;
- custom specialist configuration;
- whether bootstrap implemented product work;
- whether bootstrap opened PR;
- Parent status;
- handoff terminal marker.

The bootstrap report is not the final product completion report.

The actual API Parent must later return the transaction completion report.

---

## 22. Ordinary Agent Completion Report

For `FRESH_ORDINARY_AGENT_REQUIRED`, the same schema applies, but:

- bootstrap agent may be absent;
- Parent agent may be absent;
- specialist arrays may be empty;
- ordinary-agent identity must be recorded.

Do not invent specialist review results for an ordinary-agent transaction.

---

## 23. Reused-Agent Completion Report

For `REUSE_CURRENT_AGENT`:

- report the reused agent ID;
- report original transaction ID;
- report current work-order ID;
- report whether the action consumed remediation budget;
- report exactly what changed since the previous report.

A reused agent cannot reset exhausted transaction authority.

---

## 24. Report Repair

If a worker completed execution but the report is malformed or missing required fields, a narrowly scoped `REPORT_REPAIR` work order may be used when policy permits.

Report repair must:

- be read-only unless explicitly required;
- not alter executable product state;
- reconstruct facts from repository/evidence;
- never invent missing evidence;
- clearly distinguish observed fact from unavailable data.

---

## 25. Precheck-Blocked Report

If source-state verification fails before implementation, the report should include:

- expected branch/SHA;
- observed branch/SHA;
- mismatch;
- no implementation performed;
- no remediation consumed;
- terminal verdict such as `PRECHECK_BLOCKED`.

This is a valid completion outcome.

---

## 26. Invalid Evidence

If the worker detects that prior evidence does not actually certify the claimed executable or journey:

- report it;
- classify browser/evidence verdict accordingly;
- do not preserve a false PASS for continuity.

Verification integrity outranks cosmetic green status.

---

## 27. No-Silent-Reconciliation Rule

If the work order expected:

`base tip = X`

but repository state is:

`base tip = Y`

the report must not pretend X was used.

Either:

- stop at precheck; or
- follow an explicit work-order rule permitting reconciliation and report the exact reconciled state.

---

## 28. Completion Report Validation Sequence

Radio should validate a report in this order:

1. JSON/schema validity;
2. work-order identity;
3. project/workstream/transaction identity;
4. allowed terminal verdict;
5. source branch/SHA consistency;
6. agent identity;
7. required command/gate coverage;
8. browser evidence requirements;
9. specialist requirements;
10. remediation accounting;
11. executable/evidence SHA binding;
12. PR/Git state;
13. blocker/terminal-result consistency.

If validation fails, Radio should not send the report to Sol as if it were trustworthy completion evidence.

---

## 29. Terminal Consistency Rules

Examples:

### READY/ACCEPTED cannot coexist with:

- required final reviewer `CHANGES_REQUIRED`;
- unresolved acceptance-blocking P0/P1 finding;
- failed required test;
- invalid browser evidence;
- executable/evidence SHA mismatch;
- required source precheck failure.

### BLOCKED should include:

- at least one blocker or explicit authority/policy exhaustion reason.

### NOOP should include:

- evidence that the requested external action had already completed or was unnecessary.

---

## 30. Example Structured Completion

```json
{
  "schemaVersion": "1.0",
  "reportId": "cr-20260829-014",
  "workOrderId": "wo-20260829-001",
  "workOrderRevision": 1,
  "projectId": "cyber-assurance-demo",
  "workstreamId": "ux-wave1",
  "transactionId": "ux-wave1-verification-integrity",
  "decisionId": "dec-20260829-009",
  "resultClass": "READY",
  "terminalVerdict": "UX_WAVE1_VERIFICATION_READY_FOR_REVIEW",
  "repositoryState": {
    "workingBranch": "cursor/ux-wave1-verification-integrity",
    "finalExecutableSha": "abc123",
    "evidenceTipSha": "def456"
  },
  "reviews": {
    "solFinalVerdict": "PASS",
    "opusFinalVerdict": "PASS"
  },
  "blockers": []
}
```

The actual schema contains additional required fields.

---

## 31. One-Sentence Contract

> **A Cursor completion report is the evidence-bearing, machine-readable record of what the Cursor factory actually executed, verified, reviewed, changed, and concluded for one immutable Radio work order.**
