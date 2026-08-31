/**
 * Trusted remote publication verification for post-Sol acceptance gates.
 * Worker claims are untrusted until independently verified against the remote.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildGitLsRemoteEnvForRepository } from "./github-git-auth.js";
import {
  commitShasMatch,
  isFullGitCommitSha,
  parseLsRemoteSha,
  type ResolveRemoteBranchTip,
} from "./source-ref.js";

const execFileAsync = promisify(execFile);

export type RemotePublicationFailureCode =
  | "REMOTE_BRANCH_MISSING"
  | "REMOTE_BRANCH_SHA_MISMATCH"
  | "REMOTE_COMMIT_NOT_FOUND"
  | "EXECUTABLE_NOT_ANCESTOR_OF_EVIDENCE";

export interface RemotePublicationVerifyResult {
  ok: boolean;
  code: RemotePublicationFailureCode | "REMOTE_VERIFICATION_OK";
  summary: string;
  remoteBranchTip?: string;
}

export type VerifyCommitAncestry = (input: {
  repositoryUrl: string;
  ancestorSha: string;
  descendantSha: string;
}) => Promise<boolean>;

type ExecFile = typeof execFileAsync;

/**
 * Verify a full commit SHA exists on the remote (any ref).
 */
export async function verifyRemoteCommitExists(input: {
  repositoryUrl: string;
  commitSha: string;
  execFileImpl?: ExecFile;
}): Promise<boolean> {
  const sha = input.commitSha.trim();
  if (!isFullGitCommitSha(sha)) return false;

  const run = input.execFileImpl ?? execFileAsync;
  const gitEnv = buildGitLsRemoteEnvForRepository(input.repositoryUrl);
  const execOptions = {
    encoding: "utf8" as const,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    ...(gitEnv ? { env: { ...process.env, ...gitEnv } } : {}),
  };

  try {
    const result = await run(
      "git",
      ["ls-remote", input.repositoryUrl, sha],
      execOptions,
    );
    const stdout =
      typeof result.stdout === "string" ? result.stdout : String(result.stdout);
    return parseLsRemoteSha(stdout) != null;
  } catch {
    return false;
  }
}

/**
 * Verify ancestorSha is the same as or an ancestor of descendantSha on the remote.
 */
export async function verifyCommitAncestryViaGitFetch(input: {
  repositoryUrl: string;
  ancestorSha: string;
  descendantSha: string;
  execFileImpl?: ExecFile;
}): Promise<boolean> {
  const ancestor = input.ancestorSha.trim();
  const descendant = input.descendantSha.trim();
  if (!isFullGitCommitSha(ancestor) || !isFullGitCommitSha(descendant)) {
    return false;
  }
  if (commitShasMatch(ancestor, descendant)) return true;

  const run = input.execFileImpl ?? execFileAsync;
  const dir = mkdtempSync(join(tmpdir(), "radio-git-ancestry-"));
  const gitEnv = buildGitLsRemoteEnvForRepository(input.repositoryUrl);
  const opts = {
    cwd: dir,
    encoding: "utf8" as const,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...(gitEnv ? { env: { ...process.env, ...gitEnv } } : {}),
  };

  try {
    await run("git", ["init"], opts);
    await run("git", ["remote", "add", "origin", input.repositoryUrl], opts);
    await run("git", ["fetch", "origin", descendant], opts);
    try {
      await run(
        "git",
        ["merge-base", "--is-ancestor", ancestor, descendant],
        opts,
      );
      return true;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: number }).code === 1
      ) {
        return false;
      }
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyRemoteBranchTipExact(input: {
  repositoryUrl: string;
  branch: string;
  expectedTipSha: string;
  resolveRemoteBranchTip: ResolveRemoteBranchTip;
}): Promise<RemotePublicationVerifyResult> {
  const branch = input.branch.trim();
  const expected = input.expectedTipSha.trim();
  if (!branch) {
    return {
      ok: false,
      code: "REMOTE_BRANCH_MISSING",
      summary: "Remote branch name is missing",
    };
  }
  if (!isFullGitCommitSha(expected)) {
    return {
      ok: false,
      code: "REMOTE_BRANCH_SHA_MISMATCH",
      summary: `Expected remote tip must be a full 40-character SHA; got ${JSON.stringify(expected)}`,
    };
  }

  let remoteTip: string;
  try {
    remoteTip = await input.resolveRemoteBranchTip({
      repositoryUrl: input.repositoryUrl,
      branch,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "REMOTE_BRANCH_MISSING",
      summary: `Remote branch ${JSON.stringify(branch)} could not be resolved: ${message}`,
    };
  }

  if (!commitShasMatch(remoteTip, expected)) {
    return {
      ok: false,
      code: "REMOTE_BRANCH_SHA_MISMATCH",
      summary: `Remote branch ${JSON.stringify(branch)} tip ${remoteTip} != expected ${expected}`,
      remoteBranchTip: remoteTip,
    };
  }

  return {
    ok: true,
    code: "REMOTE_VERIFICATION_OK",
    summary: `Remote branch ${JSON.stringify(branch)} tip matches ${expected}`,
    remoteBranchTip: remoteTip,
  };
}

export async function verifyExecutableEvidenceAncestry(input: {
  repositoryUrl: string;
  finalExecutableSha: string;
  evidenceTipSha: string;
  verifyCommitAncestry?: VerifyCommitAncestry;
  verifyRemoteCommitExistsImpl?: (input: {
    repositoryUrl: string;
    commitSha: string;
  }) => Promise<boolean>;
}): Promise<RemotePublicationVerifyResult> {
  const executable = input.finalExecutableSha.trim();
  const evidence = input.evidenceTipSha.trim();
  if (!isFullGitCommitSha(executable) || !isFullGitCommitSha(evidence)) {
    return {
      ok: false,
      code: "REMOTE_COMMIT_NOT_FOUND",
      summary: "Executable and evidence SHAs must be full 40-character commits",
    };
  }

  const verifyAncestry =
    input.verifyCommitAncestry ?? verifyCommitAncestryViaGitFetch;
  const commitExists = input.verifyRemoteCommitExistsImpl ?? verifyRemoteCommitExists;

  const executableExists = await commitExists({
    repositoryUrl: input.repositoryUrl,
    commitSha: executable,
  });
  if (!executableExists) {
    return {
      ok: false,
      code: "REMOTE_COMMIT_NOT_FOUND",
      summary: `FINAL_EXECUTABLE_SHA ${executable} is not remotely available`,
    };
  }

  const evidenceExists = await commitExists({
    repositoryUrl: input.repositoryUrl,
    commitSha: evidence,
  });
  if (!evidenceExists) {
    return {
      ok: false,
      code: "REMOTE_COMMIT_NOT_FOUND",
      summary: `EVIDENCE_TIP_SHA ${evidence} is not remotely available`,
    };
  }

  if (commitShasMatch(executable, evidence)) {
    return {
      ok: true,
      code: "REMOTE_VERIFICATION_OK",
      summary: "Executable and evidence tip are the same remote commit",
    };
  }

  const isAncestor = await verifyAncestry({
    repositoryUrl: input.repositoryUrl,
    ancestorSha: executable,
    descendantSha: evidence,
  });
  if (!isAncestor) {
    return {
      ok: false,
      code: "EXECUTABLE_NOT_ANCESTOR_OF_EVIDENCE",
      summary: `FINAL_EXECUTABLE_SHA ${executable} is not an ancestor of EVIDENCE_TIP_SHA ${evidence}`,
    };
  }

  return {
    ok: true,
    code: "REMOTE_VERIFICATION_OK",
    summary: "Executable commit is an ancestor of evidence tip on remote",
  };
}
