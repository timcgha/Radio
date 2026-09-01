/**
 * Independent Git changed-file derivation for v2.
 *
 * Radio derives changed files from startingSha..implementationTipSha.
 * Worker prose is never authoritative for this list.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildGitLsRemoteEnvForRepository } from "../cursor/github-git-auth.js";
import { isFullGitCommitSha } from "../cursor/source-ref.js";
import { verifyCommitAncestryViaGitFetch } from "../cursor/remote-publication-verify.js";

const execFileAsync = promisify(execFile);

export class V2ChangedFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2ChangedFilesError";
  }
}

export interface ListChangedFilesInput {
  repositoryUrl: string;
  baseSha: string;
  tipSha: string;
  verifyCommitAncestry?: typeof verifyCommitAncestryViaGitFetch;
  execFileImpl?: typeof execFileAsync;
}

/**
 * Derive changed file paths between two commits on the remote repository.
 * Fail-closed unless both SHAs exist remotely and ancestry holds.
 */
export async function listChangedFilesViaGitFetch(
  input: ListChangedFilesInput,
): Promise<string[]> {
  const baseSha = input.baseSha.trim().toLowerCase();
  const tipSha = input.tipSha.trim().toLowerCase();

  if (!isFullGitCommitSha(baseSha) || !isFullGitCommitSha(tipSha)) {
    throw new V2ChangedFilesError(
      "startingSha and implementationTipSha must be full 40-character SHAs",
    );
  }

  if (baseSha === tipSha) {
    return [];
  }

  const verifyAncestry =
    input.verifyCommitAncestry ?? verifyCommitAncestryViaGitFetch;
  const isAncestor = await verifyAncestry({
    repositoryUrl: input.repositoryUrl,
    ancestorSha: baseSha,
    descendantSha: tipSha,
  });
  if (!isAncestor) {
    throw new V2ChangedFilesError(
      `cannot derive changed files: ${baseSha} is not an ancestor of ${tipSha}`,
    );
  }

  const run = input.execFileImpl ?? execFileAsync;
  const dir = mkdtempSync(join(tmpdir(), "radio-v2-diff-"));
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
    await run("git", ["fetch", "origin", baseSha, tipSha], opts);
    const diff = await run(
      "git",
      ["diff", "--name-only", baseSha, tipSha],
      opts,
    );
    const stdout =
      typeof diff.stdout === "string" ? diff.stdout : String(diff.stdout);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
