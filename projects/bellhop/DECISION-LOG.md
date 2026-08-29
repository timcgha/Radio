# DECISION-LOG.md

**Project:** Bellhop (working title)  
**Purpose:** Durable project decisions a fresh Radio/Sol orchestrator should not casually revisit  
**Status:** Pilot seed

---

## B-001 — Child-first product rule

**Status:** ACTIVE

**Decision**  
When adult challenge/interest conflicts with the six-year-old player's clarity or enjoyment, design in the child's favor.

**Do not**  
Increase frustration merely to make the game more conventionally difficult.

---

## B-002 — Public naming is not approved

**Status:** ACTIVE

**Decision**  
“Bellhop” and the character's working/internal names are not approved public branding.

**Consequence**  
Do not publish under those names without human approval.

---

## B-003 — Core controls are a human-approved contract

**Status:** ACTIVE

**Decision**  
The standing move/camera/jump-or-flight/gust-or-slam/spin control contract does not change incidentally.

**Consequence**  
Control remapping or mechanical reinterpretation requires explicit human approval.

---

## B-004 — Gust remains a signature move

**Status:** ACTIVE

**Decision**  
The gust should remain useful and readable across levels rather than becoming obsolete when a new level mechanic appears.

---

## B-005 — No timer-driven pressure as a default

**Status:** ACTIVE

**Decision**  
The child should be free to stop, explore, or play with an interaction without the level advancing a failure clock.

---

## B-006 — Failure should be forgiving

**Status:** ACTIVE

**Decision**  
Normal mistakes should cost a heart/checkpoint recovery rather than harsh instant failure or long replay.

---

## B-007 — Physics tuning requires playtest intent

**Status:** ACTIVE

**Decision**  
Established movement/physics values are feel-sensitive.

**Do not**  
Retune them as incidental cleanup.

---

## B-008 — Test emergent gameplay, not only code structure

**Status:** ACTIVE

**Decision**  
Gameplay changes require behavioral assertions because important Bellhop bugs can look correct in a source diff.

**Consequence**  
Do not delete a failing behavioral test merely to restore green status.

---

## B-009 — Earlier completed levels are regression-protected

**Status:** ACTIVE

**Decision**  
New-level implementation should preserve already-completed level behavior unless the work order explicitly authorizes a cross-level change.

---

## B-010 — Level 4 Stage 1.5 flight contract is frozen for Stage 2

**Status:** ACTIVE

**Decision**  
Preserve:

- A thrust;
- stick forward = climb;
- neutral/level = level flight;
- stick back = descend;
- releasing thrust = coast;
- current flight feel/tuning.

**Do not**  
Retune Stage 1.5 flight during Stage 2 verification or unrelated work.

---

## B-011 — Level 4 major mechanic is Star Beam

**Status:** ACTIVE

**Decision**  
Star Beam is the space laser power-up.

**Current gate**  
It is deferred from Stage 2 and expected to be taught later in the planet sequence.

---

## B-012 — Saucers are the Level 4 enemy family

**Status:** ACTIVE

**Decision**  
Saucers are active enemies rather than ambient decoration.

The first Stage 2 saucer:

- is leashed;
- has a visible ~0.5s attack wind-up;
- uses an approximately 2.6s cooldown;
- can be defeated by spin;
- can be defeated by jump-jet;
- is stunned, not defeated, by B/gust.

---

## B-013 — Asteroid contact hurts

**Status:** ACTIVE

**Decision**  
Asteroids in the hazard path are gameplay hazards, not purely scenic geometry.

---

## B-014 — Stage 2 is the Asteroid Garden slice

**Status:** ACTIVE

**Decision**  
Stage 2 intentionally implements only the Asteroid Garden slice plus foreshadowing.

Reported content:

- 7 static hazard asteroids;
- 1 moving hazard asteroid;
- 8 backdrop asteroids;
- one saucer;
- Snoozle 1;
- one build-time held note;
- Cheese Moon foreshadowing;
- temporary endpoint.

---

## B-015 — Later Level 4 landmarks are not Stage 2 scope

**Status:** ACTIVE

**Decision**  
Candy Planet / Crystal Cavern, Saucer Belt, Observatory, later Snoozles, and the black-hole finish are planned route concepts but remain outside Stage 2.

---

## B-016 — Stage 2 playtest gate precedes merge/deploy/Stage 3

**Status:** ACTIVE

**Decision**  
Do not:

- merge PR #39;
- deploy Stage 2;
- begin Stage 3

until the human Stage 2 playtest occurs.

**Rationale**  
Flight feel and spatial readability require actual play, not only tests.

---

## B-017 — Radio pilot is read-only against product behavior

**Status:** ACTIVE

**Decision**  
The first Bellhop Radio live transaction, after dry-run approval, is technical verification only.

Allowed:

- source-state verification;
- test execution;
- build verification;
- structured completion report;
- state/ledger updates.

Not allowed:

- gameplay edits;
- flight tuning;
- merge;
- deploy;
- Stage 3;
- deferred mechanics.

---

## B-018 — One worker, zero remediation for Pilot 1

**Status:** ACTIVE

**Decision**  
The first live Bellhop Radio verification pilot uses:

- one fresh ordinary Cursor agent;
- no specialist delegation;
- zero remediation passes.

**Rationale**  
The goal is to prove transport/state/report plumbing before testing autonomous repair.

---

## B-019 — Runtime repository state outranks seed assumptions

**Status:** ACTIVE

**Decision**  
The repo URL/default-branch details in this seed package are not fully verified.

Before live execution Radio must discover/verify the real repository and exact source pins.

If the verified state differs materially:

> Stop and regenerate/re-evaluate the work order rather than guessing.
