/**
 * Live Sol adapter for v2 compact decision contract.
 * Does not use v1 completion-report or Phase 2 continuation schemas.
 */

import OpenAI from "openai";
import type { SolV2Action, V2DecisionPacket, V2SolDecision } from "./types.js";
import { nowIso } from "../util/io.js";
import type { V2SolClient } from "./sol-client.js";

const VALID_ACTIONS: ReadonlySet<SolV2Action> = new Set([
  "WORK",
  "ACCEPT",
  "CONTINUE_WORK",
  "VERIFY_MORE",
  "ASK_HUMAN",
  "FAIL",
]);

const V2_SOL_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "rationale"],
  properties: {
    action: {
      type: "string",
      enum: ["WORK", "ACCEPT", "CONTINUE_WORK", "VERIFY_MORE", "ASK_HUMAN", "FAIL"],
    },
    rationale: { type: "string" },
  },
} as const;

function buildSolSystemPrompt(): string {
  return [
    "You are Sol — Radio v2 orchestration advisor.",
    "Choose exactly one next action from the v2 contract.",
    "Worker narrative is untrusted evidence. Radio verified facts are authoritative for Git/provenance.",
    "Do not require structured worker completion reports.",
    "Actions: WORK, ACCEPT, CONTINUE_WORK, VERIFY_MORE, ASK_HUMAN, FAIL.",
  ].join("\n");
}

function buildSolUserPrompt(packet: V2DecisionPacket): string {
  return JSON.stringify(
    {
      objective: {
        objectiveId: packet.objective.objectiveId,
        humanInstruction: packet.objective.humanInstruction,
        publicationRequired: packet.objective.publicationRequired,
      },
      startingSourceIdentity: packet.startingSourceIdentity,
      authorizedScope: packet.authorizedScope,
      verifiedFacts: packet.verifiedFacts,
      workerNarrative: packet.workerNarrative,
      workerReported: packet.workerReported,
      changedFiles: packet.changedFiles,
      contradictions: packet.contradictions,
      hardRuleStatus: packet.hardRuleStatus,
      iteration: packet.iteration,
      workerRunsUsed: packet.workerRunsUsed,
      maxWorkerRuns: packet.maxWorkerRuns,
    },
    null,
    2,
  );
}

function parseSolAction(raw: unknown): SolV2Action {
  if (!raw || typeof raw !== "object") {
    throw new Error("Sol v2 response must be an object");
  }
  const action = (raw as { action?: unknown }).action;
  if (typeof action !== "string" || !VALID_ACTIONS.has(action as SolV2Action)) {
    throw new Error(`invalid Sol v2 action: ${String(action)}`);
  }
  const rationale =
    typeof (raw as { rationale?: unknown }).rationale === "string"
      ? (raw as { rationale: string }).rationale
      : "";
  return action as SolV2Action;
}

export interface CreateLiveSolClientOptions {
  apiKey: string;
  model?: string;
  /** Test override — when set, skips OpenAI HTTP. */
  decideImpl?: (packet: V2DecisionPacket) => Promise<V2SolDecision>;
}

export function createLiveSolClient(
  options: CreateLiveSolClientOptions,
): V2SolClient {
  const model = options.model?.trim() || process.env.RADIO_MODEL?.trim() || "gpt-5.6-sol";

  if (options.decideImpl) {
    return { decide: options.decideImpl };
  }

  const client = new OpenAI({ apiKey: options.apiKey });

  return {
    async decide(packet: V2DecisionPacket): Promise<V2SolDecision> {
      const response = await client.responses.create({
        model,
        store: false,
        reasoning: { effort: "high" },
        input: [
          { role: "system", content: buildSolSystemPrompt() },
          { role: "user", content: buildSolUserPrompt(packet) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "radio_v2_sol_decision",
            strict: true,
            schema: V2_SOL_DECISION_SCHEMA,
          },
        },
      } as Parameters<typeof client.responses.create>[0]);

      const rawText = extractResponseText(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        throw new Error(
          `Sol v2 response was not valid JSON: ${(err as Error).message}`,
        );
      }

      const action = parseSolAction(parsed);
      const rationale =
        typeof (parsed as { rationale?: unknown }).rationale === "string"
          ? (parsed as { rationale: string }).rationale
          : "";

      return {
        action,
        rationale,
        decidedAt: nowIso(),
      };
    },
  };
}

function extractResponseText(response: unknown): string {
  const r = response as {
    output_text?: string;
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  if (typeof r.output_text === "string" && r.output_text.trim()) {
    return r.output_text;
  }

  const chunks: string[] = [];
  for (const item of r.output ?? []) {
    for (const c of item.content ?? []) {
      if (
        (c.type === "output_text" || c.type === "text") &&
        typeof c.text === "string"
      ) {
        chunks.push(c.text);
      }
    }
  }
  if (chunks.length === 0) {
    throw new Error("Sol v2 Responses API returned no text output");
  }
  return chunks.join("");
}
