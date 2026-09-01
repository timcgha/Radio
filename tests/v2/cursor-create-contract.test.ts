/**
 * Regression: v2 worker POST /v1/agents must align with Cursor v1 contract.
 * - explicit repos mode (no named cloud env)
 * - exact expectedStartingSha as startingRef
 * - named cloud env + repos are mutually exclusive
 */
import { describe, expect, it } from "vitest";
import {
  buildNamedCloudEnvCreateAgentRequest,
  classifyCursorLaunchMode,
  createHttpCursorApiClient,
  hasNamedCloudEnvPlusRepos,
  type V1CreateAgentRequest,
  type V1CursorEnvironmentType,
} from "../../src/cursor/api-client.js";
import {
  buildV2WorkerCreateRequest,
  launchV2Worker,
  pollWorkerResult,
} from "../../src/v2/cursor-worker.js";
import { createV2ProductionDeps } from "../../src/v2/deps.js";
import { runV2Loop } from "../../src/v2/orchestrator.js";
import { createFixtureSolClient } from "../../src/v2/sol-client.js";
import {
  BELLHOP_REPO,
  STARTING_SHA_A,
  bellhopObjective,
  createCountingCursorClient,
  fakeAncestry,
  fakeResolveRemoteBranchTip,
} from "../../src/v2/test-fixtures.js";
import { verifyStartingSource } from "../../src/v2/source.js";
import { evaluateProductScopeGate } from "../../src/v2/scope.js";

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

describe("Cursor v1 contract (documented)", () => {
  it("restricts env.type to cloud | pool | machine", () => {
    const supported: V1CursorEnvironmentType[] = ["cloud", "pool", "machine"];
    expect(supported).toContain("cloud");
    expect(supported).not.toContain("environment");
  });

  it("detects invalid hybrid named cloud env + repos", () => {
    const hybrid: V1CreateAgentRequest = {
      prompt: { text: "x" },
      env: { type: "cloud", name: BELLHOP_CURSOR_ENV },
      repos: [{ url: BELLHOP_REPO, startingRef: STARTING_SHA_A }],
    };
    expect(hasNamedCloudEnvPlusRepos(hybrid)).toBe(true);
    expect(classifyCursorLaunchMode(hybrid)).toBe("NAMED_CLOUD_ENV");
  });
});

describe("v2 explicit-repos production HTTP body (Bellhop)", () => {
  it("POST /v1/agents uses repos with exact SHA and no env.name", async () => {
    const objective = bellhopObjective();
    const { client, getCapturedBody, getCapturedUrl } = createMockHttpCursorClient();

    const launch = await launchV2Worker({
      objective,
      cursorClient: client,
    });

    const body = getCapturedBody();
    expect(getCapturedUrl()).toBe("https://api.cursor.com/v1/agents");
    expect(body).not.toBeNull();
    expect(body!.repos).toHaveLength(1);
    expect(body!.repos![0]!.url).toBe(BELLHOP_REPO);
    expect(body!.repos![0]!.startingRef).toBe(STARTING_SHA_A);
    expect(body!.env).toBeUndefined();

    const CURSOR_CREATE_MODE = classifyCursorLaunchMode(body!);
    const NAMED_ENV_PRESENT = body!.env?.name !== undefined;
    const REPOS_PRESENT = (body!.repos?.length ?? 0) > 0;
    const STARTING_REF_EXACT_SHA =
      body!.repos![0]!.startingRef === objective.expectedStartingSha;

    expect(CURSOR_CREATE_MODE).toBe("EXPLICIT_REPOS");
    expect(NAMED_ENV_PRESENT).toBe(false);
    expect(REPOS_PRESENT).toBe(true);
    expect(STARTING_REF_EXACT_SHA).toBe(true);
    expect(body!.workOnCurrentBranch).toBe(false);

    const narrative = await pollWorkerResult({
      cursorClient: client,
      agentId: launch.agentId,
      runId: launch.runId,
    });
    expect(narrative).toBe("Worker completed.");
  });

  it("buildV2WorkerCreateRequest propagates full 40-char objective SHA", () => {
    const objective = bellhopObjective();
    const request = buildV2WorkerCreateRequest({ objective });
    expect(request.repos[0]!.startingRef).toBe(STARTING_SHA_A);
    expect(request.repos[0]!.startingRef).toHaveLength(40);
    expect(request.repos[0]!.startingRef).not.toBe("main");
    expect(request.repos[0]!.startingRef).toBe(objective.expectedStartingSha);
  });
});

describe("v2 named cloud env mode (generic support, not Bellhop)", () => {
  it("buildNamedCloudEnvCreateAgentRequest omits repos", () => {
    const request = buildNamedCloudEnvCreateAgentRequest({
      prompt: { text: "example" },
      env: { type: "cloud", name: "example" },
      model: { id: "composer-2.5" },
    });
    expect(request.env).toEqual({ type: "cloud", name: "example" });
    expect(request.repos).toBeUndefined();
    expect(classifyCursorLaunchMode(request)).toBe("NAMED_CLOUD_ENV");
    expect(hasNamedCloudEnvPlusRepos(request)).toBe(false);
  });
});

describe("invalid hybrid cannot be produced by v2 builder", () => {
  it("NAMED_CLOUD_PLUS_REPOS_REPRESENTABLE=false for production builder", () => {
    const request = buildV2WorkerCreateRequest({ objective: bellhopObjective() });
    const NAMED_CLOUD_PLUS_REPOS_REPRESENTABLE = hasNamedCloudEnvPlusRepos(request);
    expect(NAMED_CLOUD_PLUS_REPOS_REPRESENTABLE).toBe(false);
  });
});

describe("exact live failure regression (mocked HTTP)", () => {
  it("old hybrid would be invalid; new builder proceeds past worker creation", async () => {
    const oldHybridWouldBeInvalid = hasNamedCloudEnvPlusRepos({
      prompt: { text: "x" },
      env: { type: "cloud", name: BELLHOP_CURSOR_ENV },
      repos: [{ url: BELLHOP_REPO, startingRef: STARTING_SHA_A }],
    });
    expect(oldHybridWouldBeInvalid).toBe(true);

    const cursorClient = createCountingCursorClient();
    const result = await runV2Loop({
      objective: bellhopObjective(),
      solClient: createFixtureSolClient(["WORK", "ACCEPT"]),
      cursorClient,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#main`]: STARTING_SHA_A,
        [`${BELLHOP_REPO}#cursor/foo`]:
          "b5480ae90117d676d349a1da97b06ccb75e66dfd",
      }),
      verifyCommitAncestry: fakeAncestry([
        [
          STARTING_SHA_A,
          "b5480ae90117d676d349a1da97b06ccb75e66dfd",
        ],
      ]),
      listChangedFiles: async () => ["tests/foo.test.js"],
      obtainWorkerOutcome: async () => ({
        narrative: "tests passed. build passed.",
        implementationBranch: "cursor/foo",
        implementationTipSha: "b5480ae90117d676d349a1da97b06ccb75e66dfd",
      }),
    });

    const body = cursorClient.lastRequest!;
    const FAKE_CURSOR_CREATE_CONTINUES_V2 = result.state.terminalOutcome === "DONE";
    expect(FAKE_CURSOR_CREATE_CONTINUES_V2).toBe(true);
    expect(classifyCursorLaunchMode(body)).toBe("EXPLICIT_REPOS");
    expect(body.env?.name).toBeUndefined();
    expect(body.repos?.[0]?.startingRef).toBe(STARTING_SHA_A);
  });
});

describe("v2 preflight without RADIO_CURSOR_ENV_BELLHOP", () => {
  it("production deps succeed when Bellhop env var is absent", async () => {
    const { projectBinding } = await createV2ProductionDeps({
      objective: bellhopObjective(),
      runDir: "/tmp/radio-v2-preflight-test",
      overrides: {
        skipPreflight: true,
        env: {
          OPENAI_API_KEY: "test-key",
          CURSOR_API_KEY: "test-key",
          CURSOR_EXECUTION_ENABLED: "true",
        },
      },
    });
    expect(projectBinding.cursorEnvironmentName).toBeNull();
  });
});

describe("v2 source verification regression", () => {
  it("verifyStartingSource still compares remote tip to expectedStartingSha", async () => {
    const objective = bellhopObjective();
    const pass = await verifyStartingSource({
      objective,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#main`]: STARTING_SHA_A,
      }),
    });
    expect(pass.resolvedBaseSha).toBe(STARTING_SHA_A);

    await expect(
      verifyStartingSource({
        objective,
        resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
          [`${BELLHOP_REPO}#main`]: "cccccccccccccccccccccccccccccccccccccccc",
        }),
      }),
    ).rejects.toThrow(/SOURCE_REF_PRECHECK_FAILED|expectedStartingSha/);
  });
});

describe("v2 hard gate regression", () => {
  it("product scope gate still routes non-test files to HUMAN", () => {
    const gate = evaluateProductScopeGate({
      objective: bellhopObjective({
        testOnlyScope: true,
        testPathPrefixes: ["tests/"],
      }),
      verifiedFacts: {
        repository: BELLHOP_REPO,
        baseBranch: "main",
        startingSha: STARTING_SHA_A,
        resolvedBaseSha: STARTING_SHA_A,
        implementationBranch: "cursor/foo",
        implementationTipSha: "b5480ae90117d676d349a1da97b06ccb75e66dfd",
        remoteBranchExists: true,
        implementationTipRemoteExists: true,
        freshCommit: true,
        startingShaEqualsImplementationTip: false,
        isAncestorStartingToImplementation: true,
        changedFiles: ["tests/foo.test.js", "src/game.js"],
        publicationAvailable: true,
        repositoryBindingOk: true,
        contradictions: [],
        verifiedAt: new Date().toISOString(),
      },
      workerClaimsProductBehaviorChanged: false,
    });
    expect(gate.requiresHuman).toBe(true);
  });
});
