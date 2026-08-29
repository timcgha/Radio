import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Generic source launch intent: authoritative product revision vs Cursor
 * transport startingRef. The expected commit remains authoritative; the
 * transport ref is only how Cursor clones the tree.
 */
export interface SourceLaunchIntent {
  repository: string;
  expectedCommitSha: string;
  transportStartingRef: string;
}

export interface SourceRefVerification {
  repository: string;
  expectedCommitSha: string;
  transportStartingRef: string;
  remoteResolvedSha: string;
  sourceRefVerifiedAt: string;
}

export type ResolveRemoteBranchTip = (input: {
  repositoryUrl: string;
  branch: string;
}) => Promise<string>;

export class SourceRefPrecheckError extends Error {
  readonly code = "SOURCE_REF_PRECHECK_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "SourceRefPrecheckError";
  }
}

/** Normalize commit SHAs for exact comparison (lowercase, trimmed). */
export function normalizeCommitSha(sha: string): string {
  return sha.trim().toLowerCase();
}

export function commitShasMatch(a: string, b: string): boolean {
  return normalizeCommitSha(a) === normalizeCommitSha(b);
}

/**
 * Derive Cursor API transport startingRef from work-order source metadata.
 *
 * Prefer an explicit branch (workingBranch, then baseBranch). Do NOT pin the
 * expected commit SHA as startingRef when a branch is available — Cursor may
 * reject unmerged non-default branch SHAs. Never silently substitute main /
 * canonicalMainBranch.
 */
export function resolveCursorTransportStartingRef(source: {
  expectedBaseTipSha?: string | null;
  workingBranch?: string | null;
  baseBranch?: string | null;
  canonicalMainBranch?: string | null;
}): string | undefined {
  const working = source.workingBranch?.trim();
  if (working) return working;
  const base = source.baseBranch?.trim();
  if (base) return base;
  // Last resort only when no branch metadata exists (may still fail on Cursor
  // for unmerged tips). Never invent main.
  const tip = source.expectedBaseTipSha?.trim();
  return tip || undefined;
}

/**
 * @deprecated Prefer resolveCursorTransportStartingRef. Kept as the public
 * adapter name used by create-request builders.
 */
export function resolveCursorStartingRef(source: {
  expectedBaseTipSha?: string | null;
  workingBranch?: string | null;
  baseBranch?: string | null;
  canonicalMainBranch?: string | null;
}): string | undefined {
  return resolveCursorTransportStartingRef(source);
}

export function deriveSourceLaunchIntent(source: {
  repository: string;
  expectedBaseTipSha?: string | null;
  workingBranch?: string | null;
  baseBranch?: string | null;
  canonicalMainBranch?: string | null;
}): SourceLaunchIntent {
  const expectedCommitSha = source.expectedBaseTipSha?.trim();
  if (!expectedCommitSha) {
    throw new SourceRefPrecheckError(
      "SOURCE_REF_PRECHECK_FAILED: work order missing expectedCommitSha (expectedBaseTipSha)",
    );
  }
  const transportStartingRef = resolveCursorTransportStartingRef(source);
  if (!transportStartingRef) {
    throw new SourceRefPrecheckError(
      "SOURCE_REF_PRECHECK_FAILED: work order missing transportStartingRef (workingBranch/baseBranch)",
    );
  }
  // Defense: never treat canonical main as an automatic substitute for a
  // missing Stage branch when expected tip metadata exists without a branch.
  if (
    source.canonicalMainBranch &&
    transportStartingRef === source.canonicalMainBranch.trim() &&
    source.workingBranch == null &&
    source.baseBranch == null
  ) {
    throw new SourceRefPrecheckError(
      "SOURCE_REF_PRECHECK_FAILED: refusing silent main/canonical substitution for transportStartingRef",
    );
  }
  return {
    repository: source.repository,
    expectedCommitSha,
    transportStartingRef,
  };
}

/**
 * Parse `git ls-remote` stdout for a single branch tip SHA.
 */
export function parseLsRemoteSha(stdout: string): string | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const sha = line.split(/\s+/)[0]?.trim();
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  return sha;
}

/**
 * Read-only remote branch tip resolution via `git ls-remote`.
 * Does not mutate the remote repository.
 */
export async function resolveRemoteBranchTipViaGitLsRemote(input: {
  repositoryUrl: string;
  branch: string;
  execFileImpl?: typeof execFileAsync;
}): Promise<string> {
  const branch = input.branch.trim();
  if (!branch) {
    throw new SourceRefPrecheckError(
      "SOURCE_REF_PRECHECK_FAILED: empty branch name for remote ref resolution",
    );
  }
  if (branch.includes("..") || branch.includes(" ")) {
    throw new SourceRefPrecheckError(
      `SOURCE_REF_PRECHECK_FAILED: invalid branch name ${JSON.stringify(branch)}`,
    );
  }

  const run = input.execFileImpl ?? execFileAsync;
  const ref = `refs/heads/${branch}`;
  let stdout: string;
  try {
    const result = await run(
      "git",
      ["ls-remote", input.repositoryUrl, ref],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SourceRefPrecheckError(
      `SOURCE_REF_PRECHECK_FAILED: remote ref resolver error: ${message}`,
    );
  }

  const sha = parseLsRemoteSha(stdout);
  if (!sha) {
    throw new SourceRefPrecheckError(
      `SOURCE_REF_PRECHECK_FAILED: remote branch ${JSON.stringify(branch)} does not exist (or returned no tip) in ${input.repositoryUrl}`,
    );
  }
  return sha;
}

/**
 * Verify remote transport branch tip equals the expected authoritative commit.
 * Fail closed — caller must not POST /v1/agents on failure.
 */
export async function verifyRemoteSourceRef(input: {
  intent: SourceLaunchIntent;
  resolveRemoteBranchTip: ResolveRemoteBranchTip;
  nowIso?: () => string;
}): Promise<SourceRefVerification> {
  const { intent } = input;
  let remoteResolvedSha: string;
  try {
    remoteResolvedSha = await input.resolveRemoteBranchTip({
      repositoryUrl: intent.repository,
      branch: intent.transportStartingRef,
    });
  } catch (err) {
    if (err instanceof SourceRefPrecheckError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new SourceRefPrecheckError(
      `SOURCE_REF_PRECHECK_FAILED: remote ref resolver error: ${message}`,
    );
  }

  if (!commitShasMatch(remoteResolvedSha, intent.expectedCommitSha)) {
    throw new SourceRefPrecheckError(
      `SOURCE_REF_PRECHECK_FAILED: remote branch ${JSON.stringify(intent.transportStartingRef)} resolves to ${remoteResolvedSha}, expected ${intent.expectedCommitSha}`,
    );
  }

  return {
    repository: intent.repository,
    expectedCommitSha: intent.expectedCommitSha,
    transportStartingRef: intent.transportStartingRef,
    remoteResolvedSha,
    sourceRefVerifiedAt: (input.nowIso ?? (() => new Date().toISOString()))(),
  };
}
