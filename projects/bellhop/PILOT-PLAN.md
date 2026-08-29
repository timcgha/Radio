# PILOT-PLAN.md

**Pilot:** Bellhop Radio Pilot 01  
**Risk profile:** Low  
**Product transaction:** Level 4 Stage 2 Asteroid Garden  
**Goal:** Prove the Radio transport/state/decision loop before allowing autonomous product modification.

---

## 1. Why Bellhop

Bellhop is a good Radio pilot because:

- it is lower risk than the Cyber Assurance product;
- the code has deterministic gameplay tests;
- the game is browser-based and behavior can later be visually checked;
- the current Stage 2 is already technically implemented and awaiting human playtest;
- the first Radio transaction can therefore be read-only.

The pilot should test Radio, not invent new Bellhop scope.

---

## 2. Current Reported Baseline

- Level 3 complete/deployed
- Level 4 Stage 1.5 merged through PR #37
- Stage 1.5 merge SHA: `d1e7f10`
- Stage 1.5 head: `a2fee00`
- Stage 1.5 version: v41
- Stage 2 PR: #39
- Stage 2 branch: `cursor/level4-stage2-asteroid-garden-9dce`
- Stage 2 tip: `aa512d6`
- Stage 2 version: v42
- CI reported green
- deterministic baseline: 1660 passed / 32 suites
- build check reported PASS
- Stage 2 not merged/deployed

Repository: `https://github.com/timcgha/Bellhop`

Before any live execution Radio must verify repository reachability and the expected source pins.

---

## 3. Hard Product Gate

Do not:

- merge Stage 2;
- deploy Stage 2;
- begin Stage 3

until the human Stage 2 playtest occurs.

A technical Radio verification PASS means only:

> Ready for human playtest.

It does **not** mean:

> Ready to merge.

---

## 4. Phase 0 — Dry Run

**Cursor execution: OFF**

Input to Radio:

> Independently verify that Bellhop Level 4 Stage 2 is technically ready for its human playtest. Do not change gameplay.

Radio should:

1. load Bellhop project state;
2. build Sol context;
3. obtain a structured Sol decision;
4. validate `decision.schema.json`;
5. evaluate deterministic policy;
6. generate a Cursor work order;
7. validate `cursor-work-order.schema.json`;
8. render the prompt;
9. STOP BEFORE CURSOR LAUNCH.

Expected decision:

- `LAUNCH_CURSOR`
- `FRESH_ORDINARY_AGENT_REQUIRED`
- `VERIFICATION`
- one agent
- zero remediation
- no specialists
- no product edits
- no PR/merge/deploy

Compare Radio's generated work order with `PILOT-WORK-ORDER.json`.

### Dry-run pass criteria

- correct Bellhop context selected;
- no Cyber Assurance product context leaks into the work order;
- repository uncertainty is handled by a precheck rather than fabricated;
- Stage 2 pins are represented;
- Stage 1.5 flight is protected;
- Stage 3/deferred mechanics are excluded;
- human playtest gate is preserved;
- policy returns ALLOW for the read-only verification transaction;
- execution remains disabled.

---

## 5. Phase 1 — First Live Radio Transmission

Run only after Phase 0 review passes.

**Cursor execution: ON**

Radio launches:

- one fresh ordinary Cursor agent;
- no specialist delegation;
- no remediation.

The agent should:

1. verify repository identity;
2. verify branch/tip;
3. run `node tests/run.js`;
4. run `node build.js`;
5. confirm working-tree cleanliness;
6. make no product changes;
7. return structured completion output.

Radio should then:

1. ingest the completion report;
2. validate it;
3. reconcile branch/SHA facts;
4. append ledger events;
5. update project state;
6. ask Sol for the next legal action;
7. stop at the human playtest boundary.

Expected successful terminal result:

`BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST`

---

## 6. What Phase 1 Is Actually Testing

The important Radio outcomes are:

- no human copy/paste between Sol and Cursor;
- one and only one worker launched;
- exact work order transmitted;
- state survives waiting;
- report is ingested programmatically;
- result is validated rather than trusted blindly;
- no duplicate agent is launched;
- no scope expansion occurs;
- Radio understands a successful technical verification still requires human playtest.

---

## 7. Phase 2 — Controlled Failure Pilot

Do not perform until Phase 1 succeeds.

The next experiment should test a failure path without creating unnecessary product risk.

Good candidates:

- a synthetic stale-SHA work order in Radio's test harness;
- malformed completion report;
- duplicate-launch replay/idempotency test;
- one real bounded Bellhop defect when a naturally occurring bug is available.

The goal is to prove:

`failure → legal decision → bounded response → stop`

not merely the happy path.

---

## 8. Resource Limits

Pilot 1:

- max Cursor agents: 1
- max specialists: 0
- max remediation: 0
- max recovery transactions: 0
- no PR creation
- no merge
- no deploy

Radio should fail closed if a legal next action would require exceeding those limits.

---

## 9. Success Definition

Bellhop itself does not need to change for Pilot 1 to succeed.

Pilot 1 succeeds when:

> Radio correctly coordinates one read-only Cursor verification transaction end to end, updates its own durable state, and returns control to the human at the playtest boundary without the human acting as the message bus.
