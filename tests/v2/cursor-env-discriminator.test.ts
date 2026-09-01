/**
 * Regression: v2 Bellhop worker POST /v1/agents must use env.type="cloud",
 * not the invalid "environment" discriminator that caused the first live failure.
 */
import { describe, expect, it } from "vitest";
import {
  createHttpCursorApiClient,
  type V1CreateAgentRequest,
  type V1CursorEnvironmentType,
} from "../../src/cursor/api-client.js";
import { launchV2Worker, pollWorkerResult } from "../../src/v2/cursor-worker.js";
import {
  assertBellhopCursorEnvironmentPreflight,
  resolveV2ProjectBinding,
} from "../../src/v2/project-binding.js";
import { bellhopObjective } from "../../src/v2/test-fixtures.js";

const BELLHOP_CURSOR_ENV = "timcgha/Bellhop";

function createMockHttpCursorClient() {
  let capturedBody: V1CreateAgentRequest | null = null;
  let capturedUrl: string | null = null;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "POST" && url.endsWith("/v1/agents")) {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as V1CreateAgentRequest;
      const agentId = capturedBody.agentId ?? "bc-mock-bellhop-001";
      const runId = "run-mock-bellhop-001";
      return new Response(
        JSON.stringify({
          agent: {
            id: agentId,
            status: "ACTIVE",
            repos: capturedBody.repos,
            latestRunId: runId,
          },
          run: {
            id: runId,
            agentId,
            status: "RUNNING",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "GET" && url.includes("/runs/")) {
      return new Response(
        JSON.stringify({
          id: "run-mock-bellhop-001",
          agentId: "bc-mock-bellhop-001",
          status: "FINISHED",
          result: "Worker completed.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof fetch;

  const client = createHttpCursorApiClient({
    apiKey: "test-key",
    baseUrl: "https://api.cursor.com",
    fetchImpl,
  });

  return {
    client,
    getCapturedBody: () => capturedBody,
    getCapturedUrl: () => capturedUrl,
  };
}

describe("v2 Cursor environment discriminator", () => {
  it("restricts production env.type to API-supported values", () => {
    const supported: V1CursorEnvironmentType[] = ["cloud", "pool", "machine"];
    expect(supported).toContain("cloud");
    expect(supported).not.toContain("environment");
  });

  it("Bellhop binding resolves timcgha/Bellhop from RADIO_CURSOR_ENV_BELLHOP", () => {
    const binding = resolveV2ProjectBinding(bellhopObjective(), {
      RADIO_CURSOR_ENV_BELLHOP: BELLHOP_CURSOR_ENV,
    });
    expect(binding.projectKey).toBe("bellhop");
    expect(binding.cursorEnvironmentName).toBe(BELLHOP_CURSOR_ENV);
    expect(() => assertBellhopCursorEnvironmentPreflight(binding)).not.toThrow();
  });

  it("POST /v1/agents body uses env.type=cloud for Bellhop via HttpCursorApiClient", async () => {
    const objective = bellhopObjective();
    const binding = resolveV2ProjectBinding(objective, {
      RADIO_CURSOR_ENV_BELLHOP: BELLHOP_CURSOR_ENV,
    });
    const { client, getCapturedBody, getCapturedUrl } = createMockHttpCursorClient();

    const launch = await launchV2Worker({
      objective,
      cursorClient: client,
      projectBinding: binding,
    });

    const body = getCapturedBody();
    expect(getCapturedUrl()).toBe("https://api.cursor.com/v1/agents");
    expect(body).not.toBeNull();

    const serialized = JSON.stringify(body);
    const CURSOR_AGENT_REQUEST_ENV_NAME = body!.env?.name;
    const CURSOR_AGENT_REQUEST_ENV_TYPE = body!.env?.type;
    const INVALID_ENVIRONMENT_DISCRIMINATOR_PRESENT = serialized.includes(
      '"type":"environment"',
    );

    expect(CURSOR_AGENT_REQUEST_ENV_NAME).toBe(BELLHOP_CURSOR_ENV);
    expect(CURSOR_AGENT_REQUEST_ENV_TYPE).toBe("cloud");
    expect(INVALID_ENVIRONMENT_DISCRIMINATOR_PRESENT).toBe(false);
    expect(body!.repos?.[0]?.url).toBe(objective.repository);

    const narrative = await pollWorkerResult({
      cursorClient: client,
      agentId: launch.agentId,
      runId: launch.runId,
    });
    expect(narrative).toBe("Worker completed.");
    expect(launch.agentId).toBeTruthy();
    expect(launch.runId).toBeTruthy();
  });

  it("omits env when project binding has no Cursor environment name", async () => {
    const objective = bellhopObjective({ projectId: "bellhop" });
    const binding = resolveV2ProjectBinding(objective, {});
    expect(binding.cursorEnvironmentName).toBeNull();

    const { client, getCapturedBody } = createMockHttpCursorClient();
    await launchV2Worker({
      objective,
      cursorClient: client,
      projectBinding: binding,
    });

    expect(getCapturedBody()?.env).toBeUndefined();
  });
});
