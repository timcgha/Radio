import fs from "node:fs";
import path from "node:path";
import type { RunLedgerEvent } from "../types.js";
import {
  formatAjvErrors,
  getSchemaValidator,
  newId,
  nowIso,
  resolveRepoPath,
} from "../util/io.js";
import { boundLedgerSummary } from "./ledger-summary.js";

export function defaultLedgerPath(projectId: string): string {
  return resolveRepoPath("projects", projectId, "RUN-LEDGER.jsonl");
}

export function readLedgerEvents(ledgerPath: string): RunLedgerEvent[] {
  if (!fs.existsSync(ledgerPath)) return [];
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  return lines.map((line, idx) => {
    const event = JSON.parse(line) as RunLedgerEvent;
    const validate = getSchemaValidator("run-ledger-event.schema.json");
    if (!validate(event)) {
      throw new Error(
        `Invalid ledger event at ${ledgerPath}:${idx + 1}: ${formatAjvErrors(validate.errors)}`,
      );
    }
    return event;
  });
}

export function nextLedgerSequence(ledgerPath: string): number {
  const events = readLedgerEvents(ledgerPath);
  if (events.length === 0) return 1;
  return Math.max(...events.map((e) => e.sequence)) + 1;
}

export function findLedgerEventByIdempotency(
  ledgerPath: string,
  idempotencyKey: string,
  eventTypes?: string[],
): RunLedgerEvent | null {
  const events = readLedgerEvents(ledgerPath);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.idempotencyKey !== idempotencyKey) continue;
    if (eventTypes && !eventTypes.includes(e.eventType)) continue;
    return e;
  }
  return null;
}

export interface AppendLedgerInput {
  ledgerPath: string;
  eventType: RunLedgerEvent["eventType"];
  projectId: string;
  workstreamId: string | null;
  transactionId: string | null;
  workOrderId: string | null;
  decisionId: string | null;
  agentId: string | null;
  approvalId?: string | null;
  stateRevisionBefore: number | null;
  stateRevisionAfter: number | null;
  stateFingerprint: string | null;
  idempotencyKey: string | null;
  severity?: RunLedgerEvent["severity"];
  summary: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  /** Optional artifact path referenced when summary is truncated. */
  summaryArtifactRef?: string | null;
}

export function appendLedgerEvent(input: AppendLedgerInput): RunLedgerEvent {
  const occurredAt = input.occurredAt ?? nowIso();
  const event: RunLedgerEvent = {
    schemaVersion: "1.0",
    sequence: nextLedgerSequence(input.ledgerPath),
    eventId: newId("evt"),
    eventType: input.eventType,
    occurredAt,
    recordedAt: nowIso(),
    projectId: input.projectId,
    workstreamId: input.workstreamId,
    transactionId: input.transactionId,
    workOrderId: input.workOrderId,
    decisionId: input.decisionId,
    agentId: input.agentId,
    approvalId: input.approvalId ?? null,
    stateRevisionBefore: input.stateRevisionBefore,
    stateRevisionAfter: input.stateRevisionAfter,
    stateFingerprint: input.stateFingerprint,
    idempotencyKey: input.idempotencyKey,
    severity: input.severity ?? "INFO",
    summary: boundLedgerSummary(input.summary, {
      artifactRef: input.summaryArtifactRef,
    }),
    payload: input.payload ?? {},
  };

  const validate = getSchemaValidator("run-ledger-event.schema.json");
  if (!validate(event)) {
    throw new Error(
      `Ledger event schema validation failed: ${formatAjvErrors(validate.errors)}`,
    );
  }

  fs.mkdirSync(path.dirname(input.ledgerPath), { recursive: true });
  fs.appendFileSync(input.ledgerPath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}
