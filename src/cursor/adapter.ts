import { randomUUID } from "node:crypto";
import type { CursorWorkOrder } from "../types.js";
import {
  CursorApiError,
  type CursorApiClient,
  type V1Agent,
  type V1CreateAgentRequest,
  type V1CreateAgentResponse,
  type V1Run,
} from "./api-client.js";
import { resolveCursorTransportStartingRef } from "./source-ref.js";

export {
  resolveCursorStartingRef,
  resolveCursorTransportStartingRef,
} from "./source-ref.js";

/** Documented v1 run statuses (terminal + in-flight). */
export type CursorRunClassifiedStatus =
  | "RUNNING"
  | "FINISHED"
  | "FAILED"
  | "UNKNOWN";

const RUNNING_RUN_STATUSES = new Set([
  "CREATING",
  "RUNNING",
  "ACTIVE",
  "WAITING",
]);

const FINISHED_RUN_STATUSES = new Set(["FINISHED"]);

const FAILED_RUN_STATUSES = new Set([
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);

export function classifyRunStatus(status: string): CursorRunClassifiedStatus {
  const normalized = status.trim().toUpperCase();
  if (RUNNING_RUN_STATUSES.has(normalized)) return "RUNNING";
  if (FINISHED_RUN_STATUSES.has(normalized)) return "FINISHED";
  if (FAILED_RUN_STATUSES.has(normalized)) return "FAILED";
  return "UNKNOWN";
}

/** Client-supplied agent id form: bc-<uuid> (official v1 docs). */
export function generatePlannedAgentId(): string {
  return `bc-${randomUUID()}`;
}

export function isPlannedAgentId(id: string): boolean {
  return /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

export interface BuildCreateAgentRequestInput {
  workOrder: CursorWorkOrder;
  prompt: string;
  plannedAgentId: string;
  name?: string;
  /**
   * Explicit Cursor worker model id (required).
   * Radio fails closed if omitted — Cursor default model selection is forbidden.
   */
  modelId: string;
}

/**
 * Build a v1 Create Agent request for Phase 1 Bellhop dispatch.
 * model.id is REQUIRED — implicit Cursor default selection is fail-closed.
 *
 * repos[].startingRef uses the Cursor *transport* branch ref (not the
 * authoritative expected commit SHA). Expected SHA integrity is enforced by
 * remote-ref precheck + worker HEAD verification.
 */
export function buildCreateAgentRequest(
  input: BuildCreateAgentRequestInput,
): V1CreateAgentRequest {
  const { workOrder, prompt, plannedAgentId } = input;

  if (workOrder.agentAction !== "FRESH_ORDINARY_AGENT_REQUIRED") {
    throw new Error(
      `Phase 1 transmitter only supports FRESH_ORDINARY_AGENT_REQUIRED (got ${workOrder.agentAction})`,
    );
  }

  const modelId = input.modelId?.trim();
  if (!modelId) {
    throw new Error(
      "CURSOR_WORKER_MODEL_OMITTED: buildCreateAgentRequest requires explicit modelId",
    );
  }

  const startingRef = resolveCursorTransportStartingRef(workOrder.source);

  const request: V1CreateAgentRequest = {
    prompt: { text: prompt },
    repos: [
      {
        url: workOrder.source.repository,
        ...(startingRef ? { startingRef } : {}),
      },
    ],
    autoCreatePR: false,
    mode: "agent",
    agentId: plannedAgentId,
    model: { id: modelId },
  };

  if (input.name) {
    request.name = input.name;
  }

  return request;
}

export interface CreateOrReconcileAgentResult {
  agent: V1Agent;
  run: V1Run;
  createRequest: V1CreateAgentRequest;
  reusedExisting: boolean;
  reconciledViaConflict: boolean;
  reconciledViaAmbiguous: boolean;
}

/**
 * Create a durable agent + initial run, or reconcile an existing one on
 * 409 agent_id_conflict / ambiguous network failure.
 *
 * Invariant: ONE Radio work order → AT MOST ONE logical Cursor agent.
 */
export async function createOrReconcileAgent(input: {
  client: CursorApiClient;
  workOrder: CursorWorkOrder;
  prompt: string;
  plannedAgentId: string;
  name?: string;
  /** Explicit worker model id (required for create). */
  modelId: string;
  /** Treat create failure as ambiguous and attempt GET reconciliation. */
  treatCreateErrorAsAmbiguous?: (err: unknown) => boolean;
}): Promise<CreateOrReconcileAgentResult> {
  const createRequest = buildCreateAgentRequest({
    workOrder: input.workOrder,
    prompt: input.prompt,
    plannedAgentId: input.plannedAgentId,
    name: input.name,
    modelId: input.modelId,
  });

  try {
    const created = await input.client.createAgent(createRequest);
    return {
      agent: created.agent,
      run: created.run,
      createRequest,
      reusedExisting: false,
      reconciledViaConflict: false,
      reconciledViaAmbiguous: false,
    };
  } catch (err) {
    const isConflict =
      err instanceof CursorApiError &&
      err.status === 409 &&
      (err.code === "agent_id_conflict" ||
        /agent_id_conflict/i.test(err.body) ||
        /agent_id_conflict/i.test(err.message));

    const ambiguous =
      !isConflict &&
      (input.treatCreateErrorAsAmbiguous?.(err) ??
        isAmbiguousCreateFailure(err));

    if (!isConflict && !ambiguous) {
      throw err;
    }

    const reconciled = await reconcileExistingAgent(
      input.client,
      input.plannedAgentId,
    );
    return {
      ...reconciled,
      createRequest,
      reusedExisting: true,
      reconciledViaConflict: isConflict,
      reconciledViaAmbiguous: ambiguous && !isConflict,
    };
  }
}

export async function reconcileExistingAgent(
  client: CursorApiClient,
  plannedAgentId: string,
): Promise<{ agent: V1Agent; run: V1Run }> {
  const agent = await client.getAgent(plannedAgentId);
  const runId = agent.latestRunId;
  if (!runId) {
    throw new Error(
      `Reconciled agent ${plannedAgentId} has no latestRunId`,
    );
  }
  const run = await client.getRun(plannedAgentId, runId);
  return { agent, run };
}

export function isAmbiguousCreateFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) return true;
  if (message.includes("network") || message.includes("fetch failed")) return true;
  if (err instanceof CursorApiError && err.status >= 500) return true;
  return false;
}

export interface PollRunUntilTerminalOptions {
  client: CursorApiClient;
  agentId: string;
  runId: string;
  intervalMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (run: V1Run, classified: CursorRunClassifiedStatus) => void;
}

/**
 * Poll the exact run (agentId + runId). Do not infer completion from agent status.
 */
export async function pollRunUntilTerminal(
  options: PollRunUntilTerminalOptions,
): Promise<V1Run> {
  const intervalMs = options.intervalMs ?? 1000;
  const maxAttempts = options.maxAttempts ?? 120;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let last: V1Run | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await options.client.getRun(options.agentId, options.runId);
    const classified = classifyRunStatus(last.status);
    options.onStatus?.(last, classified);
    if (classified === "FINISHED" || classified === "FAILED") {
      return last;
    }
    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  throw new Error(
    `Timed out polling Cursor run ${options.agentId}/${options.runId} after ${maxAttempts} attempts (last status=${last?.status ?? "unknown"})`,
  );
}

export type { V1Agent, V1Run, V1CreateAgentResponse };
