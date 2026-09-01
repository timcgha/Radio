/**
 * V2 Cursor worker creation with repository binding enforcement.
 */

import type {
  CursorApiClient,
  V1CreateAgentRequest,
  V1ExplicitReposCreateAgentRequest,
} from "../cursor/api-client.js";
import type { V2Objective } from "./types.js";
import { DEFAULT_APPROVED_CURSOR_WORKER_MODEL } from "../runtime/cursor-worker-model.js";
import { nowIso } from "../util/io.js";

export class V2RepositoryBindingError extends Error {
  readonly code = "V2_REPOSITORY_BINDING_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "V2RepositoryBindingError";
  }
}

export interface V2WorkerLaunchResult {
  agentId: string;
  runId: string;
  requestText: string;
  launchedAt: string;
}

export function buildWorkerPrompt(objective: V2Objective): string {
  return [
    `Objective: ${objective.humanInstruction}`,
    "",
    "==================================================",
    "SOURCE CONTEXT (READ-ONLY)",
    "==================================================",
    `Repository: ${objective.repository}`,
    `Source branch (Cursor transport only): ${objective.baseBranch}`,
    `Authority starting SHA: ${objective.expectedStartingSha}`,
    "",
    "The source branch above is transport/context only — not an implementation destination.",
    "Do not push, modify, or treat it as the publication target.",
    "Radio authority remains the authority starting SHA above.",
    "",
    "==================================================",
    "GIT / PUBLICATION RULE",
    "==================================================",
    "Remain on the branch/worktree supplied by Cursor Cloud.",
    "Do not checkout, create, rename, reset, force-push, or explicitly push any named branch.",
    "Never push or modify the source branch.",
    "Make the required code changes and run the required verification.",
    "Allow the Cursor Cloud agent workflow to publish its assigned implementation branch.",
    "",
    "==================================================",
    "YOUR RESPONSIBILITIES",
    "==================================================",
    "- Understand the objective",
    "- Inspect the current code",
    "- Make the smallest appropriate implementation",
    "- Run applicable tests, typecheck, lint, and build where appropriate",
    "- Avoid unrelated changes",
    "- Return a concise completion narrative",
    "",
    "Report in your narrative:",
    "- changed files",
    "- test results",
    "- build status",
    "- what you changed (commit details are handled by Cursor Cloud publication)",
    "- whether product behavior changed",
    "",
    "No structured completion report is required.",
  ].join("\n");
}

/**
 * Cursor transport ref for POST /v1/agents — distinct from Radio authority SHA.
 * Feature-branch commits may be rejected as startingRef; branch name is required.
 */
export function resolveV2CursorTransportStartingRef(
  objective: V2Objective,
): string {
  const cursorTransportStartingRef = objective.baseBranch.trim();
  if (!cursorTransportStartingRef) {
    throw new Error("objective.baseBranch is required for Cursor transport ref");
  }
  return cursorTransportStartingRef;
}

/**
 * Build the v2 production POST /v1/agents body in explicit-repos mode.
 * Authority remains objective.expectedStartingSha (prompt + verification).
 * Cursor transport uses objective.baseBranch as startingRef.
 * No named cloud environment — repos and env.name are mutually exclusive.
 */
export function buildV2WorkerCreateRequest(input: {
  objective: V2Objective;
  agentId?: string;
}): V1ExplicitReposCreateAgentRequest {
  const cursorTransportStartingRef = resolveV2CursorTransportStartingRef(
    input.objective,
  );
  return {
    prompt: { text: buildWorkerPrompt(input.objective) },
    repos: [
      {
        url: input.objective.repository,
        startingRef: cursorTransportStartingRef,
      },
    ],
    model: { id: DEFAULT_APPROVED_CURSOR_WORKER_MODEL },
    mode: "agent",
    agentId: input.agentId,
    workOnCurrentBranch: false,
  };
}

export function assertRepositoryBinding(
  objective: V2Objective,
  request: V1CreateAgentRequest,
): void {
  const repoUrl = request.repos?.[0]?.url?.trim();
  if (!repoUrl) {
    throw new V2RepositoryBindingError("worker request missing repository URL");
  }
  if (repoUrl !== objective.repository.trim()) {
    throw new V2RepositoryBindingError(
      `worker bound to ${repoUrl} but objective authorizes ${objective.repository}`,
    );
  }
}

export async function launchV2Worker(input: {
  objective: V2Objective;
  cursorClient: CursorApiClient;
  agentId?: string;
}): Promise<V2WorkerLaunchResult> {
  const request = buildV2WorkerCreateRequest({
    objective: input.objective,
    agentId: input.agentId,
  });

  assertRepositoryBinding(input.objective, request);

  const response = await input.cursorClient.createAgent(request);
  return {
    agentId: response.agent.id,
    runId: response.run.id,
    requestText: request.prompt.text,
    launchedAt: nowIso(),
  };
}

export async function pollWorkerResult(input: {
  cursorClient: CursorApiClient;
  agentId: string;
  runId: string;
  getResult?: (agentId: string, runId: string) => Promise<string>;
}): Promise<string> {
  if (input.getResult) {
    return input.getResult(input.agentId, input.runId);
  }

  const run = await input.cursorClient.getRun(input.agentId, input.runId);
  if (run.status !== "FINISHED" && run.status !== "COMPLETED") {
    throw new Error(`worker run not complete: ${run.status}`);
  }
  return run.result ?? "";
}
