/**
 * Low-level Cursor Cloud Agents API client (v0 surface).
 * Secrets must come from environment — never embed keys in work orders or artifacts.
 */

export interface CursorLaunchRequest {
  prompt: { text: string };
  model?: string;
  source: {
    repository: string;
    ref?: string;
  };
  target?: {
    autoCreatePr?: boolean;
    branchName?: string;
    autoBranch?: boolean;
  };
}

export interface CursorAgentRecord {
  id: string;
  name?: string;
  status: string;
  source?: {
    repository?: string;
    ref?: string;
  };
  target?: {
    branchName?: string;
    url?: string;
    prUrl?: string | null;
    autoCreatePr?: boolean;
  };
  summary?: string;
  createdAt?: string;
}

export interface CursorConversationMessage {
  id: string;
  type: string;
  text: string;
}

export interface CursorConversation {
  id: string;
  messages: CursorConversationMessage[];
}

export interface CursorApiClient {
  launchAgent(request: CursorLaunchRequest): Promise<CursorAgentRecord>;
  getAgent(agentId: string): Promise<CursorAgentRecord>;
  getConversation(agentId: string): Promise<CursorConversation>;
  listAgents(limit?: number): Promise<CursorAgentRecord[]>;
}

export class CursorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
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

/**
 * HTTP client for https://api.cursor.com/v0/*
 * Auth: Basic (apiKey as username, empty password) or Bearer.
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
      throw new CursorApiError(
        `Cursor API ${method} ${path} failed with ${res.status}`,
        res.status,
        text,
      );
    }
    if (!text) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  }

  return {
    async launchAgent(launchRequest) {
      return request<CursorAgentRecord>("POST", "/v0/agents", launchRequest);
    },
    async getAgent(agentId) {
      return request<CursorAgentRecord>(
        "GET",
        `/v0/agents/${encodeURIComponent(agentId)}`,
      );
    },
    async getConversation(agentId) {
      return request<CursorConversation>(
        "GET",
        `/v0/agents/${encodeURIComponent(agentId)}/conversation`,
      );
    },
    async listAgents(limit = 100) {
      const data = await request<{ agents: CursorAgentRecord[] }>(
        "GET",
        `/v0/agents?limit=${limit}`,
      );
      return data.agents ?? [];
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
 * Live Cursor dispatch requires BOTH an API key and an explicit execution enable flag.
 * Presence of CURSOR_API_KEY alone is not authorization to launch.
 */
export function canLiveCursorDispatch(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isCursorExecutionEnabled(env) && resolveCursorApiKey(env) !== null;
}
