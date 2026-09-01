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
    `Repository: ${objective.repository}`,
    `Base branch: ${objective.baseBranch}`,
    `Starting SHA: ${objective.expectedStartingSha}`,
    "",
    "Return a concise narrative when done. Include:",
    "- changed files",
    "- test results",
    "- build status",
    "- branch and commit pushed",
    "- whether product behavior changed",
    "",
    "No structured completion report is required.",
  ].join("\n");
}

/**
 * Build the v2 production POST /v1/agents body in explicit-repos mode.
 * Uses objective.expectedStartingSha (not baseBranch) for exact source pin.
 * No named cloud environment — repos and env.name are mutually exclusive.
 */
export function buildV2WorkerCreateRequest(input: {
  objective: V2Objective;
  agentId?: string;
}): V1ExplicitReposCreateAgentRequest {
  return {
    prompt: { text: buildWorkerPrompt(input.objective) },
    repos: [
      {
        url: input.objective.repository,
        startingRef: input.objective.expectedStartingSha,
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
