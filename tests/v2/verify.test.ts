import { describe, expect, it } from "vitest";
import {
  BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA,
  BELLHOP_REGRESSION_STARTING_SHA,
  deriveVerifiedGitFacts,
  evaluateHardGate,
} from "../../src/v2/verify.js";
import {
  BELLHOP_REPO,
  IMPLEMENTATION_TIP_B,
  NON_DESCENDANT_TIP,
  STARTING_SHA_A,
  fakeAncestry,
  fakeMergeBase,
  defaultBellhopMergeBaseMap,
  fakeResolveRemoteBranchTip,
} from "../../src/v2/test-fixtures.js";

describe("v2 verified git facts", () => {
  const branch = "cursor/foo";
  const baseMap = {
    [`${BELLHOP_REPO}#main`]: BELLHOP_REGRESSION_STARTING_SHA,
    [`${BELLHOP_REPO}#${branch}`]: BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA,
  };

  it("treats startingSha != implementationTipSha as valid descendant", async () => {
    const facts = await deriveVerifiedGitFacts({
      repository: BELLHOP_REPO,
      baseBranch: "main",
      startingSha: BELLHOP_REGRESSION_STARTING_SHA,
      implementationBranch: branch,
      implementationTipSha: BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA,
      expectedRepository: BELLHOP_REPO,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip(baseMap),
      verifyCommitAncestry: fakeAncestry([
        [BELLHOP_REGRESSION_STARTING_SHA, BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA],
      ]),
      resolveMergeBase: fakeMergeBase({
        [`${BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA}^${BELLHOP_REGRESSION_STARTING_SHA}`]:
          BELLHOP_REGRESSION_STARTING_SHA,
      }),
      listChangedFiles: async () => ["tests/foo.test.js"],
    });

    expect(facts.startingSha).toBe(BELLHOP_REGRESSION_STARTING_SHA);
    expect(facts.implementationTipSha).toBe(
      BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA,
    );
    expect(facts.startingShaEqualsImplementationTip).toBe(false);
    expect(facts.isAncestorStartingToImplementation).toBe(true);
    expect(facts.implementationSourceOriginOk).toBe(true);
    expect(facts.freshCommit).toBe(true);
    expect(facts.publicationAvailable).toBe(true);
  });

  it("fails non-descendant tip", async () => {
    const facts = await deriveVerifiedGitFacts({
      repository: BELLHOP_REPO,
      baseBranch: "main",
      startingSha: STARTING_SHA_A,
      implementationBranch: branch,
      implementationTipSha: NON_DESCENDANT_TIP,
      expectedRepository: BELLHOP_REPO,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#${branch}`]: NON_DESCENDANT_TIP,
      }),
      verifyCommitAncestry: fakeAncestry([]),
    });

    expect(facts.isAncestorStartingToImplementation).toBe(false);
    expect(facts.contradictions.length).toBeGreaterThan(0);
  });

  it("fails no-fresh-commit when tip equals starting", async () => {
    const facts = await deriveVerifiedGitFacts({
      repository: BELLHOP_REPO,
      baseBranch: "main",
      startingSha: STARTING_SHA_A,
      implementationBranch: branch,
      implementationTipSha: STARTING_SHA_A,
      expectedRepository: BELLHOP_REPO,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip({
        [`${BELLHOP_REPO}#${branch}`]: STARTING_SHA_A,
      }),
      verifyCommitAncestry: fakeAncestry([]),
    });

    expect(facts.freshCommit).toBe(false);
    expect(facts.startingShaEqualsImplementationTip).toBe(true);
  });

  it("fails wrong repository binding", async () => {
    const facts = await deriveVerifiedGitFacts({
      repository: "https://github.com/evil/wrong",
      baseBranch: "main",
      startingSha: STARTING_SHA_A,
      implementationBranch: branch,
      implementationTipSha: IMPLEMENTATION_TIP_B,
      expectedRepository: BELLHOP_REPO,
      resolveRemoteBranchTip: fakeResolveRemoteBranchTip(baseMap),
      verifyCommitAncestry: fakeAncestry([[STARTING_SHA_A, IMPLEMENTATION_TIP_B]]),
    });

    expect(facts.repositoryBindingOk).toBe(false);
  });

  it("hard gate requires ancestry and fresh commit for publication", () => {
    const pass = evaluateHardGate({
      verifiedFacts: {
        repository: BELLHOP_REPO,
        baseBranch: "main",
        startingSha: STARTING_SHA_A,
        resolvedBaseSha: STARTING_SHA_A,
        resolvedBaseTipSha: STARTING_SHA_A,
        implementationBranch: branch,
        implementationTipSha: IMPLEMENTATION_TIP_B,
        remoteBranchExists: true,
        implementationTipRemoteExists: true,
        freshCommit: true,
        startingShaEqualsImplementationTip: false,
        isAncestorStartingToImplementation: true,
        mergeBaseWithBaseBranch: STARTING_SHA_A,
        implementationSourceOriginOk: true,
        changedFiles: ["tests/foo.test.js"],
        publicationAvailable: true,
        repositoryBindingOk: true,
        contradictions: [],
        verifiedAt: new Date().toISOString(),
      },
      publicationRequired: true,
      solRecommendsAccept: true,
    });
    expect(pass.pass).toBe(true);
  });
});
