# Phase 0 Decision Envelope

`schemas/decision.schema.json` does not include a state-fingerprint field.

Phase 0 therefore persists fingerprint association outside the canonical decision body:

- `decision.json` — Sol decision validated against the canonical schema (unchanged)
- `decision-envelope.json` — Radio-owned metadata binding the decision to the request

Envelope fields include at minimum:

- `decisionId`
- `projectId`
- `workstreamId`
- `transactionId`
- `stateRevision`
- `requestFingerprint` — fingerprint of the state used to build the Sol request
- `model`
- `mode` (`live` | `fixture`)
- `generatedAt`
- `cursorExecutionEnabled`

Policy compares `requestFingerprint` from the envelope to the currently loaded authoritative fingerprint. A mismatch yields `REJECT` / `STALE_DECISION`.

This avoids mutating the normative decision schema solely for Phase 0 freshness tracking.
