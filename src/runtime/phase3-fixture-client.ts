/**
 * Multi-shot fixture Cursor client for Phase 3 autonomous loop tests.
 * Returns a distinct agent/run per logical create; never performs network I/O.
 */

import {
  CursorApiError,
  type CursorApiClient,
  type V1CreateAgentRequest,
  type V1ModelsResponse,
} from "../cursor/api-client.js";
import { DEFAULT_APPROVED_CURSOR_WORKER_MODEL } from "./cursor-worker-model.js";
import { nowIso } from "../util/io.js";

function applyFixtureAgentPlaceholder(raw: string, agentId: string): string {
  return raw.split("<<FIXTURE_AGENT_ID>>").join(agentId);
}

export interface Phase3FixtureFollowUpContext {
  agentId: string;
  /** Full REPORT-ONLY repair prompt sent via createAgentRun. */
  promptText: string;
}

export interface Phase3FixtureLaunchScript {
  /** Raw result text returned when the run is polled to terminal. */
  rawResult: string;
  agentId?: string;
  runId?: string;
  /**
   * Follow-up run results for same-agent report repair (createAgentRun).
   * Consumed in order per agent.
   */
  followUpResults?: string[];
  /**
   * Dynamic follow-up builders — preferred when the valid repair response must
   * bind to runtime work-order identity from the repair prompt.
   */
  followUpBuilders?: Array<(ctx: Phase3FixtureFollowUpContext) => string>;
  /**
   * Remain RUNNING for this many getRun polls before becoming FINISHED/ERROR.
   * Defaults to 0 (first poll advances to terminal) for backward compatibility.
   * Set high to simulate observation-budget expiry.
   */
  remainRunningPolls?: number;
  /** Terminal status after remainRunningPolls exhausted. Default FINISHED. */
  terminalStatus?: "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";
}

/**
 * Create a fixture Cursor API client that serves a scripted sequence of launches.
 * Each createAgent consumes the next script entry. Transport reconciliation of the
 * same agentId does not consume an additional script entry.
 */
export function createPhase3FixtureCursorClient(
  scripts: Phase3FixtureLaunchScript[],
): CursorApiClient & {
  createCallCount: number;
  logicalLaunchCount: number;
  followUpCallCount: number;
} {
  let createCallCount = 0;
  let logicalLaunchCount = 0;
  let followUpCallCount = 0;
  let scriptIndex = 0;
  const agents = new Map<
    string,
    {
      runId: string;
      rawResult: string;
      runStatus: string;
      request: V1CreateAgentRequest | null;
      remainRunningPolls: number;
      pollsObserved: number;
      terminalStatus: string;
      followUpQueue: string[];
      followUpBuilderQueue: Array<(ctx: Phase3FixtureFollowUpContext) => string>;
      followUpRunCounter: number;
    }
  >();

  const client: CursorApiClient & {
    createCallCount: number;
    logicalLaunchCount: number;
    followUpCallCount: number;
  } = {
    radioClientKind: "fixture",
    get createCallCount() {
      return createCallCount;
    },
    get logicalLaunchCount() {
      return logicalLaunchCount;
    },
    get followUpCallCount() {
      return followUpCallCount;
    },
    async createAgent(request) {
      createCallCount += 1;
      const planned = request.agentId;
      if (planned && agents.has(planned)) {
        throw new CursorApiError(
          "Cursor API POST /v1/agents failed with 409",
          409,
          JSON.stringify({ error: "agent_id_conflict" }),
          "agent_id_conflict",
        );
      }
      if (scriptIndex >= scripts.length) {
        throw new Error(
          `Phase 3 fixture Cursor client exhausted: no script for launch #${scriptIndex + 1}`,
        );
      }
      const script = scripts[scriptIndex]!;
      scriptIndex += 1;
      logicalLaunchCount += 1;
      const agentId =
        planned ??
        script.agentId ??
        `bc-phase3-fixture-${String(logicalLaunchCount).padStart(4, "0")}`;
      const runId =
        script.runId ??
        `run-phase3-fixture-${String(logicalLaunchCount).padStart(4, "0")}`;
      agents.set(agentId, {
        runId,
        rawResult: applyFixtureAgentPlaceholder(script.rawResult, agentId),
        runStatus: "RUNNING",
        request,
        remainRunningPolls: script.remainRunningPolls ?? 0,
        pollsObserved: 0,
        terminalStatus: script.terminalStatus ?? "FINISHED",
        followUpQueue: (script.followUpResults ?? []).map((r) =>
          applyFixtureAgentPlaceholder(r, agentId),
        ),
        followUpBuilderQueue: [...(script.followUpBuilders ?? [])],
        followUpRunCounter: 0,
      });
      return {
        agent: {
          id: agentId,
          name: `Phase3 Fixture Worker ${logicalLaunchCount}`,
          status: "ACTIVE",
          repos: request.repos,
          autoCreatePR: request.autoCreatePR ?? false,
          latestRunId: runId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          url: `https://cursor.com/agents/${agentId}`,
        },
        run: {
          id: runId,
          agentId,
          status: "RUNNING",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      };
    },
    async createAgentRun(agentId, runRequest) {
      followUpCallCount += 1;
      const entry = agents.get(agentId);
      if (!entry) {
        throw new Error(`Unknown fixture agent ${agentId} for follow-up`);
      }
      const promptText = runRequest.prompt?.text ?? "";
      let nextResult: string | null = null;
      if (entry.followUpBuilderQueue.length > 0) {
        const builder = entry.followUpBuilderQueue.shift()!;
        nextResult = applyFixtureAgentPlaceholder(
          builder({ agentId, promptText }),
          agentId,
        );
      } else if (entry.followUpQueue.length > 0) {
        nextResult = entry.followUpQueue.shift()!;
      }
      if (!nextResult) {
        throw new Error(
          `Phase 3 fixture follow-up exhausted for agent ${agentId}`,
        );
      }
      entry.followUpRunCounter += 1;
      const followRunId = `${entry.runId}-followup-${entry.followUpRunCounter}`;
      entry.runId = followRunId;
      entry.rawResult = nextResult;
      entry.runStatus = "RUNNING";
      entry.pollsObserved = 0;
      entry.terminalStatus = "FINISHED";
      void runRequest;
      return {
        run: {
          id: followRunId,
          agentId,
          status: "RUNNING",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      };
    },
    async getAgent(id: string) {
      const entry = agents.get(id);
      if (!entry) {
        throw new Error(`Unknown fixture agent ${id}`);
      }
      return {
        id,
        name: "Phase3 Fixture Worker",
        status: entry.runStatus === "FINISHED" ? "IDLE" : "ACTIVE",
        latestRunId: entry.runId,
        repos: entry.request?.repos,
        autoCreatePR: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        url: `https://cursor.com/agents/${id}`,
      };
    },
    async getRun(id: string, rid: string) {
      const entry = agents.get(id);
      if (!entry) {
        throw new Error(`Unknown fixture agent ${id}`);
      }
      if (rid !== entry.runId) {
        throw new Error(`Unknown fixture run ${rid}`);
      }
      entry.pollsObserved += 1;
      if (
        entry.runStatus === "RUNNING" ||
        entry.runStatus === "CREATING"
      ) {
        if (entry.pollsObserved > entry.remainRunningPolls) {
          entry.runStatus = entry.terminalStatus;
        }
      }
      return {
        id: entry.runId,
        agentId: id,
        status: entry.runStatus,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        durationMs: entry.runStatus === "FINISHED" || entry.runStatus === "ERROR" ? 42 : undefined,
        result:
          entry.runStatus === "FINISHED" || entry.runStatus === "ERROR"
            ? entry.rawResult
            : undefined,
        git:
          entry.runStatus === "FINISHED"
            ? {
                branches: [
                  {
                    repoUrl: "github.com/timcgha/Bellhop",
                    branch: "cursor/level4-stage2-asteroid-garden-9dce",
                  },
                ],
              }
            : undefined,
      };
    },
    async getAgentUsage(id: string, rid?: string) {
      const entry = agents.get(id);
      return {
        totalUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 150,
        },
        runs: [
          {
            id: rid ?? entry?.runId ?? "run-unknown",
            usageUuid: "00000000-0000-0000-0000-0000000000f3",
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              totalTokens: 150,
            },
          },
        ],
      };
    },
    async getMe() {
      return { apiKeyName: "phase3-fixture", createdAt: nowIso() };
    },
    async listModels(): Promise<V1ModelsResponse> {
      return {
        items: [
          {
            id: DEFAULT_APPROVED_CURSOR_WORKER_MODEL,
            displayName: "Composer 2",
            aliases: ["composer-latest", "composer"],
          },
          {
            id: "composer-2.5",
            displayName: "Composer 2.5",
          },
        ],
      };
    },
  };

  return client;
}
