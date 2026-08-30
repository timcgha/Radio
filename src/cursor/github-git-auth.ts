import { resolveRepoPath } from "../util/io.js";

export const AUTHORIZED_GITHUB_HOST = "github.com" as const;
export const RADIO_GITHUB_TOKEN_ENV = "RADIO_GITHUB_TOKEN" as const;

/**
 * Extract hostname for HTTPS repository URLs only.
 * SSH and other schemes return null (no token injection).
 */
export function extractHttpsHost(repositoryUrl: string): string | null {
  const trimmed = repositoryUrl.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) {
    return null;
  }
  try {
    return new URL(trimmed).hostname;
  } catch {
    return null;
  }
}

/** True when the remote is an approved HTTPS GitHub host. */
export function isAuthorizedGithubHttpsRepository(repositoryUrl: string): boolean {
  return extractHttpsHost(repositoryUrl) === AUTHORIZED_GITHUB_HOST;
}

/** Path to the credential responder invoked via GIT_ASKPASS (no embedded token). */
export function resolveRadioGithubAskpassScriptPath(): string {
  return resolveRepoPath("scripts", "radio-github-askpass.mjs");
}

/**
 * Build process env for authenticated `git ls-remote` against private GitHub repos.
 * Returns undefined when auth is not applicable (non-GitHub, or token absent).
 */
export function buildGitLsRemoteEnvForRepository(
  repositoryUrl: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (!isAuthorizedGithubHttpsRepository(repositoryUrl)) {
    return undefined;
  }
  const token = parentEnv[RADIO_GITHUB_TOKEN_ENV]?.trim();
  if (!token) {
    return undefined;
  }
  return {
    ...parentEnv,
    GIT_ASKPASS: resolveRadioGithubAskpassScriptPath(),
    GIT_TERMINAL_PROMPT: "0",
    // Prevent host-managed url.insteadOf rewrites from embedding foreign credentials
    // in the repository URL; RADIO_GITHUB_TOKEN is supplied only via askpass.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    [RADIO_GITHUB_TOKEN_ENV]: token,
  };
}
