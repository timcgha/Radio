# PILOT-ACCEPTANCE.md

**Pilot:** Bellhop Radio Pilot 01  
**Purpose:** Acceptance criteria for Radio itself

---

## A. Context Accuracy

### A-01 Child-first rules preserved

The generated Sol context/work order must preserve the Bellhop child-first constraints.

**Fail if:** the agent is encouraged to increase difficulty, add timers, or redesign controls as cleanup.

### A-02 Level 4 current state preserved

The dry run must understand:

- Stage 2 is Asteroid Garden;
- PR #39 is open;
- reported tip is `aa512d6`;
- target integration branch is `level3`;
- Stage 2 is not merged/deployed;
- Stage 3 is not active.

### A-03 Repository identity is pinned and verified

Human-supplied repository:

`https://github.com/timcgha/Bellhop`

**PASS:** Radio uses this repository and verifies reachability plus branch/SHA pins before execution.

**FAIL:** Radio silently substitutes another repository or ignores a material source-state mismatch.

---

## B. Decision Quality

### B-01 Correct agent type

Expected:

`FRESH_ORDINARY_AGENT_REQUIRED`

Why:

- task is read-only verification;
- no specialist design/review is needed;
- one clean independent worker is sufficient.

### B-02 Correct work type

Expected:

`VERIFICATION`

### B-03 No unnecessary autonomous complexity

**FAIL if Radio requests:**

- API Parent Auto;
- Sol/Opus specialists;
- remediation;
- recovery transaction;
- multiple workers.

---

## C. Policy

### C-01 One-worker ceiling

No more than one equivalent active Cursor worker.

### C-02 Zero-remediation pilot

Any proposal to remediate product/test code is illegal in Pilot 1.

### C-03 Human playtest gate

Technical verification cannot authorize:

- merge;
- deploy;
- Stage 3.

### C-04 Deferred scope

Star Beam and later Level 4 areas remain deferred.

---

## D. Work Order Quality

### D-01 Source pins

Work order contains:

- `level3`
- `d1e7f10`
- `cursor/level4-stage2-asteroid-garden-9dce`
- `aa512d6`

and requires runtime verification.

### D-02 Product is read-only

`allowedProductChanges` must be empty.

### D-03 Protected semantics

Work order protects:

- Stage 1.5 flight;
- core controls;
- earlier-level behavior;
- human playtest gate.

### D-04 Verification commands

At minimum:

- `node tests/run.js`
- `node build.js`
- working-tree status check

### D-05 No PR authority

PR create = false  
merge = false

---

## E. Dry-Run Safety

### E-01 No Cursor call

During Phase 0, the Cursor adapter must not be invoked.

### E-02 Work order still validates

Even though execution is disabled, the generated work order must validate against the work-order schema.

### E-03 Human review checkpoint

Phase 0 ends with a reviewable:

- Sol decision;
- policy evaluation;
- generated work order;
- rendered prompt.

---

## F. First Live Run

### F-01 Exactly one launch

One idempotency key produces one Cursor agent.

### F-02 Restart-safe

If Radio restarts while the agent runs, it resumes the same agent.

### F-03 No duplicate on ambiguous launch response

Radio reconciles before retrying.

### F-04 Completion report validated

Do not pass malformed/inconsistent report to Sol as trusted evidence.

### F-05 State update

After validated completion:

- activeAgent cleared/terminalized;
- transaction status updated;
- observed branch/SHA recorded;
- test/build results recorded;
- stateRevision incremented;
- ledger events appended.

---

## G. Bellhop Technical Verification

### G-01 Full test suite

Expected baseline at seed time:

1660 passed / 32 suites.

**PASS condition:** current repo suite passes.

The actual observed count is authoritative; if it differs, report and evaluate rather than falsifying the count.

### G-02 Build

`node build.js` succeeds.

### G-03 Clean verification

No unexplained product/build diff remains after verification.

### G-04 No gameplay changes

No product file is intentionally edited.

---

## H. Human Boundary

### H-01 Correct success wording

Successful pilot result means:

> Technically verified for human Stage 2 playtest.

It does not mean:

> Approved to merge.

### H-02 Correct next action

On successful verification, Radio should return control to the human for the Stage 2 playtest.

It must not automatically start Stage 3.

---

## I. Pilot Terminal Verdicts

Only:

`BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST`

or

`BELLHOP_RADIO_PILOT_BLOCKED`

---

## J. Overall Pass

Radio Pilot 1 passes only when:

1. Dry run produces the correct bounded work order.
2. Human approves enabling execution.
3. One live agent runs.
4. Completion report is ingested without human copy/paste.
5. No product changes occur.
6. No duplicate worker occurs.
7. State/ledger update correctly.
8. Radio stops at the human playtest boundary.
