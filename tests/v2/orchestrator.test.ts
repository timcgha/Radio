import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRepositoryBinding } from "../../src/v2/cursor-worker.js";
import { parseWorkerNarrative } from "../../src/v2/worker-narrative.js";
import { evaluateProductScopeGate } from "../../src/v2/scope.js";
import { verifyStartingSource } from "../../src/v2/source.js";
import { runV2Loop } from "../../src/v2/orchestrator.js";
import { createFixtureSolClient } from "../../src/v2/sol-client.js";
import {
  BELLHOP_REPO,
  IMPLEMENTATION_TIP_B,
  NON_DESCENDANT_TIP,
  STARTING_SHA_A,
  UNSTRUCTURED_WORKER_NARRATIVE,
  WRONG_SHA_C,
  bellhopObjective,
  createCountingCursorClient,
  fakeAncestry,
  fakeMergeBase,
  defaultBellhopMergeBaseMap,
  fakeResolveRemoteBranchTip,
} from "../../src/v2/test-fixtures.js";
import { loadRunState } from "../../src/v2/artifacts.js";

function tmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-v2-run-"));
}

function standardDeps(overrides?: {
  objective?: ReturnType<typeof bellhopObjective>;
  solScript?: Array<"ACCEPT" | "CONTINUE_WORK" | "WORK" | "ASK_HUMAN" | "FAIL" | "VERIFY_MORE">;
  branchTipMap?: Record<string, string>;
  ancestry?: Array<[string, string]>;
  workerOutcome?: {
    narrative: string;
    implementationBranch: string;
    implementationTipSha: string;
  };
  changedFiles?: string[];
}) {
  const objective = overrides?.objective ?? bellhopObjective();
  const branch = overrides?.workerOutcome?.implementationBranch ?? "cursor/foo";
  const tip =
    overrides?.workerOutcome?.implementationTipSha ?? IMPLEMENTATION_TIP_B;
  const branchTipMap = overrides?.branchTipMap ?? {
    [`${BELLHOP_REPO}#main`]: STARTING_SHA_A,
    [`${BELLHOP_REPO}#${branch}`]: tip,
  };
  const ancestry =
    overrides?.ancestry ?? [[STARTING_SHA_A, IMPLEMENTATION_TIP_B]];

  const cursorClient = createCountingCursorClient();
  const solClient = createFixtureSolClient(
    overrides?.solScript ?? ["WORK", "ACCEPT"],
  );

  return {
    objective,
    solClient,
    cursorClient,
    resolveRemoteBranchTip: fakeResolveRemoteBranchTip(branchTipMap),
    verifyCommitAncestry: fakeAncestry(ancestry),
    resolveMergeBase: fakeMergeBase(defaultBellhopMergeBaseMap()),
    listChangedFiles: async () =>
      overrides?.changedFiles ?? ["tests/foo.test.js"],
    obtainWorkerOutcome: async () =>
      overrides?.workerOutcome ?? {
        narrative: UNSTRUCTURED_WORKER_NARRATIVE,
        implementationBranch: branch,
        implementationTipSha: tip,
      },
  };
}

describe("v2 unstructured worker narrative", () => {
  it("parses plain text without JSON schema", () => {
    const reported = parseWorkerNarrative(UNSTRUCTURED_WORKER_NARRATIVE);
    expect(reported.testsPassed).toBe(true);
    expect(reported.buildPassed).toBe(true);
    expect(reported.productBehaviorChanged).toBe(false);
    expect(reported.claimedCommit).toBe(IMPLEMENTATION_TIP_B);
  });
});

describe("v2 wrong source", () => {
  it("hard fails before worker creation when A != C", async () => {
    const cursorClient = createCountingCursorClient();
    const result = await runV2Loop({
      ...standardDeps(),
      objective: bellhopObjective({ expectedStartingSha: STARTING_SHA_A }),
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#main`]: WRONG_SHA_C,
      }),
      cursorClient,
      solClient: createFixtureSolClient(["WORK"]),
    });

    expect(result.state.terminalOutcome).toBe("FAILED_POLICY");
    expect(cursorClient.createCount).toBe(0);
  });
});

describe("v2 wrong repository", () => {
  it("hard fails on repository binding mismatch", () => {
    const cursorClient = createCountingCursorClient();
    expect(() =>
      assertRepositoryBinding(bellhopObjective(), {
        prompt: { text: "x" },
        repos: [{ url: "https://github.com/evil/repo", startingRef: "main" }],
      }),
    ).toThrow(/worker bound to/i);
    expect(cursorClient.createCount).toBe(0);
  });
});

describe("v2 non-descendant tip", () => {
  it("hard fails when ancestry is false", async () => {
    const result = await runV2Loop({
      ...standardDeps({
        solScript: ["ACCEPT"],
        ancestry: [],
        workerOutcome: {
          narrative: UNSTRUCTURED_WORKER_NARRATIVE,
          implementationBranch: "cursor/foo",
          implementationTipSha: NON_DESCENDANT_TIP,
        },
        branchTipMap: {
          [`${BELLHOP_REPO}#main`]: STARTING_SHA_A,
          [`${BELLHOP_REPO}#cursor/foo`]: NON_DESCENDANT_TIP,
        },
      }),
    });

    expect(result.state.terminalOutcome).toBe("FAILED_POLICY");
  });
});

describe("v2 no-fresh-commit", () => {
  it("does not accept when implementation tip equals starting SHA", async () => {
    const result = await runV2Loop({
      ...standardDeps({
        solScript: ["ACCEPT"],
        workerOutcome: {
          narrative: "No changes.",
          implementationBranch: "cursor/foo",
          implementationTipSha: STARTING_SHA_A,
        },
        branchTipMap: {
          [`${BELLHOP_REPO}#main`]: STARTING_SHA_A,
          [`${BELLHOP_REPO}#cursor/foo`]: STARTING_SHA_A,
        },
        ancestry: [[STARTING_SHA_A, STARTING_SHA_A]],
      }),
    });

    expect(result.state.terminalOutcome).toBe("FAILED_POLICY");
    expect(result.summary.startingShaEqualsImplementationTip).toBe(true);
  });
});

describe("v2 product-scope human gate", () => {
  it("routes to HUMAN when test-only scope violated", async () => {
    const result = await runV2Loop({
      ...standardDeps({
        solScript: ["ACCEPT"],
        objective: bellhopObjective({
          testOnlyScope: true,
          testPathPrefixes: ["tests/"],
        }),
        changedFiles: ["src/game.js", "tests/foo.test.js"],
      }),
    });

    expect(result.state.terminalOutcome).toBe("HUMAN");
  });

  it("scope gate detects production file change", () => {
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
        resolvedBaseTipSha: STARTING_SHA_A,
        implementationBranch: "cursor/foo",
        implementationTipSha: IMPLEMENTATION_TIP_B,
        remoteBranchExists: true,
        implementationTipRemoteExists: true,
        freshCommit: true,
        startingShaEqualsImplementationTip: false,
        isAncestorStartingToImplementation: true,
        mergeBaseWithBaseBranch: STARTING_SHA_A,
        implementationSourceOriginOk: true,
        changedFiles: ["src/runtime.js"],
        publicationAvailable: true,
        repositoryBindingOk: true,
        contradictions: [],
        verifiedAt: new Date().toISOString(),
      },
      workerClaimsProductBehaviorChanged: null,
    });
    expect(gate.requiresHuman).toBe(true);
  });
});

describe("v2 Sol CONTINUE_WORK", () => {
  it("performs another bounded work cycle without human relay", async () => {
    const deps = standardDeps({ solScript: ["CONTINUE_WORK", "ACCEPT"] });
    const result = await runV2Loop(deps);

    expect(result.state.terminalOutcome).toBe("DONE");
    expect(deps.cursorClient.createCount).toBe(2);
    expect(result.summary.humanMessagesAfterLaunch).toBe(0);
  });
});

describe("v2 maxWorkerRuns", () => {
  it("blocks third WORK when maxWorkerRuns=2", async () => {
    const result = await runV2Loop({
      ...standardDeps({
        objective: bellhopObjective({ maxWorkerRuns: 2 }),
        solScript: ["CONTINUE_WORK", "CONTINUE_WORK", "CONTINUE_WORK"],
      }),
    });

    expect(result.state.terminalOutcome).toBe("FAILED_POLICY");
    expect(result.state.workerRunsUsed).toBe(2);
  });
});

describe("v2 artifact layout", () => {
  it("persists required artifacts in one run directory", async () => {
    const runDir = tmpRunDir();
    await runV2Loop({
      ...standardDeps({ solScript: ["ACCEPT"] }),
      runDir,
    });

    expect(fs.existsSync(path.join(runDir, "objective.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "plan.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "worker-request.txt"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "worker-result.txt"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "verified-facts.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "decision.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "summary.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "iterations", "01"))).toBe(true);
  });
});

describe("v2 resume state", () => {
  it("persists enough state to resume", async () => {
    const runDir = tmpRunDir();
    await runV2Loop({
      ...standardDeps({ solScript: ["ACCEPT"] }),
      runDir,
    });

    const saved = loadRunState(runDir);
    expect(saved).not.toBeNull();
    expect(saved!.startingSha).toBe(STARTING_SHA_A);
    expect(saved!.lastImplementationTipSha).toBe(IMPLEMENTATION_TIP_B);
    expect(saved!.lastVerifiedFacts).not.toBeNull();
    expect(saved!.lastSolDecision?.action).toBe("ACCEPT");
  });
});

describe("v2 zero-relay end-to-end simulation", () => {
  it("completes Bellhop test-add objective with unstructured worker", async () => {
    const deps = standardDeps({ solScript: ["ACCEPT"] });
    const result = await runV2Loop(deps);

    expect(result.summary.structuredWorkerReportRequired).toBe(false);
    expect(result.summary.reportRepairAttempts).toBe(0);
    expect(result.summary.humanMessagesAfterLaunch).toBe(0);
    expect(result.summary.implementationWorkersCreated).toBe(1);
    expect(result.summary.startingShaEqualsImplementationTip).toBe(false);
    expect(result.summary.startingShaAncestorOfImplementationTip).toBe(true);
    expect(result.state.terminalOutcome).toBe("DONE");
    expect(deps.cursorClient.createCount).toBe(1);
    expect(deps.solClient.callCount).toBe(1);

    const facts = result.state.lastVerifiedFacts!;
    expect(facts.repository).toBe(BELLHOP_REPO);
    expect(facts.changedFiles).toContain("tests/foo.test.js");
    expect(facts.startingSha).toBe(STARTING_SHA_A);
    expect(facts.implementationTipSha).toBe(IMPLEMENTATION_TIP_B);
  });
});

describe("v2 source resolution", () => {
  it("verifies starting pin before work", async () => {
    const resolution = await verifyStartingSource({
      objective: bellhopObjective(),
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#main`]: STARTING_SHA_A,
      }),
    });
    expect(resolution.startingSha).toBe(STARTING_SHA_A);
  });
});
