# DEFERRED-BACKLOG.md

**Project:** Bellhop (working title)  
**Purpose:** Explicit “not now” scope for the Radio pilot and current Level 4 stage

---

## DEF-B-001 — Merge PR #39

**Status:** DEFERRED  
**Resume condition:** Human Stage 2 playtest completed and human approves merge

Do not merge merely because tests/build verification are green.

---

## DEF-B-002 — Deploy Level 4 Stage 2

**Status:** DEFERRED  
**Resume condition:** Stage 2 playtest completed, merge approved/completed, deployment separately approved

---

## DEF-B-003 — Stage 3

**Status:** DEFERRED  
**Resume condition:** Stage 2 playtest completed and human explicitly starts Stage 3

Stage 3 is expected to teach Star Beam in the planet sequence.

---

## DEF-B-004 — Star Beam implementation

**Status:** DEFERRED  
**Resume condition:** Stage 3 begins

Includes:

- Star Beam power behavior;
- Star Beam shooting;
- Star Beam presentation;
- Star Beam-specific tests.

---

## DEF-B-005 — Star Beam crates

**Status:** DEFERRED  
**Resume condition:** Stage 3 design/implementation authorizes them

Do not add crates to Stage 2 as convenience.

---

## DEF-B-006 — Candy Planet / Crystal Cavern

**Status:** DEFERRED  
**Resume condition:** Later Level 4 route stage explicitly begins

This is a planned later route/interior sequence, not part of Asteroid Garden verification.

---

## DEF-B-007 — Saucer Belt / multiple saucers

**Status:** DEFERRED  
**Resume condition:** Later Level 4 route stage explicitly begins

Current Stage 2 contains one saucer only.

---

## DEF-B-008 — Observatory

**Status:** DEFERRED  
**Resume condition:** Later Level 4 route stage explicitly begins

---

## DEF-B-009 — Later Snoozles

**Status:** DEFERRED  
**Resume condition:** Their route areas are explicitly implemented

Current Stage 2 includes Snoozle 1 only.

---

## DEF-B-010 — Black-hole warp-tunnel finish

**Status:** DEFERRED  
**Resume condition:** Final Level 4 route/finish stage begins

The concept is approved; implementation is not current scope.

---

## DEF-B-011 — Flight retuning

**Status:** FROZEN FOR CURRENT PILOT  
**Resume condition:** Human playtest explicitly identifies a flight-feel change

Do not adjust thrust, climb/level/descent mapping, coast, or related tuning during Radio verification.

---

## DEF-B-012 — Public naming/branding

**Status:** FROZEN  
**Resume condition:** Human explicitly approves the game/character names for public use

---

## DEF-B-013 — Radio autonomous remediation on Bellhop

**Status:** DEFERRED  
**Resume condition:** Read-only Pilot 1 completes successfully and a separate failure/remediation pilot is approved

The first live pilot has remediation budget 0.

---

## DEF-B-014 — Radio specialist swarm on Bellhop

**Status:** DEFERRED  
**Resume condition:** A future task genuinely requires specialist delegation

The first live pilot should use one fresh ordinary agent.

---

## DEF-B-015 — Autonomous PR open/merge

**Status:** DEFERRED  
**Resume condition:** Radio pilot maturity increases and human explicitly changes approval policy

For this pilot:

- no PR creation;
- no merge;
- no deployment.

---

# Maintenance Rule

If the pilot discovers an adjacent product issue:

1. record it;
2. determine whether it blocks verification;
3. do not fix it during Pilot 1;
4. return it to the human as a finding or future work item.
