/**
 * Production dependency factory for Radio v2.
 * One boring wiring point — CLI and tests share the same orchestration path.
 */

import {
  canLiveCursorDispatch,
  createHttpCursorApiClient,
  isHttpCursorApiClient,
  resolveCursorApiKey,
  type CursorApiClient,
} from "../cursor/api-client.js";
import {
  resolveRemoteBranchTipViaGitLsRemote,
  type ResolveRemoteBranchTip,
} from "../cursor/source-ref.js";
import { verifyCommitAncestryViaGitFetch, resolveMergeBaseViaGitFetch } from "../cursor/remote-publication-verify.js";
import type { V2Objective, V2RunState } from "./types.js";
import { validateV2Objective } from "./objective.js";
import { loadRunState } from "./artifacts.js";
import type { V2OrchestratorDeps } from "./orchestrator.js";
import type { V2SolClient } from "./sol-client.js";
import { createLiveSolClient } from "./sol-live.js";
import { createObtainWorkerOutcome } from "./cursor-live.js";
import { listChangedFilesViaGitFetch } from "./git-changed-files.js";
import {
  resolveV2ProjectBinding,
  type V2ProjectBinding,
} from "./project-binding.js";

export class V2PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2PreflightError";
  }
}

export interface V2ProductionOverrides {
  env?: NodeJS.ProcessEnv;
  solClient?: V2SolClient;
  cursorClient?: CursorApiClient;
  resolveRemoteBranchTip?: ResolveRemoteBranchTip;
  verifyCommitAncestry?: typeof verifyCommitAncestryViaGitFetch;
  resolveMergeBase?: typeof resolveMergeBaseViaGitFetch;
  listChangedFiles?: V2OrchestratorDeps["listChangedFiles"];
  obtainWorkerOutcome?: V2OrchestratorDeps["obtainWorkerOutcome"];
  projectBinding?: V2ProjectBinding;
  skipPreflight?: boolean;
  useFixturePolling?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface V2ProductionDepsResult {
  deps: V2OrchestratorDeps;
  projectBinding: V2ProjectBinding;
  runDir: string;
}

export function assertV2LivePreflight(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.OPENAI_API_KEY?.trim()) {
    throw new V2PreflightError(
      "OPENAI_API_KEY is required for live Radio v2 execution",
    );
  }
  if (!canLiveCursorDispatch(env)) {
    throw new V2PreflightError(
      "Live Cursor dispatch requires CURSOR_EXECUTION_ENABLED=true and CURSOR_API_KEY",
    );
  }
}

export async function createV2ProductionDeps(input: {
  objective?: V2Objective;
  runDir: string;
  resumeState?: V2RunState | null;
  overrides?: V2ProductionOverrides;
}): Promise<V2ProductionDepsResult> {
  const env = input.overrides?.env ?? process.env;
  const resumeState =
    input.resumeState ??
    (input.runDir ? loadRunState(input.runDir) : null);

  const objective = validateV2Objective(
    input.objective ?? resumeState?.objective,
  );
  if (!objective) {
    throw new V2PreflightError("objective is required");
  }

  if (!input.overrides?.skipPreflight) {
    assertV2LivePreflight(env);
  }

  const projectBinding =
    input.overrides?.projectBinding ??
    resolveV2ProjectBinding(objective, env);

  const resolveRemoteBranchTip =
    input.overrides?.resolveRemoteBranchTip ??
    resolveRemoteBranchTipViaGitLsRemote;

  const verifyCommitAncestry =
    input.overrides?.verifyCommitAncestry ?? verifyCommitAncestryViaGitFetch;

  const resolveMergeBase =
    input.overrides?.resolveMergeBase ?? resolveMergeBaseViaGitFetch;

  const listChangedFiles =
    input.overrides?.listChangedFiles ??
    (async (ctx: {
      repositoryUrl: string;
      baseSha: string;
      tipSha: string;
    }) =>
      listChangedFilesViaGitFetch({
        repositoryUrl: ctx.repositoryUrl,
        baseSha: ctx.baseSha,
        tipSha: ctx.tipSha,
        verifyCommitAncestry,
      }));

  const cursorClient =
    input.overrides?.cursorClient ??
    createHttpCursorApiClient({
      apiKey: resolveCursorApiKey(env)!,
      baseUrl: env.CURSOR_API_BASE_URL?.trim() || "https://api.cursor.com",
    });

  const useFixturePolling =
    input.overrides?.useFixturePolling ??
    !isHttpCursorApiClient(cursorClient);

  const obtainWorkerOutcome =
    input.overrides?.obtainWorkerOutcome ??
    createObtainWorkerOutcome({
      cursorClient,
      repository: projectBinding.authorizedRepository,
      resolveRemoteBranchTip,
      useFixturePolling,
      sleep: input.overrides?.sleep,
    });

  const solClient =
    input.overrides?.solClient ??
    createLiveSolClient({
      apiKey: env.OPENAI_API_KEY!.trim(),
      model: env.RADIO_MODEL?.trim(),
    });

  const deps: V2OrchestratorDeps = {
    objective,
    solClient,
    cursorClient,
    resolveRemoteBranchTip,
    verifyCommitAncestry,
    resolveMergeBase,
    listChangedFiles,
    obtainWorkerOutcome,
    runDir: input.runDir,
    resumeState: resumeState ?? undefined,
    projectBinding,
  };

  return {
    deps,
    projectBinding,
    runDir: input.runDir,
  };
}
