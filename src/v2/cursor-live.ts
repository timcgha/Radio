/**
 * Live Cursor worker observation for v2.
 * Uses existing Cursor HTTP client + poll adapter — no completion-report repair.
 */

import {
  classifyRunStatus,
  pollRunUntilTerminal,
} from "../cursor/adapter.js";
import type { CursorApiClient } from "../cursor/api-client.js";
import type { ResolveRemoteBranchTip } from "../cursor/source-ref.js";
import {
  CURSOR_FIXTURE_POLL_INTERVAL_MS,
  CURSOR_FIXTURE_POLL_MAX_ATTEMPTS,
  CURSOR_LIVE_POLL_INTERVAL_MS,
  CURSOR_LIVE_POLL_MAX_ATTEMPTS,
} from "../runtime/transmitter.js";
import { parseWorkerNarrative } from "./worker-narrative.js";
import type { V2WorkerOutcome } from "./orchestrator.js";

export interface ObserveV2WorkerInput {
  cursorClient: CursorApiClient;
  agentId: string;
  runId: string;
  repository: string;
  resolveRemoteBranchTip: ResolveRemoteBranchTip;
  useFixturePolling?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function extractBranchFromRun(
  run: { git?: { branches?: Array<{ repoUrl: string; branch?: string }> } },
  repository: string,
): string | null {
  const target = normalizeRepoUrl(repository);
  for (const entry of run.git?.branches ?? []) {
    if (normalizeRepoUrl(entry.repoUrl) === target && entry.branch?.trim()) {
      return entry.branch.trim();
    }
  }
  for (const entry of run.git?.branches ?? []) {
    if (entry.branch?.trim()) return entry.branch.trim();
  }
  return null;
}

/**
 * Poll a Cursor worker run to completion and derive v2 outcome facts.
 */
export async function observeV2WorkerRun(
  input: ObserveV2WorkerInput,
): Promise<V2WorkerOutcome> {
  const pollDefaults = input.useFixturePolling
    ? {
        intervalMs: CURSOR_FIXTURE_POLL_INTERVAL_MS,
        maxAttempts: CURSOR_FIXTURE_POLL_MAX_ATTEMPTS,
      }
    : {
        intervalMs: CURSOR_LIVE_POLL_INTERVAL_MS,
        maxAttempts: CURSOR_LIVE_POLL_MAX_ATTEMPTS,
      };

  const run = await pollRunUntilTerminal({
    client: input.cursorClient,
    agentId: input.agentId,
    runId: input.runId,
    intervalMs: pollDefaults.intervalMs,
    maxAttempts: pollDefaults.maxAttempts,
    sleep: input.sleep,
    onStatus: (polled, classified) => {
      if (classified === "FAILED") {
        throw new Error(
          `worker run ${input.runId} failed with status ${polled.status}`,
        );
      }
    },
  });

  const classified = classifyRunStatus(run.status);
  if (classified !== "FINISHED") {
    throw new Error(`worker run ${input.runId} did not finish: ${run.status}`);
  }

  const narrative = run.result ?? "";
  const reported = parseWorkerNarrative(narrative);
  const implementationBranch =
    extractBranchFromRun(run, input.repository) ??
    reported.claimedBranch ??
    "";

  let implementationTipSha = reported.claimedCommit ?? "";
  if (implementationBranch) {
    try {
      implementationTipSha = await input.resolveRemoteBranchTip({
        repositoryUrl: input.repository,
        branch: implementationBranch,
      });
    } catch {
      // Fall back to narrative-claimed commit when branch tip cannot be resolved.
    }
  }

  if (!implementationTipSha) {
    throw new Error(
      "could not determine implementation tip SHA from worker run or remote branch",
    );
  }

  return {
    narrative,
    implementationBranch,
    implementationTipSha: implementationTipSha.toLowerCase(),
  };
}

export function createObtainWorkerOutcome(input: {
  cursorClient: CursorApiClient;
  repository: string;
  resolveRemoteBranchTip: ResolveRemoteBranchTip;
  useFixturePolling?: boolean;
  sleep?: (ms: number) => Promise<void>;
}): (ctx: {
  agentId: string;
  runId: string;
  iteration: number;
}) => Promise<V2WorkerOutcome> {
  return async (ctx) =>
    observeV2WorkerRun({
      cursorClient: input.cursorClient,
      agentId: ctx.agentId,
      runId: ctx.runId,
      repository: input.repository,
      resolveRemoteBranchTip: input.resolveRemoteBranchTip,
      useFixturePolling: input.useFixturePolling,
      sleep: input.sleep,
    });
}
