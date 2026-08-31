# Radio Operational Acceptance Procedure

This procedure validates that Radio is **operational** for zero-relay execution after the Operational MVP PR is merged. Do **not** run live product objectives during implementation PR validation — run this only post-merge using Bellhop.

## Success criteria

Radio is considered operational only after **3 consecutive** live small Bellhop objectives, each satisfying **all** of:

1. **One human launch** — single objective authority + start; no mid-run prompt relays.
2. **Zero manual mid-run prompt relays** — human does not paste worker output into another chat.
3. **Zero manual report copying** — human does not copy completion reports to determine next action.
4. **Correct repository binding** — product worker targets authorized Bellhop repository/ref.
5. **Implementation worker created by Radio** — transmitter `POST /v1/agents`, not manual Cursor session.
6. **Tests executed** — worker runs required verification commands.
7. **Required commit/push performed** when objective `completionRequirements` require it.
8. **Remote artifact verified** when `remotePublicationRequired`.
9. **Schema-valid completion achieved**, including automatic same-worker report repair if initial report was malformed.
10. **Deterministic completion gate** behaves correctly on `ACCEPT_WORKSTREAM`.
11. **No plumbing-induced `READY_FOR_HUMAN`** — schema/format repair must not stop for human relay.

A **real product judgment** may still legitimately stop a run (`REQUEST_HUMAN_APPROVAL`, merge, deploy, etc.).

## Per-run telemetry (from `phase3-summary.json`)

| Field | Expected |
|-------|----------|
| `HUMAN_MESSAGES_REQUIRED_AFTER_LAUNCH` | `0` for plumbing-only success paths |
| `REPORT_REPAIR_ATTEMPTS` | `0` if first report valid; `1–2` if repair used |
| `IMPLEMENTATION_WORKERS_CREATED` | `≥ 1` per objective with Cursor dispatch |
| `SAME_WORKER_REPORT_REPAIR_USED` | `true` when repair ran |
| `PLUMBING_HUMAN_GATE_OCCURRED` | `false` unless real human gate |
| `FINAL_STATE` | `ACCEPTED` for successful closeout |
| `TERMINAL_VERDICT` | `RADIO_PHASE3_OBJECTIVE_COMPLETE` or documented human gate |

## Three consecutive run rule

1. Complete Bellhop objective #1 with all criteria → record telemetry.
2. Complete Bellhop objective #2 with all criteria → record telemetry.
3. Complete Bellhop objective #3 with all criteria → record telemetry.

If any run fails a plumbing criterion, reset the consecutive counter to zero.

## Artifact checklist (per run)

Under the Phase 3 run root (`artifacts/runs/<runId>/`):

- `work-order-iter-*.json`
- `cursor-prompt-iter-*.txt`
- `raw-worker-result-exec-*.txt`
- `report-repair-exec-*/` (if repair occurred)
- `completion-acceptance-context-iter-*.json`
- `completion-acceptance-gate-iter-*.json` (on ACCEPT)
- `phase3-checkpoint.json` (resume context)
- `phase3-summary.json` (telemetry)

## Explicit non-goals

- No live runs during implementation PR CI.
- No Cyber Assurance or Bellhop product changes for acceptance.
- No Failure Controller, dashboards, or database.
