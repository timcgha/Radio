/**
 * Regression: v2 worker prompt must not instruct branch publication.
 * Radio / Cursor Cloud owns publication; worker owns code changes.
 */
import { describe, expect, it } from "vitest";
import {
  buildV2WorkerCreateRequest,
  buildWorkerPrompt,
} from "../../src/v2/cursor-worker.js";
import { runV2Loop } from "../../src/v2/orchestrator.js";
import { createFixtureSolClient } from "../../src/v2/sol-client.js";
import { deriveVerifiedGitFacts } from "../../src/v2/verify.js";
import { verifyStartingSource } from "../../src/v2/source.js";
import {
  BELLHOP_REPO,
  CYBER_BASE_BRANCH,
  CYBER_EXPECTED_STARTING_SHA,
  CYBER_REPO,
  CYBER_SOURCE_BRANCH_ADVANCED_SHA,
  CYBER_UX028_ASSIGNED_BRANCH,
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

/** Patterns the production worker prompt must NOT contain. */
const PROHIBITED_PROMPT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "git checkout -b", pattern: /git checkout -b/i },
  { label: "git switch -c", pattern: /git switch -c/i },
  { label: "git push origin baseBranch", pattern: /git push origin/i },
  { label: "git push --force", pattern: /git push --force/i },
  { label: "git reset --hard", pattern: /git reset --hard/i },
  { label: "create a fresh branch", pattern: /create a fresh branch/i },
  { label: "push a fresh branch", pattern: /push a fresh branch/i },
  { label: "push your implementation", pattern: /push your implementation/i },
  { label: "publish to a new branch", pattern: /publish to a new branch/i },
  { label: "branch and commit pushed", pattern: /branch and commit pushed/i },
];

function assertPromptProhibitions(prompt: string): void {
  for (const { label, pattern } of PROHIBITED_PROMPT_PATTERNS) {
    expect(prompt, `prompt must not instruct: ${label}`).not.toMatch(pattern);
  }
}

function assertPromptSourceReadOnly(prompt: string, baseBranch: string): void {
  expect(prompt).toContain(baseBranch);
  expect(prompt).toMatch(/source branch.*read-only|read-only|transport only/i);
  expect(prompt).toMatch(/not an implementation destination/i);
  expect(prompt).toMatch(/never push or modify the source branch/i);
}

function assertPromptPublicationDeferred(prompt: string): void {
  expect(prompt).toMatch(/GIT \/ PUBLICATION RULE/i);
  expect(prompt).toMatch(/Cursor Cloud agent workflow/i);
  expect(prompt).toMatch(/assigned implementation branch/i);
}

describe("Cyber UX-028 production worker prompt (real objective)", () => {
  const objective = cyberObjective({
    humanInstruction: "Fix UX-028 duplicate criterion false PASS.",
  });

  it("identifies base branch as source-only and defers publication to Cursor Cloud", () => {
    const prompt = buildWorkerPrompt(objective);
    const request = buildV2WorkerCreateRequest({ objective });

    expect(request.repos[0]!.startingRef).toBe(CYBER_BASE_BRANCH);
    expect(request.prompt.text).toBe(prompt);
    expect(prompt).toContain(CYBER_BASE_BRANCH);
    expect(prompt).toContain(CYBER_EXPECTED_STARTING_SHA);
    expect(prompt).toContain(CYBER_REPO);

    assertPromptSourceReadOnly(prompt, CYBER_BASE_BRANCH);
    assertPromptPublicationDeferred(prompt);
    assertPromptProhibitions(prompt);

    const CYBER_WORKER_BASE_BRANCH_READ_ONLY =
      prompt.includes(CYBER_BASE_BRANCH) &&
      /not an implementation destination/i.test(prompt) &&
      /never push or modify the source branch/i.test(prompt);
    expect(CYBER_WORKER_BASE_BRANCH_READ_ONLY).toBe(true);
  });

  it("does not name the Cursor-assigned implementation branch in worker instructions", () => {
    const prompt = buildWorkerPrompt(objective);
    expect(prompt).not.toContain(CYBER_UX028_ASSIGNED_BRANCH);
  });
});

describe("Bellhop main source-only worker prompt", () => {
  it("treats main as transport context only without push instructions", () => {
    const objective = bellhopObjective();
    const prompt = buildWorkerPrompt(objective);

    assertPromptSourceReadOnly(prompt, "main");
    assertPromptPublicationDeferred(prompt);
    assertPromptProhibitions(prompt);

    const BELLHOP_WORKER_MAIN_READ_ONLY =
      prompt.includes("main") &&
      /not an implementation destination/i.test(prompt) &&
      /never push or modify the source branch/i.test(prompt);
    expect(BELLHOP_WORKER_MAIN_READ_ONLY).toBe(true);
  });
});

describe("production worker prompt negative assertions", () => {
  it("buildV2WorkerCreateRequest prompt excludes branch-management instructions", () => {
    for (const objective of [cyberObjective(), bellhopObjective()]) {
      const prompt = buildV2WorkerCreateRequest({ objective }).prompt.text;
      assertPromptProhibitions(prompt);
    }
  });
});

describe("Cyber UX-028 observed publication failure diagnostics", () => {
  it("detects source branch mutation and unpublished Cursor-assigned branch", async () => {
    const facts = await deriveVerifiedGitFacts({
      repository: CYBER_REPO,
      baseBranch: CYBER_BASE_BRANCH,
      startingSha: CYBER_EXPECTED_STARTING_SHA,
      implementationBranch: CYBER_UX028_ASSIGNED_BRANCH,
      implementationTipSha: CYBER_SOURCE_BRANCH_ADVANCED_SHA,
      expectedRepository: CYBER_REPO,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${CYBER_REPO}#${CYBER_BASE_BRANCH}`]: CYBER_SOURCE_BRANCH_ADVANCED_SHA,
      }),
      verifyCommitAncestry: fakeAncestry([
        [CYBER_EXPECTED_STARTING_SHA, CYBER_SOURCE_BRANCH_ADVANCED_SHA],
      ]),
      resolveMergeBase: fakeMergeBase({
        [`${CYBER_SOURCE_BRANCH_ADVANCED_SHA}^${CYBER_SOURCE_BRANCH_ADVANCED_SHA}`]:
          CYBER_EXPECTED_STARTING_SHA,
      }),
      listChangedFiles: async () => ["tests/ux-028.test.ts"],
    });

    expect(
      facts.contradictions.some((c) =>
        c.includes("SOURCE_BRANCH_CHANGED_DURING_WORKER_RUN"),
      ),
    ).toBe(true);
    expect(
      facts.contradictions.some((c) =>
        c.includes("CURSOR_ASSIGNED_BRANCH_NOT_PUBLISHED"),
      ),
    ).toBe(true);
    expect(facts.publicationAvailable).toBe(false);
    expect(facts.remoteBranchExists).toBe(false);
  });
});

describe("Bellhop v2 regression with publication contract", () => {
  it("continues to DONE when Cursor-assigned branch is published", async () => {
    const cursorClient = createCountingCursorClient();
    const result = await runV2Loop({
      objective: bellhopObjective(),
      solClient: createFixtureSolClient(["ACCEPT"]),
      cursorClient,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#main`]: STARTING_SHA_A,
        [`${BELLHOP_REPO}#cursor/foo`]: IMPLEMENTATION_TIP_B,
      }),
      verifyCommitAncestry: fakeAncestry([[STARTING_SHA_A, IMPLEMENTATION_TIP_B]]),
      resolveMergeBase: fakeMergeBase(defaultBellhopMergeBaseMap()),
      listChangedFiles: async () => ["tests/foo.test.js"],
      obtainWorkerOutcome: async () => ({
        narrative: "tests passed. build passed.",
        implementationBranch: "cursor/foo",
        implementationTipSha: IMPLEMENTATION_TIP_B,
      }),
    });

    expect(result.state.terminalOutcome).toBe("DONE");
    expect(cursorClient.lastRequest?.prompt.text).toMatch(
      /GIT \/ PUBLICATION RULE/i,
    );
    assertPromptProhibitions(cursorClient.lastRequest!.prompt.text);
  });
});

describe("PR #42 provenance preserved", () => {
  it("keeps authority SHA in prompt and baseBranch as Cursor transport ref", async () => {
    const objective = cyberObjective();
    const request = buildV2WorkerCreateRequest({ objective });

    expect(request.repos[0]!.startingRef).toBe(objective.baseBranch);
    expect(request.repos[0]!.startingRef).not.toBe(objective.expectedStartingSha);
    expect(request.prompt.text).toContain(objective.expectedStartingSha);

    const pass = await verifyStartingSource({
      objective,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${CYBER_REPO}#${CYBER_BASE_BRANCH}`]: CYBER_EXPECTED_STARTING_SHA,
      }),
    });
    expect(pass.resolvedBaseSha).toBe(CYBER_EXPECTED_STARTING_SHA);
  });
});

describe("v2 simplicity invariants", () => {
  it("does not require structured worker reports or v1 repair machinery", async () => {
    const result = await runV2Loop({
      objective: bellhopObjective(),
      solClient: createFixtureSolClient(["ACCEPT"]),
      cursorClient: createCountingCursorClient(),
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#main`]: STARTING_SHA_A,
        [`${BELLHOP_REPO}#cursor/foo`]: IMPLEMENTATION_TIP_B,
      }),
      verifyCommitAncestry: fakeAncestry([[STARTING_SHA_A, IMPLEMENTATION_TIP_B]]),
      resolveMergeBase: fakeMergeBase(defaultBellhopMergeBaseMap()),
      listChangedFiles: async () => ["tests/foo.test.js"],
      obtainWorkerOutcome: async () => ({
        narrative: "done",
        implementationBranch: "cursor/foo",
        implementationTipSha: IMPLEMENTATION_TIP_B,
      }),
    });

    expect(result.summary.structuredWorkerReportRequired).toBe(false);
    expect(result.summary.reportRepairAttempts).toBe(0);
  });
});
