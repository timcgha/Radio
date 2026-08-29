# PROJECT-CONTEXT.md

**Project:** Bellhop (working title)  
**Purpose:** Durable Bellhop-specific context for Radio / GPT-5.6 Sol  
**Status:** Radio pilot seed  
**Important:** “Bellhop” is a working title. Do not publish the game or character name without human approval.

---

## 1. Product

Bellhop is a browser-based 3D platformer designed primarily for a six-year-old playing alone or with his dad nearby.

The child-first rule is authoritative:

> If a change would make the game more interesting for an adult and more frustrating for the child, it does not ship.

Practical consequences:

- no reading is required to understand important gameplay;
- no harsh fail state beyond losing a heart and returning to a checkpoint;
- nothing important is timed;
- no inventories, skill trees, crafting, dialogue trees, or menu-heavy systems;
- every gameplay button should produce visible and audible feedback.

---

## 2. Character / Naming

The playable character is a teal enamel bellows-robot with a brass whistle-spout, brass-rimmed goggle eyes, silver concertina torso, and stubby limbs.

The character and game names are not treated as approved public branding.

Internal specs may refer to the character as **Pling**, but public naming requires human approval.

---

## 3. Core Controls — Product Contract

These controls do not change without human approval:

| Input | Action |
|---|---|
| Left stick / WASD / arrows | Move |
| Right stick / drag / Q,E | Camera |
| A / Space | Base levels: jump; again in air for air-puff; hold after puff to float. Level 4 flight extends A as described below. |
| B / J / Shift | Base levels: air-slam in air; gust on ground. |
| Y / K | Spin attack. |

The gust is a signature move and should remain useful across levels.

Do not retune or rebind the standing control contract as incidental implementation work.

---

## 4. General Level Design Principles

New levels should generally:

- show the place off immediately;
- provide something interesting every ~20–30 seconds;
- run roughly 8–15 minutes;
- teach one major new mechanic somewhere safe;
- vary that mechanic several times;
- contain hidden Snoozles;
- include one clever secret;
- include an optional harder challenge;
- build to a climax and then a finish;
- place checkpoints so failure does not erase more than about a minute of progress.

The player should be able to stop and look around without a clock forcing action.

---

## 5. Base Physics

The original land-physics constants were tuned by feel and are regression-sensitive.

Do not change established physics merely because a different value appears cleaner in code.

Physics changes require deliberate playtest-based approval.

Earlier project documentation records the land baseline as:

- SPEED 6.8
- ACC 44
- DEC 60
- AIRACC 20
- GRAV -30
- MAXFALL -32
- JUMPV 10.5
- PUFFV 9.4
- COYOTE 0.12
- BUFFER 0.15
- STEP 0.42
- player radius 0.36
- player height 1.15
- spin duration 0.45s
- spin radius 2.05
- spin cooldown 0.5

Treat the current repository as implementation authority because later levels have added level-scoped mechanics.

---

## 6. Architecture / Build Principles

Historical project documentation established several durable constraints:

- browser-first;
- no install required to play;
- Node is sufficient for build/test tooling;
- procedural geometry is preferred over asset downloads;
- audio is generated through WebAudio rather than samples;
- the built `index.html` should remain self-contained;
- generated `index.html` is committed for direct serving;
- no `localStorage` or `sessionStorage` unless a later explicit decision changes this.

Earlier documentation described a modularization target under `src/` and data-authored `levels/`. The current repository may have evolved beyond the historical file layout; inspect the repository rather than assuming the old snapshot is still exact.

---

## 7. Testing Philosophy

Bellhop cannot be certified by reading diffs alone because many defects are emergent gameplay behaviors.

Standing expectations:

- run tests before commits;
- add assertions for new mechanics;
- investigate whether a failing test represents a game defect or stale test assumption;
- fix stale tests properly rather than deleting them;
- preserve prior-level behavior unless the approved work order says otherwise.

Historical documentation started with a small frame-driven harness. The current Level 4 branch reports a much larger suite. Runtime repository evidence is authoritative for the current command layout and test count.

---

## 8. Level 3 — Established Precedent

Level 3, **The Peak**, established several reusable principles:

- land physics stayed familiar while the new mechanic supplied the level identity;
- lava hurts but does not create a harsh instant-death loop;
- the level is not timer-driven;
- new mechanics are taught safely before being required;
- hazards become inert during the celebration/win sequence;
- the finish and climax are distinct;
- level-specific mechanics should not require shared win code to accumulate level-specific conditionals;
- prior shipped levels are regression-protected during new-level implementation.

Level 3 is reported complete and deployed.

---

## 9. Current Level 4 Direction

Level 4 is the space level.

Current product decisions:

- **Star Beam** is the space laser power-up.
- **Saucers** are enemies.
- **Asteroid contact hurts.**
- The planned finish uses a **black-hole warp tunnel**.
- Planned route landmarks include:
  - Asteroid Garden
  - Candy Planet / Crystal Cavern
  - Saucer Belt
  - Observatory
  - Cheese Moon

The later route is intentionally staged; do not implement deferred landmarks merely because they are already named.

---

## 10. Level 4 Stage 1.5 — Flight Contract

The current flight model is considered product behavior, not an implementation detail.

Preserve:

- **A = thrust**;
- stick forward = climb;
- stick neutral/level = level flight;
- stick back = descend;
- releasing thrust allows coast;
- existing Stage 1.5 flight feel is not to be retuned during Stage 2 verification or unrelated work.

This is the control feel the current Stage 2 was built on.

Any flight retune requires a separate human-approved playtest decision.

---

## 11. Level 4 Stage 2 — Current Asteroid Garden

Reported Stage 2 implementation:

- version: **v42**
- PR: **#39**
- branch: `cursor/level4-stage2-asteroid-garden-9dce`
- tip: `aa512d6`
- target integration branch: `level3`
- PR state: open
- CI: green
- current reported deterministic baseline: **1660 passed / 32 suites**
- build check: pass
- not merged
- not deployed

Stage 2 route/current content:

- Asteroid Garden begins around `(28,5,-26)`;
- temporary endpoint around `(30,5,-140)`;
- 7 static hazard asteroids;
- 1 moving hazard asteroid;
- 8 backdrop asteroids;
- one flying saucer around `(28,6,-118)`;
- Snoozle 1 around `(-2.8,0.55,3.2)`;
- one build-time held note;
- Cheese Moon landmark around `(58,12,-175)` foreshadows later route.

Saucer behavior:

- leashed flying enemy;
- visible attack wind-up about 0.5s;
- cooldown about 2.6s;
- spin can defeat it;
- jump-jet can defeat it;
- B/gust stuns it but does not defeat it.

The exact current repository is authoritative; these values are the seed state Radio should verify rather than blindly trust.

---

## 12. Stage Gate

The Stage 2 gate is explicit:

> Do not merge Stage 2, deploy Stage 2, or begin Stage 3 until the Stage 2 human playtest has occurred.

Radio must preserve this boundary.

A technical verification PASS is not permission to merge or start Stage 3.

---

## 13. Deferred Level 4 Work

Current Stage 2 intentionally does **not** include:

- Star Beam implementation;
- Star Beam crates;
- Candy Planet / Crystal Cavern implementation;
- Saucer Belt / multiple-saucer sequence;
- Observatory;
- later Snoozles;
- black-hole finish;
- later route completion.

Stage 3 is expected to teach Star Beam in the planet sequence, but that work is not active during the pilot.

---

## 14. Radio Pilot Boundary

The first Radio pilot is deliberately low risk.

The pilot may:

- read project/repository state;
- ask Sol for a structured next action;
- validate that decision through policy;
- generate a Cursor work order;
- later launch **one fresh ordinary agent** for read-only technical verification if the dry run is approved;
- run existing tests/build checks;
- verify source pins;
- ingest a structured completion report;
- update project state/ledger;
- stop at the human boundary.

The pilot may not:

- modify gameplay;
- retune flight;
- merge PR #39;
- deploy;
- start Stage 3;
- implement deferred mechanics;
- change Radio policy;
- launch specialist swarms;
- launch more than one equivalent worker.

---

## 15. Authority Order

When sources conflict, use this order:

1. explicit current human instruction;
2. verified current repository/API state;
3. current approved Level 4 workstream decisions;
4. this project context;
5. older level/spec documents.

Old documentation is useful context, not permission to overwrite newer implemented behavior.

---

## 16. Repository

Canonical repository URL supplied by the human product owner:

`https://github.com/timcgha/Bellhop`

Radio should still verify reachability plus the expected branch/SHA pins at runtime before execution.

---

## 17. Pilot Goal

The Bellhop pilot is successful if Radio can correctly turn this project state into a bounded technical-verification transaction, transport the job to Cursor without human copy/paste, ingest the result, and stop without crossing the human playtest/merge boundary.
