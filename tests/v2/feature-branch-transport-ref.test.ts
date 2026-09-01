/**
 * Regression: v2 separates Radio authority SHA from Cursor transport startingRef.
 * Cyber feature-branch case + race protection + Bellhop main regression.
 */
import { describe, expect, it } from "vitest";
import {
  buildV2WorkerCreateRequest,
  launchV2Worker,
} from "../../src/v2/cursor-worker.js";
import { runV2Loop } from "../../src/v2/orchestrator.js";
import { createFixtureSolClient } from "../../src/v2/sol-client.js";
import { verifyStartingSource, verifyStartingSourceBeforeDispatch } from "../../src/v2/source.js";
import { deriveVerifiedGitFacts } from "../../src/v2/verify.js";
import {
  BASE_ADVANCED_SHA_B,
  BELLHOP_REPO,
  CYBER_BASE_BRANCH,
  CYBER_EXPECTED_STARTING_SHA,
  CYBER_REPO,
  IMPL_FROM_AUTHORITY_SHA,
  IMPL_FROM_LATER_BASE_SHA,
  IMPLEMENTATION_TIP_B,
  STARTING_SHA_A,
  bellhopObjective,
  createCountingCursorClient,
  cyberObjective,
  defaultBellhopMergeBaseMap,
  fakeAncestry,
  fakeMergeBase,
  fakeResolveRemoteBranchTip,
} from "../../src/v2/test-fixtures.js";
import { classifyCursorLaunchMode, createHttpCursorApiClient, type V1CreateAgentRequest } from "../../src/cursor/api-client.js";

function createCyberMockHttpCursorClient() {
  let capturedBody: V1CreateAgentRequest | null = null;

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as V1CreateAgentRequest;
      const agentId = "bc-mock-cyber-001";
      const runId = "run-mock-cyber-001";
      return new Response(
        JSON.stringify({
          agent: { id: agentId, status: "ACTIVE", repos: capturedBody.repos },
          run: { id: runId, agentId, status: "RUNNING" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "run-mock-cyber-001",
        agentId: "bc-mock-cyber-001",
        status: "FINISHED",
        result: "Cyber worker completed.",
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const client = createHttpCursorApiClient({
    apiKey: "test-key",
    baseUrl: "https://api.cursor.com",
    fetchImpl,
  });

  return {
    client,
    getCapturedBody: () => capturedBody,
  };
}

describe("Cyber feature-branch transport ref", () => {
  it("uses baseBranch as Cursor transport startingRef while preserving authority SHA", () => {
    const objective = cyberObjective();
    const request = buildV2WorkerCreateRequest({ objective });

    const CURSOR_TRANSPORT_STARTING_REF = request.repos[0]!.startingRef;
    const RADIO_AUTHORITY_STARTING_SHA = objective.expectedStartingSha;

    expect(request.repos[0]!.url).toBe(CYBER_REPO);
    expect(CURSOR_TRANSPORT_STARTING_REF).toBe(CYBER_BASE_BRANCH);
    expect(CURSOR_TRANSPORT_STARTING_REF).not.toBe(CYBER_EXPECTED_STARTING_SHA);
    expect(RADIO_AUTHORITY_STARTING_SHA).toBe(CYBER_EXPECTED_STARTING_SHA);
    expect(request.prompt.text).toContain(CYBER_EXPECTED_STARTING_SHA);
    expect(request.env).toBeUndefined();
    expect(classifyCursorLaunchMode(request)).toBe("EXPLICIT_REPOS");
  });
});

describe("Bellhop main transport ref regression", () => {
  it("uses main as Cursor transport ref with authority SHA in prompt", () => {
    const objective = bellhopObjective();
    const request = buildV2WorkerCreateRequest({ objective });

    expect(request.repos[0]!.startingRef).toBe("main");
    expect(request.repos[0]!.startingRef).not.toBe(STARTING_SHA_A);
    expect(request.prompt.text).toContain(STARTING_SHA_A);
  });
});

describe("source moved before dispatch", () => {
  it("does not create worker when final pre-dispatch source differs", async () => {
    let callCount = 0;
    const resolveRemoteBranchTip = async (_input: {
      repositoryUrl: string;
      branch: string;
    }) => {
      callCount += 1;
      if (callCount <= 1) return STARTING_SHA_A;
      return BASE_ADVANCED_SHA_B;
    };

    await expect(
      verifyStartingSourceBeforeDispatch({
        objective: bellhopObjective(),
        resolveRemoteBranchTip: async () => BASE_ADVANCED_SHA_B,
      }),
    ).rejects.toThrow(/expectedStartingSha|SOURCE_REF_PRECHECK_FAILED/);

    const cursorClient = createCountingCursorClient();
    const result = await runV2Loop({
      objective: bellhopObjective(),
      solClient: createFixtureSolClient(["WORK", "ACCEPT"]),
      cursorClient,
      resolveRemoteBranchTip,
      verifyCommitAncestry: fakeAncestry([[STARTING_SHA_A, IMPLEMENTATION_TIP_B]]),
      resolveMergeBase: fakeMergeBase(defaultBellhopMergeBaseMap()),
      listChangedFiles: async () => ["tests/foo.test.js"],
      obtainWorkerOutcome: async () => ({
        narrative: "done",
        implementationBranch: "cursor/foo",
        implementationTipSha: IMPLEMENTATION_TIP_B,
      }),
    });

    const WORKER_CREATED = cursorClient.createCount > 0;
    expect(WORKER_CREATED).toBe(false);
    expect(result.state.terminalOutcome).toBe("FAILED_POLICY");
  });
});

describe("post-work source-origin verification", () => {
  it("rejects implementation that started from later base commit (race)", async () => {
    const facts = await deriveVerifiedGitFacts({
      repository: CYBER_REPO,
      baseBranch: CYBER_BASE_BRANCH,
      startingSha: CYBER_EXPECTED_STARTING_SHA,
      implementationBranch: "cursor/impl-from-b",
      implementationTipSha: IMPL_FROM_LATER_BASE_SHA,
      expectedRepository: CYBER_REPO,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${CYBER_REPO}#${CYBER_BASE_BRANCH}`]: BASE_ADVANCED_SHA_B,
        [`${CYBER_REPO}#cursor/impl-from-b`]: IMPL_FROM_LATER_BASE_SHA,
      }),
      verifyCommitAncestry: fakeAncestry([
        [CYBER_EXPECTED_STARTING_SHA, IMPL_FROM_LATER_BASE_SHA],
        [BASE_ADVANCED_SHA_B, IMPL_FROM_LATER_BASE_SHA],
      ]),
      resolveMergeBase: fakeMergeBase({
        [`${IMPL_FROM_LATER_BASE_SHA}^${BASE_ADVANCED_SHA_B}`]: BASE_ADVANCED_SHA_B,
      }),
      listChangedFiles: async () => ["src/foo.ts"],
    });

    expect(facts.isAncestorStartingToImplementation).toBe(true);
    expect(facts.implementationSourceOriginOk).toBe(false);
    expect(facts.publicationAvailable).toBe(false);
    expect(facts.contradictions.some((c) => /source-origin mismatch/i.test(c))).toBe(
      true,
    );
  });

  it("accepts implementation when base advanced after worker started from authority", async () => {
    const facts = await deriveVerifiedGitFacts({
      repository: BELLHOP_REPO,
      baseBranch: "main",
      startingSha: STARTING_SHA_A,
      implementationBranch: "cursor/impl-from-a",
      implementationTipSha: IMPL_FROM_AUTHORITY_SHA,
      expectedRepository: BELLHOP_REPO,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#main`]: BASE_ADVANCED_SHA_B,
        [`${BELLHOP_REPO}#cursor/impl-from-a`]: IMPL_FROM_AUTHORITY_SHA,
      }),
      verifyCommitAncestry: fakeAncestry([
        [STARTING_SHA_A, IMPL_FROM_AUTHORITY_SHA],
        [STARTING_SHA_A, BASE_ADVANCED_SHA_B],
      ]),
      resolveMergeBase: fakeMergeBase({
        [`${IMPL_FROM_AUTHORITY_SHA}^${BASE_ADVANCED_SHA_B}`]: STARTING_SHA_A,
      }),
      listChangedFiles: async () => ["tests/foo.test.js"],
    });

    expect(facts.implementationSourceOriginOk).toBe(true);
    expect(facts.mergeBaseWithBaseBranch).toBe(STARTING_SHA_A);
    expect(facts.publicationAvailable).toBe(true);
  });
});

describe("Cyber production HTTP request (mocked)", () => {
  it("captures branch transport ref and continues v2 after fake create", async () => {
    const objective = cyberObjective();
    const { client, getCapturedBody } = createCyberMockHttpCursorClient();

    const launch = await launchV2Worker({ objective, cursorClient: client });
    const body = getCapturedBody();

    const CURSOR_TRANSPORT_STARTING_REF = body?.repos?.[0]?.startingRef;
    const RADIO_AUTHORITY_STARTING_SHA = objective.expectedStartingSha;

    expect(CURSOR_TRANSPORT_STARTING_REF).toBe(CYBER_BASE_BRANCH);
    expect(RADIO_AUTHORITY_STARTING_SHA).toBe(CYBER_EXPECTED_STARTING_SHA);
    expect(launch.agentId).toBe("bc-mock-cyber-001");

    const cursorClient = createCountingCursorClient();
    const result = await runV2Loop({
      objective,
      solClient: createFixtureSolClient(["ACCEPT"]),
      cursorClient,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${CYBER_REPO}#${CYBER_BASE_BRANCH}`]: CYBER_EXPECTED_STARTING_SHA,
        [`${CYBER_REPO}#cursor/cyber-impl`]: IMPL_FROM_AUTHORITY_SHA,
      }),
      verifyCommitAncestry: fakeAncestry([
        [CYBER_EXPECTED_STARTING_SHA, IMPL_FROM_AUTHORITY_SHA],
      ]),
      resolveMergeBase: fakeMergeBase({
        [`${IMPL_FROM_AUTHORITY_SHA}^${CYBER_EXPECTED_STARTING_SHA}`]:
          CYBER_EXPECTED_STARTING_SHA,
      }),
      listChangedFiles: async () => ["tests/cyber.test.ts"],
      obtainWorkerOutcome: async () => ({
        narrative: "tests passed",
        implementationBranch: "cursor/cyber-impl",
        implementationTipSha: IMPL_FROM_AUTHORITY_SHA,
      }),
    });

    const FAKE_CYBER_CURSOR_CREATE_CONTINUES = result.state.terminalOutcome === "DONE";
    expect(FAKE_CYBER_CURSOR_CREATE_CONTINUES).toBe(true);
    expect(cursorClient.lastRequest?.repos?.[0]?.startingRef).toBe(
      CYBER_BASE_BRANCH,
    );
    expect(cursorClient.lastRequest?.prompt.text).toContain(
      CYBER_EXPECTED_STARTING_SHA,
    );
  });
});

describe("pre-dispatch source verification preserved", () => {
  it("still requires resolved base tip equals expectedStartingSha", async () => {
    const objective = cyberObjective();
    const pass = await verifyStartingSource({
      objective,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${CYBER_REPO}#${CYBER_BASE_BRANCH}`]: CYBER_EXPECTED_STARTING_SHA,
      }),
    });
    expect(pass.resolvedBaseSha).toBe(CYBER_EXPECTED_STARTING_SHA);
    expect(pass.startingSha).toBe(CYBER_EXPECTED_STARTING_SHA);
  });
});
