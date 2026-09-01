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

export const CYBER_REPO = "https://github.com/timcgha/Cyber-assurance-demo";
export const CYBER_BASE_BRANCH = "cursor/verification-manifest-sha-binding-c68b";
export const CYBER_EXPECTED_STARTING_SHA =
  "05714b46bb2c9ef15f781f05ddc14844c4213d6b";
export const CYBER_UX028_ASSIGNED_BRANCH =
  "cursor/ux-028-duplicate-criterion-bb49";
export const CYBER_SOURCE_BRANCH_ADVANCED_SHA =
  "e33946da3fa3e7a64799b8e50fdb4c7767b59d47";
export const BASE_ADVANCED_SHA_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const IMPL_FROM_LATER_BASE_SHA =
  "dddddddddddddddddddddddddddddddddddddddd";
export const IMPL_FROM_AUTHORITY_SHA =
  "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

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

export function cyberObjective(
  overrides?: Partial<V2Objective>,
): V2Objective {
  return {
    schemaVersion: V2_SCHEMA_VERSION,
    objectiveId: "v2-cyber-transport-test-01",
    projectId: "cyber-assurance",
    repository: CYBER_REPO,
    baseBranch: CYBER_BASE_BRANCH,
    expectedStartingSha: CYBER_EXPECTED_STARTING_SHA,
    humanInstruction: "Implement UX-028 duplicate criterion.",
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

export function fakeMergeBase(map: Record<string, string>) {
  return async (input: {
    repositoryUrl: string;
    shaA: string;
    shaB: string;
  }) => {
    const a = input.shaA.toLowerCase();
    const b = input.shaB.toLowerCase();
    const key = `${a}^${b}`;
    const reverse = `${b}^${a}`;
    return map[key] ?? map[reverse] ?? null;
  };
}

/** Default merge-base map: implementation tip shares authority SHA as merge-base with base tip. */
export function defaultBellhopMergeBaseMap(): Record<string, string> {
  return {
    [`${IMPLEMENTATION_TIP_B}^${STARTING_SHA_A}`]: STARTING_SHA_A,
    [`${IMPL_FROM_AUTHORITY_SHA}^${BASE_ADVANCED_SHA_B}`]: STARTING_SHA_A,
    [`${IMPL_FROM_AUTHORITY_SHA}^${STARTING_SHA_A}`]: STARTING_SHA_A,
    [`${IMPL_FROM_LATER_BASE_SHA}^${BASE_ADVANCED_SHA_B}`]: BASE_ADVANCED_SHA_B,
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
