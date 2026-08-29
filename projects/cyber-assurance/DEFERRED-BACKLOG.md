# DEFERRED-BACKLOG.md

**Project:** Cyber Assurance Demo  
**Purpose:** Explicit record of recognized work that is intentionally not active  
**Status:** Active

> Deferred does not mean forgotten or rejected. It means the work is intentionally outside the current execution scope until its resume condition is met.

---

## Backlog Policy

The orchestrator must not start a deferred item merely because it seems useful.

A deferred item may resume only when:

- its documented resume condition is satisfied; and
- any required human approval has been obtained.

If active work uncovers a deferred item:

1. record evidence;
2. classify whether it blocks the current objective;
3. if it does not block the current objective, leave it deferred;
4. do not expand scope opportunistically.

---

## DEF-001 — Wave 2 persona-aware dashboard redesign

**Status:** DEFERRED  
**Priority when resumed:** HIGH  
**Resume condition:** Wave 1 accepted and explicitly advanced to Wave 2

**Scope**

- stronger persona-specific dashboard emphasis;
- “your work” / role-relevant queues;
- persona-aware attention presentation;
- role-specific dashboard summaries;
- potentially persona-sensitive navigation emphasis.

**Why deferred**

Wave 1 is still closing foundational action-truth and verification-integrity issues. Persona-dashboard redesign should not begin on top of uncertified action guidance.

**Related audit themes**

- role relevance
- persona scope
- exception-driven work
- reduced cognitive load

---

## DEF-002 — Generic mobile card queues

**Status:** DEFERRED  
**Priority when resumed:** HIGH  
**Resume condition:** Wave 1 accepted; mobile queue redesign approved

**Scope**

- mobile-first evidence queue cards;
- mobile-first controls queue cards;
- collapsed secondary filters;
- decision-critical fields surfaced without horizontal table hunting;
- consistent touch-target treatment.

**Why deferred**

Wave 1 mobile work is currently limited to surfaces necessary for action-truth acceptance. A broad queue redesign is larger product scope.

---

## DEF-003 — Real automated email escalation

**Status:** DEFERRED  
**Priority when resumed:** HIGH  
**Resume condition:** Explicit human product approval plus production-capable event/state design

**Desired behavior**

Potential future automation for:

- overdue evidence reminders;
- SLA breach notifications;
- escalation to appropriate owners/managers;
- policy-driven reminder cadence.

**Current truth**

The demo does not send real email.

**Required before implementation**

- authoritative event model;
- recipient/ownership model;
- policy configuration;
- sent-event audit trail;
- retry/error handling;
- production messaging provider decision;
- privacy/residency assessment.

**Do not**

Claim that email was sent until recorded execution state proves it.

---

## DEF-004 — External intervention record

**Status:** DEFERRED  
**Priority when resumed:** MEDIUM  
**Resume condition:** Explicit product decision after core workflow UX is stable

**Concept**

Allow a user to record an outside-platform management intervention, for example:

- call;
- meeting;
- in-person follow-up;
- director escalation.

Potential fields:

- intervention type;
- person contacted;
- date/time;
- outcome;
- recovery commitment;
- follow-up date.

**Why deferred**

The current requirement is only to distinguish outside-platform actions truthfully. Persisting those interventions is a separate product feature.

---

## DEF-005 — Next-issue / continue-work navigation

**Status:** DEFERRED  
**Priority when resumed:** MEDIUM  
**Resume condition:** Wave 1 accepted and closure/queue workflow prioritized

**Concept**

After completing an action, guide the user to:

- next blocking item;
- next overdue request;
- next control awaiting their role;
- next review item.

**Why deferred**

Useful for operational throughput, but not required to close current action-truth work.

---

## DEF-006 — Dashboard metric rationalization

**Status:** DEFERRED  
**Priority when resumed:** MEDIUM  
**Resume condition:** Wave 1 accepted; dashboard Wave 3/assurance work approved

**Scope**

- reconcile lower dashboard denominators/counts;
- demote non-actionable metric tiles;
- make actionable tiles interactive where useful;
- reduce reporting-only volume;
- further tighten mobile dashboard length.

**Related audit items**

- UX-007
- UX-008
- UX-029

**Why deferred**

Primary action-first hierarchy has already been established. Lower-level metric rationalization is a later assurance/clarity pass.

---

## DEF-007 — Review rationale / audit closure hardening

**Status:** DEFERRED  
**Priority when resumed:** MEDIUM-HIGH  
**Resume condition:** Wave 1 accepted; review-workflow enhancement approved

**Scope**

- require or strongly prompt rationale for approval/closure;
- clearer confirmation before final audit closure;
- stronger review attribution;
- reviewer identity/date consistency;
- richer handoff after decisions.

**Related audit items**

- UX-011
- UX-012
- UX-026

**Why deferred**

Current Wave 1 is focused on action truth and trust in attention/workflow guidance, not redesigning review semantics.

---

## DEF-008 — AI review provenance and explainability

**Status:** DEFERRED  
**Priority when resumed:** MEDIUM  
**Resume condition:** Wave 1 accepted; AI Review enhancement approved

**Scope**

Potential additions:

- provider/model identity;
- generated-at timestamp;
- evidence/submission version analyzed;
- eligibility explanation;
- why some requests were/weren’t assessed;
- clearer AI-vs-human decision boundary.

**Related audit items**

- UX-016
- UX-017

**Why deferred**

The current simulated-AI demo is sufficient for MVP behavior. Provenance UX is useful but not required for Wave 1 acceptance.

---

## DEF-009 — `generatedByAI` semantic redesign

**Status:** DEFERRED  
**Priority when resumed:** LOW-MEDIUM  
**Resume condition:** Explicit product semantics decision

**Current behavior**

An AI-originated write-up may remain `generatedByAI=true` after human edits.

**Open question**

Should the flag mean:

- originally generated by AI;
- currently AI-authored;
- AI-assisted at any point;
- something else?

**Why deferred**

Changing it incidentally risks introducing misleading semantics without a clear product definition.

---

## DEF-010 — Control Owner acceptance queue

**Status:** DEFERRED  
**Priority when resumed:** HIGH  
**Resume condition:** Wave 1 accepted; Wave 4 structural workflow work approved

**Concept**

Provide a dedicated Control Owner work queue for evidence awaiting accept/rework decisions.

**Why valuable**

This could reduce dependence on generic evidence lists and make role-specific work much clearer.

**Why deferred**

It is structural product expansion beyond the current Wave 1 recovery scope.

---

## DEF-011 — Row-level persona actions

**Status:** DEFERRED  
**Priority when resumed:** MEDIUM-HIGH  
**Resume condition:** Persona/work-queue redesign approved

**Concept**

Provide appropriate direct actions from queue/list rows where safe, rather than requiring every action to begin on a detail page.

**Examples**

- review submitted evidence;
- open rework-required request;
- open QA review;
- open Audit review.

**Why deferred**

Requires broader interaction-design and authorization review.

---

## DEF-012 — AI-vs-human override linkage

**Status:** DEFERRED  
**Priority when resumed:** MEDIUM  
**Resume condition:** AI assurance workflow redesign approved

**Concept**

Explicitly show when a human decision:

- agrees with;
- overrides;
- modifies;
- supersedes

an AI recommendation.

**Why deferred**

The current principle “AI advises; humans decide” is sufficient for MVP. Full provenance/override semantics need a dedicated design.

---

## DEF-013 — Production authentication and RBAC

**Status:** DEFERRED  
**Priority when resumed:** CRITICAL FOR PRODUCTION  
**Resume condition:** Explicit productionization approval

**Scope**

- real authentication;
- production role mapping;
- authorization enforcement;
- session management;
- tenant/user lifecycle;
- audit logging.

**Current truth**

Persona switching is a deterministic demo mechanism, not authentication.

---

## DEF-014 — Database and persistent production state

**Status:** DEFERRED  
**Priority when resumed:** CRITICAL FOR PRODUCTION  
**Resume condition:** Explicit productionization approval

**Scope**

- Postgres or approved database;
- schema design/migrations;
- durable workflow state;
- concurrency;
- transactional integrity;
- backup/restore.

**Current truth**

The MVP uses deterministic/local demo state.

---

## DEF-015 — Production file/object storage

**Status:** DEFERRED  
**Priority when resumed:** CRITICAL FOR PRODUCTION  
**Resume condition:** Explicit productionization approval

**Scope**

- durable evidence file storage;
- malware/content checks as appropriate;
- file metadata/versioning;
- access control;
- retention;
- backup;
- residency.

---

## DEF-016 — KSA-resident production architecture

**Status:** DEFERRED  
**Priority when resumed:** CRITICAL FOR PRODUCTION  
**Resume condition:** Explicit productionization and hosting decision

**Scope**

Production boundary for:

- application;
- database;
- object storage;
- AI inference;
- extraction;
- embeddings/retrieval;
- prompts/responses;
- logs;
- backups.

**Why deferred**

The current Vercel deployment is for demo hosting only.

---

## DEF-017 — Real AI provider integration beyond demo path

**Status:** DEFERRED  
**Priority when resumed:** MEDIUM-HIGH  
**Resume condition:** Production/advanced-demo AI provider decision

**Potential providers**

- OpenAI
- Vertex AI
- OCI
- private/OpenAI-compatible endpoint

**Requirement**

Preserve the existing provider-neutral application abstraction.

---

## DEF-018 — Multi-tenant architecture

**Status:** DEFERRED  
**Priority when resumed:** CRITICAL FOR COMMERCIAL PRODUCTION  
**Resume condition:** Product commercialization / production design approved

**Scope**

- tenant boundaries;
- row/object isolation;
- tenant administration;
- tenant-specific configuration;
- isolation testing;
- residency considerations.

---

## DEF-019 — Operational observability and recovery

**Status:** DEFERRED  
**Priority when resumed:** CRITICAL FOR PRODUCTION  
**Resume condition:** Productionization approval

**Scope**

- monitoring;
- application logs;
- security logs;
- alerting;
- backup/recovery;
- service health;
- incident operations.

---

## DEF-020 — Failure Controller

**Status:** FROZEN  
**Priority when resumed:** UNDETERMINED  
**Resume condition:** Explicit human approval after demonstrated need

**Current state**

Failure Controller design/reference work exists, but implementation was intentionally stopped.

**Reason**

The control-plane effort became disproportionate to immediate product value.

**Instruction**

- do not resume automatically;
- do not weaken the frozen design/spec merely to make it implementable;
- do not merge blocked implementation work;
- leave draft/reference work as reference unless explicitly reactivated.

---

## DEF-021 — Full autonomous next-task orchestration inside Cursor

**Status:** DEFERRED  
**Priority when resumed:** LOW IN PRODUCT REPO  
**Resume condition:** Radio architecture proves this is still necessary

**Concept**

Allow Cursor-side infrastructure to autonomously select the next product issue.

**Why deferred**

Radio is now the preferred orchestration layer. Duplicating high-level orchestration inside the product repository could create competing control planes.

---

## DEF-022 — Radio integration with this project

**Status:** DEFERRED UNTIL CLEAN STOPPING POINT  
**Priority when resumed:** HIGH  
**Resume condition:** Current Cyber Assurance Wave 1 transaction reaches a clean stopping point and Radio v0.1 implementation is explicitly started

**Concept**

Replace the human copy/paste message bus with:

- GPT-5.6 Sol orchestration API;
- persistent project state;
- Cursor launcher/API adapter;
- structured work orders;
- completion-report ingestion;
- policy engine;
- human approval gates.

**Why deferred right now**

Do not interrupt an active Wave 1 recovery transaction to build the factory.

---

## DEF-023 — Multi-project Radio orchestration

**Status:** DEFERRED  
**Priority when resumed:** FUTURE  
**Resume condition:** Radio v0.1 proves reliable on one project/workstream

**Concept**

Use the same Radio engine across projects such as:

- Cyber Assurance
- Bellhop
- future software projects

with separate project brains and state.

**Why deferred**

Radio v0.1 should prove the single-project loop before adding scheduling and concurrency.

---

# Deferred Backlog Maintenance Rules

1. Every deferred item must have a clear resume condition.
2. `FROZEN` is stronger than `DEFERRED`; frozen work requires explicit human reactivation.
3. Do not silently move an item from deferred to active.
4. When an item resumes, create a workstream/transaction and update this file.
5. Keep volatile branch, SHA, agent, and current-run facts in `PROJECT-STATE.json`.
6. If a deferred item becomes obsolete, mark it `CANCELLED` with rationale rather than deleting the history.
