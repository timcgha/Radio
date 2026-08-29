# DECISION-LOG.md

**Project:** Cyber Assurance Demo  
**Purpose:** Durable record of settled product, UX, workflow, architecture, and delivery decisions  
**Status:** Active  
**Rule:** Record decisions here when future agents would benefit from knowing not only *what* was decided, but *why*. Do not use this file for volatile branch/SHA/task status.

---

## D-001 — Human decisions remain authoritative

**Status:** ACTIVE  
**Date:** 2026-08-29

**Decision**  
The product-development system may automate planning, implementation, verification, remediation, and recovery within approved bounds, but product direction and consequential scope decisions remain human-owned.

**Rationale**  
Automation should remove message transport and repetitive coordination, not replace product judgment.

**Consequence**  
Autonomous agents may proceed through approved implementation loops, but material product changes, major architecture changes, deferred-scope activation, merge approval, and production release require human approval unless explicitly delegated later.

**Do not**  
Treat autonomous completion as equivalent to product-owner approval.

---

## D-002 — Product workflow is multi-role and human-decided

**Status:** ACTIVE

**Decision**  
The core workflow remains:

Draft RFI → Evidence Collection → Control Owner Review → Compliance QA → Internal Audit → Closed.

AI may explain, analyze, draft, and interpret. Humans make workflow decisions.

**Rationale**  
The product is an evidence-assurance workflow, not an autonomous compliance engine.

**Consequence**  
AI outputs must remain advisory. Control Owner, QA, and Audit decisions remain explicit human actions.

**Do not**  
Allow AI to silently accept evidence, approve a control, or close audit work.

---

## D-003 — Evidence-request status and control status are independent

**Status:** ACTIVE

**Decision**  
Evidence-request status and control workflow status are separate state concepts.

Evidence-request statuses include:

- draft
- requested
- in_progress
- submitted
- accepted
- rework_required

**Rationale**  
A control may depend on multiple evidence requests in different states.

**Consequence**  
Control progression must be derived from the state of required evidence requests rather than from one shared status field.

**Do not**  
Collapse request state and control state into one generic status.

---

## D-004 — Optional evidence never blocks control progression

**Status:** ACTIVE

**Decision**  
A control may move from Evidence Collection to Control Owner Review only when all **required** evidence requests are accepted. Optional requests do not block progression.

**Rationale**  
Optional evidence is useful context, not a mandatory workflow gate.

**Do not**  
Treat incomplete optional evidence as a blocking condition.

---

## D-005 — “Accepted evidence” does not mean “compliant control”

**Status:** ACTIVE

**Decision**  
“Accepted evidence” means the Control Owner accepted an artifact into the evidence package.

It does not mean the control is compliant, effective, or approved.

**Rationale**  
Evidence acceptance and control assurance are separate decisions.

**Consequence**  
Compliance QA and Internal Audit still make independent control-level decisions.

---

## D-006 — Full RFI authoring is a nine-field model

**Status:** ACTIVE

**Decision**  
The RFI model contains:

1. title
2. purpose
3. requested artifact/evidence
4. acceptance criteria
5. preferred format
6. evidence period
7. required/optional
8. assigned owner
9. due date

**Rationale**  
Evidence requests must be sufficiently specific to reduce ambiguity and rework.

**Consequence**  
Draft RFIs may be fully edited. Once issued, silent overwrite is not acceptable without an explicit amendment mechanism.

---

## D-007 — Provider-neutral AI abstraction

**Status:** ACTIVE

**Decision**  
Application-level AI behavior remains provider-neutral.

Core functions include:

- `explainEvidenceRequest()`
- `analyzeEvidence()`
- `generateControlWriteup()`
- `interpretAuditComment()`

**Rationale**  
The product may need to run against different providers or within a KSA-hosted boundary.

**Consequence**  
Business logic should not depend directly on one model vendor.

---

## D-008 — Deployment portability is a product constraint

**Status:** ACTIVE

**Decision**  
The application architecture should remain portable across standard Next.js/Node hosting, Docker, Postgres, object storage, REST/API services, and environment-based configuration.

**Rationale**  
The demo may later move to a KSA-resident cloud or client environment.

**Do not**  
Introduce unnecessary Vercel-specific business logic.

---

## D-009 — Data residency applies to the full processing chain

**Status:** ACTIVE

**Decision**  
Future residency requirements apply not only to application hosting but also to:

- database
- files
- extraction
- embeddings/retrieval
- prompts/responses
- logs
- backups

**Rationale**  
A “KSA-hosted app” is not sufficient if sensitive data leaves the boundary elsewhere.

---

## D-010 — Dashboard metrics must drive intervention

**Status:** ACTIVE

**Decision**  
The guiding principle is:

> A metric without a decision or action attached to it is reporting. A metric that tells the user where to intervene is a product.

**Rationale**  
The dashboard should help decision-makers understand where action is needed within seconds.

**Consequence**  
Primary dashboard hierarchy is intervention-first rather than report-first.

---

## D-011 — Dashboard hierarchy is Action → Health → Diagnosis → Detail

**Status:** ACTIVE

**Decision**  
Dashboard content should prioritize:

1. Action
2. Health
3. Diagnosis
4. Detail

“Needs your attention” is the primary intervention layer.

**Rationale**  
Decision-makers need to understand what requires attention before consuming lower-level reporting.

---

## D-012 — Preserve intervention intent across screens

**Status:** ACTIVE

**Decision**  
Once a user chooses an intervention, downstream screens should preserve that intent.

**Rationale**  
Users should not need to remember why they clicked.

**Consequence**  
Drilldowns should retain the selected attention condition and present results before generic filter controls.

---

## D-013 — Visual hierarchy follows a four-level budget

**Status:** ACTIVE

**Decision**  
Use:

- Level 1 — immediate decision/action
- Level 2 — current problem/status
- Level 3 — diagnostic/supporting information
- Level 4 — optional/reference/configuration

Visual hierarchy should use size, weight, contrast, position, whitespace, grouping, and repetition.

**Rationale**  
The visually dominant element should correspond to the next thing the user needs to understand or do.

---

## D-014 — Overdue evidence and workflow SLA are separate concepts

**Status:** ACTIVE

**Decision**  
Do not merge overdue evidence requests and workflow SLA breaches.

**Rationale**  
They measure different failure modes:

- overdue evidence = explicit due date missed
- workflow SLA = too much time spent in an assessment workflow stage

**Consequence**  
They remain separate dashboard interventions and drilldowns.

**Do not**  
Create one generic “late work” metric.

---

## D-015 — Workflow SLA should be expressed in control/stage language

**Status:** ACTIVE

**Decision**  
Workflow-SLA messaging should be control/stage oriented, even when the current Evidence Collection calculation is derived from request-level aging.

**Rationale**  
The management question is which controls are stuck in the workflow.

**Known limitation**  
Evidence Collection control SLA is currently inferred from request-level time-in-status. A true control-stage timer is deferred.

---

## D-016 — Use “+9%” rather than “+9 pp” in the demo UI

**Status:** ACTIVE

**Decision**  
The visible dashboard variance uses `+9%` rather than `+9 pp`.

**Rationale**  
The audience may include users for whom English is a second language, and `%` is more immediately understandable in the demo context.

**Note**  
This is a presentation decision, not a mathematical claim that percentage and percentage points are identical.

---

## D-017 — Factual attention is separate from role-specific action

**Status:** ACTIVE

**Decision**  
The system must distinguish:

1. factual attention condition — what is objectively wrong;
2. role-specific action — what this persona should/can do now;
3. exact action target — which entity the action is authorized for.

**Rationale**  
A fact may remain true after responsibility moves downstream.

**Example**  
A request may still be historically overdue after submission, but the current Control Owner action is review, not chasing the Evidence Owner.

---

## D-018 — Action candidates must be atomic

**Status:** ACTIVE

**Decision**  
For enabled in-platform actions, authorization and target identity must be derived from the same action candidate.

**Rationale**  
Authorization from request A must never generate a CTA to request B.

**Consequence**  
Positive tests must prove:

- gate allowed;
- exact request/entity ID;
- href target;
- destination capability;
- same persona/state authorization.

---

## D-019 — Three action types must be visibly distinct

**Status:** ACTIVE

**Decision**  
Recommended actions are classified as:

- `in_platform`
- `external_follow_up`
- `automated_system`

**Rationale**  
The user must never be uncertain whether something is done automatically, inside the platform, or by a human outside the platform.

**Consequence**  
External management actions are legitimate recommendations but must be labeled as outside-platform activity.

---

## D-020 — Do not claim automated escalation events without proof

**Status:** ACTIVE

**Decision**  
The product may communicate that configured escalation policy applies, but must not claim an email was sent, a manager was notified, or an escalation was triggered unless recorded state proves the event occurred.

**Rationale**  
Product trust requires strict distinction between policy and actual execution.

---

## D-021 — External management follow-up is valid product guidance

**Status:** ACTIVE

**Decision**  
The platform may recommend actions such as:

- calling an owner;
- visiting a stakeholder;
- speaking with a director;
- requesting a recovery commitment.

**Rationale**  
Real operational management often occurs outside the platform.

**Consequence**  
Do not invent fake transactional buttons. Supporting navigation may be provided.

---

## D-022 — Wait/read-only states must be complete

**Status:** ACTIVE

**Decision**  
When a persona cannot act, the product should answer:

1. why they cannot act;
2. current status/stage;
3. who owns the next step, if authoritative state supports it;
4. what prerequisite must occur before they can act again.

**Rationale**  
“No action available” is not sufficient operational guidance.

---

## D-023 — Results-first drilldowns

**Status:** ACTIVE

**Decision**  
When a user arrives through a specific intervention, show the relevant results first and keep generic filters secondary/collapsed where possible.

**Rationale**  
The user already expressed intent by choosing the intervention.

---

## D-024 — Mobile is a first-class decision surface

**Status:** ACTIVE

**Decision**  
Do not merely compress desktop tables onto mobile.

Foreground decision-critical fields and use compact cards where horizontal tables create unnecessary hunting.

**Verification expectation**  
Critical mobile experiences should be checked around 320px and 390px widths, including clipping and touch usability where relevant.

---

## D-025 — Exception-driven design is preferred

**Status:** ACTIVE

**Decision**  
Operational surfaces should foreground exceptions such as:

- blocked
- overdue
- SLA breached
- waiting for review
- rework required
- aging

**Rationale**  
Operational users typically need to manage exceptions rather than inspect every normal item.

---

## D-026 — Browser acceptance must be capable of detecting the claimed defect

**Status:** ACTIVE

**Decision**  
Browser evidence must fail closed.

Critical navigation journeys should be click-bound and verify actual route state.

**Rationale**  
A green browser suite is not useful if it can pass while the target defect remains visible.

**Do not**  
Treat direct `page.goto()` shortcuts, static headings, or negative-only assertions as sufficient proof of a positive user journey.

---

## D-027 — Executable SHA and evidence tip are separate

**Status:** ACTIVE

**Decision**  
Track:

- `FINAL_EXECUTABLE_SHA`
- `EVIDENCE_TIP_SHA`

separately.

**Rationale**  
Evidence/review metadata may be committed after executable code is frozen.

**Consequence**  
Final evidence must identify exactly which executable it certifies.

---

## D-028 — Historical Stage 11 acceptance is immutable

**Status:** ACTIVE

**Decision**  
The accepted Stage 11 executable and acceptance commit remain historical truth even as the product evolves.

**Rationale**  
Later product changes should not invalidate the fact that an earlier release passed its acceptance process.

**Consequence**  
Historical provenance tests pin to accepted boundaries rather than current HEAD.

---

## D-029 — Control-plane improvements must be driven by observed failures

**Status:** ACTIVE

**Decision**  
Do not endlessly redesign the autonomous development machinery while product work stalls.

**Rationale**  
The purpose of the control plane is to accelerate reliable product development, not become the primary product.

**Consequence**  
New orchestration mechanisms should address demonstrated failure modes.

---

## D-030 — One remediation pass per autonomous transaction

**Status:** ACTIVE

**Decision**  
Complex autonomous transactions get exactly one Parent remediation pass after final specialist review identifies blocking defects.

If blocking defects remain after fresh re-review, halt.

**Rationale**  
This prevents unbounded “fix until green” loops and preserves independent review integrity.

**Consequence**  
Further work must be a new recovery transaction, not a disguised second remediation.

---

## D-031 — Recovery transaction is distinct from remediation

**Status:** ACTIVE

**Decision**  
A recovery after an exhausted transaction is a new transaction with its own:

- scope;
- branch;
- specialist design;
- remediation budget;
- acceptance contract.

**Rationale**  
This keeps autonomous work bounded and auditable.

---

## D-032 — Failure Controller is frozen

**Status:** ACTIVE

**Decision**  
Failure Controller work is frozen/deferred.

The blocked branch remains unmerged. Related draft/reference work remains reference only unless explicitly reactivated.

**Rationale**  
The effort became disproportionate to current product value.

**Do not**  
Resume Failure Controller implementation during normal product work.

---

## D-033 — Product progress comes before productionization

**Status:** ACTIVE

**Decision**  
The current product remains a deterministic demo/MVP until productionization is explicitly approved.

**Rationale**  
Authentication, DB/storage, tenancy, residency implementation, monitoring, and operations would materially expand scope.

**Consequence**  
A public Vercel deployment is demonstration hosting, not evidence of production readiness.

---

## D-034 — `generatedByAI` semantic question remains deferred

**Status:** ACTIVE

**Decision**  
An AI-originated write-up may remain marked `generatedByAI=true` after human edits for now.

**Rationale**  
The semantic distinction between “AI-originated” and “currently AI-authored” needs a deliberate product decision.

**Do not**  
Change this behavior incidentally during unrelated UX work.

---

## D-035 — Current product personas remain the five implemented roles

**Status:** ACTIVE

**Decision**  
Current personas are:

- Compliance Analyst
- Evidence Owner
- Control Owner
- Compliance QA
- Internal Auditor

**Rationale**  
Management/CISO/director behavior may be relevant conceptually, but those personas are not currently implemented.

**Do not**  
Invent a CISO/manager persona in UI logic without an approved product change.

---

## D-036 — Real email escalation is desired but not yet implemented

**Status:** ACTIVE

**Decision**  
Automated overdue/SLA email escalation is a legitimate future product behavior.

**Current truth**  
The demo does not execute real email escalation.

**Consequence**  
Current UI may describe escalation policy but not claim actual email events.

---

## D-037 — Current Wave 1 must close before Wave 2 starts

**Status:** ACTIVE

**Decision**  
Do not begin Wave 2 persona-dashboard/mobile-queue redesign until Wave 1 action-truth and verification-integrity acceptance is complete.

**Rationale**  
Starting new UX scope while foundational action truth is uncertified would compound uncertainty.

---

## D-038 — Production state should be machine-maintained, not conversationally inferred

**Status:** ACTIVE  
**Date:** 2026-08-29

**Decision**  
Once Radio exists, volatile project facts must come from repository/API/runtime state, not from conversational memory.

**Rationale**  
Conversation is useful for product reasoning but is not a reliable system of record for changing SHAs, agent state, branches, budgets, or PR state.

**Consequence**  
`PROJECT-STATE.json` and the run ledger become authoritative for runtime orchestration.

---

## D-039 — Radio should remove transport, not judgment

**Status:** ACTIVE  
**Date:** 2026-08-29

**Decision**  
The purpose of Radio is to automate:

- prompt transport;
- agent launch;
- completion-report ingestion;
- state updates;
- routine legal next-step selection.

The human remains the product owner and approval authority.

**Rationale**  
The current manual workflow already works; the inefficient part is the human acting as an API/message bus.

---

## D-040 — The LLM reasons; Radio enforces

**Status:** ACTIVE  
**Date:** 2026-08-29

**Decision**  
GPT-5.6 Sol may select a proposed next action, but Radio's policy engine must reject illegal actions.

**Examples**

- remediation budget exhausted;
- duplicate active agent;
- merge without approval;
- deferred scope;
- failed required gate;
- direct main modification.

**Rationale**  
Critical autonomy boundaries must be enforced by software, not prompt obedience alone.

---

## D-041 — Radio v0.1 stays deliberately small

**Status:** ACTIVE  
**Date:** 2026-08-29

**Decision**  
Radio v0.1 supports one project and one active workstream at a time, with a terminal/CLI interface and no need for a polished dashboard.

**Rationale**  
The first proof is whether Radio can replace manual message transport without reducing quality or control.

**Do not initially build**

- multi-project scheduling;
- arbitrary swarms;
- autonomous GitHub merging;
- vector-memory infrastructure;
- elaborate control-plane recovery;
- production deployment automation.

---

## D-042 — Radio context is layered

**Status:** ACTIVE  
**Date:** 2026-08-29

**Decision**  
Orchestrator context is split into:

1. durable operating context;
2. current machine-readable project state;
3. immediate task evidence.

**Rationale**  
More context is not automatically better. Fresh Sol instances need complete understanding without being buried in stale historical detail.

---

## D-043 — Completion reports should become structured contracts

**Status:** ACTIVE  
**Date:** 2026-08-29

**Decision**  
Cursor completion reports should increasingly expose machine-readable fields for:

- agent ID;
- branch;
- executable SHA;
- evidence SHA;
- tests;
- reviewers;
- blockers;
- remediation usage;
- terminal verdict.

**Rationale**  
Radio should not need to infer execution state from prose.

---

## D-044 — Human merge approval remains default in Radio v0.1

**Status:** ACTIVE  
**Date:** 2026-08-29

**Decision**  
Radio may autonomously carry work to a certified state, but merge remains a human approval gate in v0.1.

**Rationale**  
This preserves a clear authorization boundary while the orchestration system is still being proven.

---

# Decision Log Maintenance Rules

1. Add an entry when a decision is durable enough that a fresh orchestrator might otherwise revisit or reverse it.
2. Do not record every implementation detail.
3. Do not place current SHAs, current agent IDs, or volatile task state here.
4. If a decision is replaced, mark the old entry `SUPERSEDED` and point to the new decision ID.
5. Never silently rewrite historical rationale to match a newer decision.
6. Product-specific decisions belong here; generic Radio operating policy belongs in the cross-project `ORCHESTRATOR-CONTEXT.md`.
