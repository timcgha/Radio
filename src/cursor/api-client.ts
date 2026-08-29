/**
 * Low-level Cursor Cloud Agents API client (official public-beta v1).
 * Secrets must come from environment — never embed keys in work orders or artifacts.
 *
 * Models the v1 durable-agent + per-run distinction:
 *   POST /v1/agents
 *   GET  /v1/agents/{agentId}
 *   GET  /v1/agents/{agentId}/runs/{runId}
 *   GET  /v1/agents/{agentId}/usage
 *   GET  /v1/me
 */

export interface V1Prompt {
  text: string;
}

export interface V1RepoInput {
  url: string;
  startingRef?: string;
  prUrl?: string;
}

export interface V1CreateAgentRequest {
  prompt: V1Prompt;
  repos?: V1RepoInput[];
  autoCreatePR?: boolean;
  /** Omit unless Radio has an explicit documented reason to select one. */
  model?: { id: string; params?: Array<{ id: string; value: string }> };
  mode?: "agent" | "plan";
  /** Client-supplied idempotent id: bc-<uuid> */
  agentId?: string;
  name?: string;
  workOnCurrentBranch?: boolean;
}

export interface V1Agent {
  id: string;
  name?: string;
  status: string;
  env?: { type?: string; name?: string };
  repos?: V1RepoInput[];
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  latestRunId?: string;
}

export interface V1RunGitBranch {
  repoUrl: string;
  branch?: string;
  prUrl?: string;
}

export interface V1Run {
  id: string;
  agentId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
  result?: string;
  git?: { branches?: V1RunGitBranch[] };
}

export interface V1CreateAgentResponse {
  agent: V1Agent;
  run: V1Run;
}

export interface V1TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface V1AgentUsage {
  totalUsage: V1TokenUsage;
  runs: Array<{
    id: string;
    usageUuid?: string;
    usage: V1TokenUsage;
  }>;
}

export interface V1Me {
  apiKeyName?: string;
  createdAt?: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
}

export type RadioCursorClientKind = "http" | "fixture" | "test";

export interface CursorApiClient {
  /** Distinguishes real HTTP transport from fixture/test doubles. */
  readonly radioClientKind?: RadioCursorClientKind;
  createAgent(request: V1CreateAgentRequest): Promise<V1CreateAgentResponse>;
  getAgent(agentId: string): Promise<V1Agent>;
  getRun(agentId: string, runId: string): Promise<V1Run>;
  getAgentUsage(agentId: string, runId?: string): Promise<V1AgentUsage>;
  getMe(): Promise<V1Me>;
}

export function isHttpCursorApiClient(client: CursorApiClient): boolean {
  return client.radioClientKind === "http";
}

export class CursorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CursorApiError";
  }
}

export interface HttpCursorApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Strip secrets / auth material from error text before persistence or logging. */
export function sanitizeCursorErrorText(text: string): string {
  return text
    .replace(/Authorization:\s*\S+/gi, "Authorization: [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/CURSOR_API_KEY[=:]\s*\S+/gi, "CURSOR_API_KEY=[REDACTED]");
}

function extractErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: string; code?: string };
    return parsed.error ?? parsed.code;
  } catch {
    return undefined;
  }
}

/**
 * HTTP client for https://api.cursor.com/v1/*
 * Auth: Basic (apiKey as username, empty password) or Bearer — both accepted by Cursor.
 */
export function createHttpCursorApiClient(
  options: HttpCursorApiClientOptions,
): CursorApiClient {
  const baseUrl = (options.baseUrl ?? "https://api.cursor.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const authHeader =
    "Basic " + Buffer.from(`${options.apiKey}:`, "utf8").toString("base64");

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      const sanitized = sanitizeCursorErrorText(text);
      throw new CursorApiError(
        `Cursor API ${method} ${path} failed with ${res.status}`,
        res.status,
        sanitized,
        extractErrorCode(text),
      );
    }
    if (!text) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  }

  return {
    radioClientKind: "http",
    async createAgent(createRequest) {
      return request<V1CreateAgentResponse>("POST", "/v1/agents", createRequest);
    },
    async getAgent(agentId) {
      return request<V1Agent>(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}`,
      );
    },
    async getRun(agentId, runId) {
      return request<V1Run>(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      );
    },
    async getAgentUsage(agentId, runId) {
      const qs = runId ? `?runId=${encodeURIComponent(runId)}` : "";
      return request<V1AgentUsage>(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}/usage${qs}`,
      );
    },
    async getMe() {
      return request<V1Me>("GET", "/v1/me");
    },
  };
}

export function resolveCursorApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const key = env.CURSOR_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function isCursorExecutionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.CURSOR_EXECUTION_ENABLED ?? "false").toLowerCase() === "true";
}

/**
 * Environment portion of the live Cursor gate:
 * CURSOR_EXECUTION_ENABLED=true AND CURSOR_API_KEY present.
 * Presence of CURSOR_API_KEY alone is not authorization to launch.
 * Full live authorization also requires explicit --transmit and non-fixture mode
 * (see isLiveTransmitAuthorized).
 */
export function canLiveCursorDispatch(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isCursorExecutionEnabled(env) && resolveCursorApiKey(env) !== null;
}

/**
 * Full live-transport authorization:
 * explicitTransmitMode AND executionEnabled AND apiKeyPresent AND NOT fixtureMode.
 */
export function isLiveTransmitAuthorized(input: {
  explicitTransmitMode: boolean;
  fixtureMode: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return (
    input.explicitTransmitMode &&
    !input.fixtureMode &&
    canLiveCursorDispatch(input.env)
  );
}
