import type { CursorWorkOrder } from "../types.js";
import {
  type CursorAgentRecord,
  type CursorApiClient,
  type CursorConversation,
  type CursorLaunchRequest,
} from "./api-client.js";
import {
  parseCompletionFromConversation,
  type ParsedCompletionEnvelope,
} from "./completion-parser.js";

export type CursorAgentTerminalStatus =
  | "RUNNING"
  | "FINISHED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

const RUNNING_STATUSES = new Set([
  "CREATING",
  "RUNNING",
  "QUEUED",
  "PENDING",
  "STARTING",
  "WAITING",
  "IDLE",
  "WAITING_FOR_BACKGROUND_WORK",
]);

const FINISHED_STATUSES = new Set([
  "FINISHED",
  "COMPLETED",
  "DONE",
  "SUCCESS",
]);

const FAILED_STATUSES = new Set([
  "FAILED",
  "ERROR",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "ARCHIVED",
]);

export function classifyAgentStatus(status: string): CursorAgentTerminalStatus {
  const normalized = status.trim().toUpperCase();
  if (RUNNING_STATUSES.has(normalized)) return "RUNNING";
  if (FINISHED_STATUSES.has(normalized)) return "FINISHED";
  if (FAILED_STATUSES.has(normalized)) return "FAILED";
  return "UNKNOWN";
}

export interface LaunchCursorAgentInput {
  client: CursorApiClient;
  workOrder: CursorWorkOrder;
  prompt: string;
  /** Optional display name */
  name?: string;
}

export interface LaunchCursorAgentResult {
  agent: CursorAgentRecord;
  launchRequest: CursorLaunchRequest;
  reusedExisting: boolean;
}

/**
 * Launch a fresh ordinary Cursor cloud agent for a work order.
 * Caller is responsible for idempotency reconciliation before calling this.
 */
export async function launchCursorAgent(
  input: LaunchCursorAgentInput,
): Promise<LaunchCursorAgentResult> {
  const { workOrder, prompt, client } = input;

  if (workOrder.agentAction !== "FRESH_ORDINARY_AGENT_REQUIRED") {
    throw new Error(
      `Phase 1 transmitter only supports FRESH_ORDINARY_AGENT_REQUIRED (got ${workOrder.agentAction})`,
    );
  }

  const launchRequest: CursorLaunchRequest = {
    prompt: { text: prompt },
    model: "default",
    source: {
      repository: workOrder.source.repository,
      ref:
        workOrder.source.workingBranch ??
        workOrder.source.baseBranch ??
        undefined,
    },
    target: {
      autoCreatePr: false,
      // Read-only verification: stay on the Stage 2 branch tip; do not auto-branch.
      autoBranch: false,
    },
  };

  const agent = await client.launchAgent(launchRequest);
  return { agent, launchRequest, reusedExisting: false };
}

export interface PollUntilCompleteOptions {
  client: CursorApiClient;
  agentId: string;
  intervalMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (agent: CursorAgentRecord, classified: CursorAgentTerminalStatus) => void;
}

export async function pollAgentUntilTerminal(
  options: PollUntilCompleteOptions,
): Promise<CursorAgentRecord> {
  const intervalMs = options.intervalMs ?? 1000;
  const maxAttempts = options.maxAttempts ?? 120;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let last: CursorAgentRecord | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await options.client.getAgent(options.agentId);
    const classified = classifyAgentStatus(last.status);
    options.onStatus?.(last, classified);
    if (classified === "FINISHED" || classified === "FAILED") {
      return last;
    }
    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  throw new Error(
    `Timed out polling Cursor agent ${options.agentId} after ${maxAttempts} attempts (last status=${last?.status ?? "unknown"})`,
  );
}

export async function retrieveCompletionFromAgent(input: {
  client: CursorApiClient;
  agentId: string;
}): Promise<{
  conversation: CursorConversation;
  parsed: ParsedCompletionEnvelope;
}> {
  const conversation = await input.client.getConversation(input.agentId);
  const parsed = parseCompletionFromConversation(conversation);
  return { conversation, parsed };
}
