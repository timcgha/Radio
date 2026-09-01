/**
 * Shared test fixtures for Radio v2.
 */

import type { CursorApiClient, V1CreateAgentRequest } from "../cursor/api-client.js";
import { DEFAULT_APPROVED_CURSOR_WORKER_MODEL } from "../runtime/cursor-worker-model.js";
import type { V2Objective } from "./types.js";
import { V2_SCHEMA_VERSION } from "./types.js";

export const BELLHOP_REPO = "https://github.com/timcgha/Bellhop";
export const STARTING_SHA_A =
  "38ba91802817cc63d8fccdcab71ef0a400b7483b";
export const IMPLEMENTATION_TIP_B =
  "b5480ae90117d676d349a1da97b06ccb75e66dfd";
export const WRONG_SHA_C =
  "cccccccccccccccccccccccccccccccccccccccc";
export const NON_DESCENDANT_TIP =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export function bellhopObjective(
  overrides?: Partial<V2Objective>,
): V2Objective {
  return {
    schemaVersion: V2_SCHEMA_VERSION,
    objectiveId: "v2-bellhop-test-01",
    projectId: "bellhop",
    repository: BELLHOP_REPO,
    baseBranch: "main",
    expectedStartingSha: STARTING_SHA_A,
    humanInstruction: "Add one test to Bellhop.",
    authorizedWorkTypes: ["IMPLEMENTATION"],
    publicationRequired: true,
    humanApprovalBoundaries: ["merge", "production deploy"],
    ...overrides,
  };
}

export const UNSTRUCTURED_WORKER_NARRATIVE = `Added tests/foo.test.js.
1771 tests passed.
Build passed.
Pushed branch cursor/foo at ${IMPLEMENTATION_TIP_B}.
No product behavior changes.`;

export function fakeResolveRemoteBranchTip(map: Record<string, string>) {
  return async (input: { repositoryUrl: string; branch: string }) => {
    const key = `${input.repositoryUrl}#${input.branch}`;
    const sha = map[key];
    if (!sha) {
      throw new Error(`no fake tip for ${key}`);
    }
    return sha;
  };
}

export function fakeAncestry(pairs: Array<[string, string]>) {
  const set = new Set(pairs.map(([a, b]) => `${a}->${b}`));
  return async (input: {
    repositoryUrl: string;
    ancestorSha: string;
    descendantSha: string;
  }) => {
    if (input.ancestorSha === input.descendantSha) return true;
    return set.has(
      `${input.ancestorSha.toLowerCase()}->${input.descendantSha.toLowerCase()}`,
    );
  };
}

export function createCountingCursorClient(): CursorApiClient & {
  createCount: number;
  lastRequest: V1CreateAgentRequest | null;
} {
  let createCount = 0;
  let lastRequest: V1CreateAgentRequest | null = null;
  let agentCounter = 0;

  return {
    radioClientKind: "fixture",
    get createCount() {
      return createCount;
    },
    get lastRequest() {
      return lastRequest;
    },
    async createAgent(request) {
      createCount += 1;
      lastRequest = request;
      agentCounter += 1;
      const agentId = request.agentId ?? `bc-v2-fixture-${agentCounter}`;
      const runId = `run-v2-fixture-${agentCounter}`;
      return {
        agent: {
          id: agentId,
          status: "RUNNING",
          repos: request.repos,
        },
        run: {
          id: runId,
          agentId,
          status: "RUNNING",
        },
      };
    },
    async getAgent(agentId) {
      return { id: agentId, status: "FINISHED" };
    },
    async getRun(agentId, runId) {
      return {
        id: runId,
        agentId,
        status: "FINISHED",
        result: UNSTRUCTURED_WORKER_NARRATIVE,
      };
    },
    async getAgentUsage() {
      return {
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
        },
        runs: [],
      };
    },
    async getMe() {
      return { userEmail: "fixture@test.local" };
    },
    async listModels() {
      return {
        items: [{ id: DEFAULT_APPROVED_CURSOR_WORKER_MODEL }],
      };
    },
  };
}
