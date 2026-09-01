import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { launchV2Worker } from "../../src/v2/cursor-worker.js";
import { runV2Cli } from "../../src/v2/cli.js";
import { createV2ProductionDeps } from "../../src/v2/deps.js";
import { resumeV2Loop } from "../../src/v2/orchestrator.js";
import { createFixtureSolClient } from "../../src/v2/sol-client.js";
import { evaluateProductScopeGate } from "../../src/v2/scope.js";
import { deriveVerifiedGitFacts } from "../../src/v2/verify.js";
import {
  BELLHOP_REPO,
  IMPLEMENTATION_TIP_B,
  STARTING_SHA_A,
  UNSTRUCTURED_WORKER_NARRATIVE,
  bellhopObjective,
  createCountingCursorClient,
  fakeAncestry,
  fakeResolveRemoteBranchTip,
} from "../../src/v2/test-fixtures.js";
import { resolveV2ProjectBinding } from "../../src/v2/project-binding.js";
import { V2_SCHEMA_VERSION } from "../../src/v2/types.js";
import type { V2RunState } from "../../src/v2/types.js";

function tmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-v2-cli-"));
}

function writeObjectiveFile(dir: string): string {
  const objectivePath = path.join(dir, "objective.json");
  fs.writeFileSync(
    objectivePath,
    JSON.stringify(bellhopObjective(), null, 2),
  );
  return objectivePath;
}

function standardOverrides(solScript: Array<"ACCEPT" | "CONTINUE_WORK"> = ["ACCEPT"]) {
  const branch = "cursor/foo";
  const cursorClient = createCountingCursorClient();
  return {
    skipPreflight: true,
    cursorClient,
    solClient: createFixtureSolClient(solScript),
    resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
      [`${BELLHOP_REPO}#main`]: STARTING_SHA_A,
      [`${BELLHOP_REPO}#${branch}`]: IMPLEMENTATION_TIP_B,
    }),
    verifyCommitAncestry: fakeAncestry([[STARTING_SHA_A, IMPLEMENTATION_TIP_B]]),
    listChangedFiles: async () => ["tests/foo.test.js"],
    obtainWorkerOutcome: async () => ({
      narrative: UNSTRUCTURED_WORKER_NARRATIVE,
      implementationBranch: branch,
      implementationTipSha: IMPLEMENTATION_TIP_B,
    }),
    projectBinding: resolveV2ProjectBinding(bellhopObjective()),
    useFixturePolling: true,
  };
}

describe("v2 production dependency factory", () => {
  it("wires listChangedFiles for production path", async () => {
    const { deps } = await createV2ProductionDeps({
      objective: bellhopObjective(),
      runDir: tmpRunDir(),
      overrides: {
        skipPreflight: true,
        listChangedFiles: async () => ["tests/a.test.js"],
      },
    });
    expect(deps.listChangedFiles).toBeDefined();
    const files = await deps.listChangedFiles!({
      repositoryUrl: BELLHOP_REPO,
      baseSha: STARTING_SHA_A,
      tipSha: IMPLEMENTATION_TIP_B,
    });
    expect(files).toEqual(["tests/a.test.js"]);
  });
});

describe("v2 Bellhop environment binding", () => {
  it("targets Bellhop repository and Cursor environment on worker create", async () => {
    const cursorClient = createCountingCursorClient();
    const binding = resolveV2ProjectBinding(bellhopObjective());
    const envBinding = {
      ...binding,
      cursorEnvironmentName: "bellhop-cloud-env",
    };

    await launchV2Worker({
      objective: bellhopObjective(),
      cursorClient,
      projectBinding: envBinding,
    });

    expect(cursorClient.lastRequest?.repos?.[0]?.url).toBe(BELLHOP_REPO);
    expect(cursorClient.lastRequest?.env?.name).toBe("bellhop-cloud-env");
    expect(cursorClient.lastRequest?.env?.type).toBe("cloud");
  });
});

describe("v2 worker vs Git changed-files contradiction", () => {
  it("uses Git-derived changed files over worker narrative claims", async () => {
    const facts = await deriveVerifiedGitFacts({
      repository: BELLHOP_REPO,
      baseBranch: "main",
      startingSha: STARTING_SHA_A,
      implementationBranch: "cursor/foo",
      implementationTipSha: IMPLEMENTATION_TIP_B,
      expectedRepository: BELLHOP_REPO,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#cursor/foo`]: IMPLEMENTATION_TIP_B,
      }),
      verifyCommitAncestry: fakeAncestry([[STARTING_SHA_A, IMPLEMENTATION_TIP_B]]),
      listChangedFiles: async () => ["tests/foo.test.js", "src/game.js"],
    });

    expect(facts.changedFiles).toEqual(["tests/foo.test.js", "src/game.js"]);
    expect(facts.changedFiles).not.toEqual(["tests/foo.test.js"]);
  });
});

describe("v2 test-only scope uses verified git files", () => {
  it("continues when only test files changed per Git", () => {
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
        implementationTipSha: IMPLEMENTATION_TIP_B,
        remoteBranchExists: true,
        implementationTipRemoteExists: true,
        freshCommit: true,
        startingShaEqualsImplementationTip: false,
        isAncestorStartingToImplementation: true,
        changedFiles: ["tests/foo.test.js"],
        publicationAvailable: true,
        repositoryBindingOk: true,
        contradictions: [],
        verifiedAt: new Date().toISOString(),
      },
      workerClaimsProductBehaviorChanged: false,
    });
    expect(gate.requiresHuman).toBe(false);
  });

  it("routes to HUMAN when Git shows production file even if worker denies behavior change", () => {
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
        implementationTipSha: IMPLEMENTATION_TIP_B,
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

describe("v2 live readiness simulation via CLI", () => {
  it("executes full loop through production factory with fake adapters", async () => {
    const dir = tmpRunDir();
    const objectivePath = writeObjectiveFile(dir);
    const runDir = path.join(dir, "run");

    const overrides = standardOverrides(["ACCEPT"]);
    const { exitCode, result } = await runV2Cli(
      ["node", "cli", "--objective", objectivePath, "--run-dir", runDir],
      overrides,
    );

    expect(exitCode).toBe(0);
    expect(result.state.terminalOutcome).toBe("DONE");
    expect(result.summary.humanMessagesAfterLaunch).toBe(0);
    expect(result.summary.implementationWorkersCreated).toBe(1);
    expect(result.summary.structuredWorkerReportRequired).toBe(false);
    expect(result.summary.reportRepairAttempts).toBe(0);
    expect(overrides.cursorClient.createCount).toBe(1);
    expect(fs.existsSync(path.join(runDir, "summary.json"))).toBe(true);
  });
});

function checkpointState(
  runDir: string,
  partial: Partial<V2RunState> & Pick<V2RunState, "stage">,
): void {
  const { stage, ...rest } = partial;
  const base: V2RunState = {
    schemaVersion: V2_SCHEMA_VERSION,
    objective: bellhopObjective(),
    stage,
    iteration: 1,
    workerRunsUsed: 1,
    startingSha: STARTING_SHA_A,
    lastImplementationTipSha: IMPLEMENTATION_TIP_B,
    lastImplementationBranch: "cursor/foo",
    lastVerifiedFacts: null,
    lastSolDecision: null,
    activeWorker: null,
    terminalOutcome: null,
    terminalReason: null,
    updatedAt: new Date().toISOString(),
    ...rest,
  };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run-state.json"),
    JSON.stringify(base, null, 2),
  );
  fs.writeFileSync(
    path.join(runDir, "objective.json"),
    JSON.stringify(bellhopObjective(), null, 2),
  );
}

describe("v2 CLI resume", () => {
  it("reuses active worker on resume without duplicate create", async () => {
    const runDir = tmpRunDir();
    const overrides = standardOverrides(["ACCEPT"]);
    checkpointState(runDir, {
      stage: "WORK",
      activeWorker: { agentId: "bc-existing-001", runId: "run-existing-001" },
      workerRunsUsed: 1,
      lastImplementationTipSha: null,
      lastImplementationBranch: null,
    });

    const { deps } = await createV2ProductionDeps({
      runDir,
      overrides,
    });
    const result = await resumeV2Loop({ ...deps, runDir });

    expect(overrides.cursorClient.createCount).toBe(0);
    expect(result.state.terminalOutcome).toBe("DONE");
    expect(result.summary.implementationWorkersCreated).toBe(0);
  });

  it("resumes after worker result persisted without duplicate work", async () => {
    const runDir = tmpRunDir();
    const overrides = standardOverrides(["ACCEPT"]);
    checkpointState(runDir, {
      stage: "WORK",
      activeWorker: null,
      workerRunsUsed: 1,
    });
    fs.mkdirSync(path.join(runDir, "iterations", "01"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "worker-result.txt"),
      UNSTRUCTURED_WORKER_NARRATIVE,
    );
    fs.writeFileSync(
      path.join(runDir, "iterations", "01", "worker-result.txt"),
      UNSTRUCTURED_WORKER_NARRATIVE,
    );

    const { exitCode, result } = await runV2Cli(
      ["node", "cli", "--resume", runDir],
      overrides,
    );

    expect(exitCode).toBe(0);
    expect(overrides.cursorClient.createCount).toBe(0);
    expect(result.state.terminalOutcome).toBe("DONE");
  });

  it("resumes at VERIFY without new worker", async () => {
    const runDir = tmpRunDir();
    const overrides = standardOverrides(["ACCEPT"]);
    checkpointState(runDir, {
      stage: "VERIFY",
      activeWorker: null,
      workerRunsUsed: 1,
    });
    fs.writeFileSync(
      path.join(runDir, "worker-result.txt"),
      UNSTRUCTURED_WORKER_NARRATIVE,
    );

    const result = await resumeV2Loop({
      ...(await createV2ProductionDeps({ runDir, overrides })).deps,
      runDir,
    });

    expect(overrides.cursorClient.createCount).toBe(0);
    expect(result.state.terminalOutcome).toBe("DONE");
  });
});

describe("v2 maxWorkerRuns on production adapter path", () => {
  it("does not create third worker when maxWorkerRuns=2", async () => {
    const dir = tmpRunDir();
    const objectivePath = writeObjectiveFile(dir);
    const runDir = path.join(dir, "run");
    const overrides = standardOverrides(["CONTINUE_WORK", "CONTINUE_WORK", "CONTINUE_WORK"]);
    const objective = bellhopObjective({ maxWorkerRuns: 2 });
    fs.writeFileSync(objectivePath, JSON.stringify(objective, null, 2));
    overrides.projectBinding = resolveV2ProjectBinding(objective);

    const { result } = await runV2Cli(
      ["node", "cli", "--objective", objectivePath, "--run-dir", runDir],
      overrides,
    );

    expect(overrides.cursorClient.createCount).toBe(2);
    expect(result.state.terminalOutcome).toBe("FAILED_POLICY");
  });
});
