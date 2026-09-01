import { describe, expect, it } from "vitest";
import { listChangedFilesViaGitFetch } from "../../src/v2/git-changed-files.js";
import {
  BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA,
  BELLHOP_REGRESSION_STARTING_SHA,
} from "../../src/v2/verify.js";
import { BELLHOP_REPO } from "../../src/v2/test-fixtures.js";

describe("v2 git changed-files derivation", () => {
  it("derives files from startingSha..implementationTipSha when ancestry holds", async () => {
    const execFileImpl = async (
      _file: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === "diff" && args[1] === "--name-only") {
        return { stdout: "tests/foo.test.js\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const files = await listChangedFilesViaGitFetch({
      repositoryUrl: BELLHOP_REPO,
      baseSha: BELLHOP_REGRESSION_STARTING_SHA,
      tipSha: BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA,
      verifyCommitAncestry: async () => true,
      execFileImpl: execFileImpl as never,
    });

    expect(files).toEqual(["tests/foo.test.js"]);
  });

  it("rejects changed-file derivation when ancestry is false", async () => {
    await expect(
      listChangedFilesViaGitFetch({
        repositoryUrl: BELLHOP_REPO,
        baseSha: BELLHOP_REGRESSION_STARTING_SHA,
        tipSha: BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA,
        verifyCommitAncestry: async () => false,
      }),
    ).rejects.toThrow(/not an ancestor/i);
  });

  it("returns empty list when starting equals tip", async () => {
    const files = await listChangedFilesViaGitFetch({
      repositoryUrl: BELLHOP_REPO,
      baseSha: BELLHOP_REGRESSION_STARTING_SHA,
      tipSha: BELLHOP_REGRESSION_STARTING_SHA,
    });
    expect(files).toEqual([]);
  });
});
