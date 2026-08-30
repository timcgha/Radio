/**
 * Multi-shot fixture Cursor client for Phase 3 autonomous loop tests.
 * Returns a distinct agent/run per logical create; never performs network I/O.
 */

import {
  CursorApiError,
  type CursorApiClient,
  type V1CreateAgentRequest,
} from "../cursor/api-client.js";
import { nowIso } from "../util/io.js";

export interface Phase3FixtureLaunchScript {
  /** Raw result text returned when the run is polled to terminal. */
  rawResult: string;
  agentId?: string;
  runId?: string;
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
} {
  let createCallCount = 0;
  let logicalLaunchCount = 0;
  let scriptIndex = 0;
  const agents = new Map<
    string,
    {
      runId: string;
      rawResult: string;
      runStatus: string;
      request: V1CreateAgentRequest | null;
    }
  >();

  const client: CursorApiClient & {
    createCallCount: number;
    logicalLaunchCount: number;
  } = {
    radioClientKind: "fixture",
    get createCallCount() {
      return createCallCount;
    },
    get logicalLaunchCount() {
      return logicalLaunchCount;
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
        rawResult: script.rawResult,
        runStatus: "RUNNING",
        request,
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
      if (entry.runStatus === "RUNNING" || entry.runStatus === "CREATING") {
        entry.runStatus = "FINISHED";
      }
      return {
        id: entry.runId,
        agentId: id,
        status: entry.runStatus,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        durationMs: 42,
        result: entry.rawResult,
        git: {
          branches: [
            {
              repoUrl: "github.com/timcgha/Bellhop",
              branch: "cursor/level4-stage2-asteroid-garden-9dce",
            },
          ],
        },
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
  };

  return client;
}
