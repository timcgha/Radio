/**
 * Secret-safety and authentication wiring for RADIO_GITHUB_TOKEN.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZED_GITHUB_HOST,
  buildGitLsRemoteEnvForRepository,
  extractHttpsHost,
  isAuthorizedGithubHttpsRepository,
  RADIO_GITHUB_TOKEN_ENV,
  resolveRadioGithubAskpassScriptPath,
} from "../src/cursor/github-git-auth.js";
import {
  parseLsRemoteSha,
  resolveRemoteBranchTipViaGitLsRemote,
  SourceRefPrecheckError,
  verifyRemoteSourceRef,
} from "../src/cursor/source-ref.js";

const DUMMY_TOKEN = "ghp_dummy_test_token_not_real_0123456789abcdef";
const FULL_SHA = "9316388a30fde9603c25c5067776b7177472897b";
const GITHUB_REPO = "https://github.com/timcgha/Cyber-assurance-demo";
const NON_GITHUB_REPO = "https://gitlab.com/example/private-repo";
const SSH_GITHUB_REPO = "git@github.com:timcgha/Cyber-assurance-demo.git";

function envWithToken(token?: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  if (token === undefined) {
    delete base[RADIO_GITHUB_TOKEN_ENV];
  } else {
    base[RADIO_GITHUB_TOKEN_ENV] = token;
  }
  return base;
}

function tokenAppearsIn(value: string, token: string): boolean {
  return value.includes(token);
}

describe("github-git-auth", () => {
  it("extractHttpsHost accepts github.com HTTPS only", () => {
    expect(extractHttpsHost(GITHUB_REPO)).toBe(AUTHORIZED_GITHUB_HOST);
    expect(extractHttpsHost("https://github.com/org/repo.git")).toBe(
      AUTHORIZED_GITHUB_HOST,
    );
    expect(extractHttpsHost(SSH_GITHUB_REPO)).toBeNull();
    expect(extractHttpsHost(NON_GITHUB_REPO)).toBe("gitlab.com");
    expect(extractHttpsHost("https://evil-github.com/repo")).toBe(
      "evil-github.com",
    );
  });

  it("isAuthorizedGithubHttpsRepository is exact host match", () => {
    expect(isAuthorizedGithubHttpsRepository(GITHUB_REPO)).toBe(true);
    expect(isAuthorizedGithubHttpsRepository(SSH_GITHUB_REPO)).toBe(false);
    expect(isAuthorizedGithubHttpsRepository(NON_GITHUB_REPO)).toBe(false);
    expect(
      isAuthorizedGithubHttpsRepository("https://www.github.com/org/repo"),
    ).toBe(false);
  });

  it("buildGitLsRemoteEnvForRepository uses GIT_ASKPASS without embedding token in script path", () => {
    const env = buildGitLsRemoteEnvForRepository(GITHUB_REPO, envWithToken(DUMMY_TOKEN));
    expect(env).toBeDefined();
    expect(env!.GIT_ASKPASS).toBe(resolveRadioGithubAskpassScriptPath());
    expect(env!.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env!.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env!.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env![RADIO_GITHUB_TOKEN_ENV]).toBe(DUMMY_TOKEN);
    expect(tokenAppearsIn(env!.GIT_ASKPASS!, DUMMY_TOKEN)).toBe(false);
  });

  it("NON_GITHUB_REMOTE_DOES_NOT_RECEIVE_TOKEN", () => {
    const env = buildGitLsRemoteEnvForRepository(
      NON_GITHUB_REPO,
      envWithToken(DUMMY_TOKEN),
    );
    expect(env).toBeUndefined();
  });

  it("SSH github remote does not receive token", () => {
    const env = buildGitLsRemoteEnvForRepository(
      SSH_GITHUB_REPO,
      envWithToken(DUMMY_TOKEN),
    );
    expect(env).toBeUndefined();
  });

  it("token absent returns undefined for GitHub HTTPS (PUBLIC_REPO_WITHOUT_TOKEN_REMAINS_SUPPORTED)", () => {
    const env = buildGitLsRemoteEnvForRepository(GITHUB_REPO, envWithToken());
    expect(env).toBeUndefined();
  });
});

describe("resolveRemoteBranchTipViaGitLsRemote secret safety", () => {
  it("RADIO_GITHUB_TOKEN_NOT_IN_COMMAND_ARGS", async () => {
    const captured: { file: string; args: string[]; options: object }[] = [];
    const execFileImpl = async (
      file: string,
      args: string[],
      options: object,
    ) => {
      captured.push({ file, args, options });
      return {
        stdout: `${FULL_SHA}\trefs/heads/cursor/ux-wave1-verification-integrity\n`,
        stderr: "",
      };
    };

    await resolveRemoteBranchTipViaGitLsRemote({
      repositoryUrl: GITHUB_REPO,
      branch: "cursor/ux-wave1-verification-integrity",
      execFileImpl: execFileImpl as never,
    });

    expect(captured).toHaveLength(1);
    const { file, args } = captured[0]!;
    expect(file).toBe("git");
    expect(args).toEqual([
      "ls-remote",
      GITHUB_REPO,
      "refs/heads/cursor/ux-wave1-verification-integrity",
    ]);
    for (const arg of args) {
      expect(tokenAppearsIn(arg, DUMMY_TOKEN)).toBe(false);
    }
    const env = buildGitLsRemoteEnvForRepository(GITHUB_REPO, envWithToken(DUMMY_TOKEN));
    await resolveRemoteBranchTipViaGitLsRemote({
      repositoryUrl: GITHUB_REPO,
      branch: "cursor/ux-wave1-verification-integrity",
      execFileImpl: execFileImpl as never,
    });
    // Re-run with env set in process for auth path
    const prev = process.env[RADIO_GITHUB_TOKEN_ENV];
    process.env[RADIO_GITHUB_TOKEN_ENV] = DUMMY_TOKEN;
    try {
      await resolveRemoteBranchTipViaGitLsRemote({
        repositoryUrl: GITHUB_REPO,
        branch: "cursor/ux-wave1-verification-integrity",
        execFileImpl: execFileImpl as never,
      });
      const last = captured[captured.length - 1]!;
      const opts = last.options as { env?: NodeJS.ProcessEnv };
      expect(opts.env?.GIT_ASKPASS).toBe(env?.GIT_ASKPASS);
      for (const arg of last.args) {
        expect(tokenAppearsIn(arg, DUMMY_TOKEN)).toBe(false);
      }
    } finally {
      if (prev === undefined) delete process.env[RADIO_GITHUB_TOKEN_ENV];
      else process.env[RADIO_GITHUB_TOKEN_ENV] = prev;
    }
  });

  it("RADIO_GITHUB_TOKEN_NOT_IN_REPOSITORY_URL", async () => {
    process.env[RADIO_GITHUB_TOKEN_ENV] = DUMMY_TOKEN;
    try {
      const captured: string[] = [];
      await resolveRemoteBranchTipViaGitLsRemote({
        repositoryUrl: GITHUB_REPO,
        branch: "main",
        execFileImpl: (async (
          _f: string,
          args: string[],
        ) => {
          captured.push(args[1] as string);
          return { stdout: `${FULL_SHA}\trefs/heads/main\n`, stderr: "" };
        }) as never,
      });
      expect(captured[0]).toBe(GITHUB_REPO);
      expect(tokenAppearsIn(captured[0]!, DUMMY_TOKEN)).toBe(false);
      expect(captured[0]).not.toMatch(/x-access-token/);
    } finally {
      delete process.env[RADIO_GITHUB_TOKEN_ENV];
    }
  });

  it("RADIO_GITHUB_TOKEN_NOT_IN_LOG_OUTPUT and NOT_IN_ERROR_OUTPUT", async () => {
    process.env[RADIO_GITHUB_TOKEN_ENV] = DUMMY_TOKEN;
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    };
    try {
      await expect(
        resolveRemoteBranchTipViaGitLsRemote({
          repositoryUrl: GITHUB_REPO,
          branch: "missing-branch",
          execFileImpl: (async () => {
            throw new Error(`authentication failed for ${GITHUB_REPO}`);
          }) as never,
        }),
      ).rejects.toThrow(SourceRefPrecheckError);

      const err = await resolveRemoteBranchTipViaGitLsRemote({
        repositoryUrl: GITHUB_REPO,
        branch: "missing-branch",
        execFileImpl: (async () => ({ stdout: "", stderr: "" })) as never,
      }).catch((e: Error) => e.message);

      for (const line of [...logs, err]) {
        expect(tokenAppearsIn(line, DUMMY_TOKEN)).toBe(false);
      }
    } finally {
      console.error = originalError;
      delete process.env[RADIO_GITHUB_TOKEN_ENV];
    }
  });

  it("NON_GITHUB_REMOTE_DOES_NOT_RECEIVE_TOKEN in exec env", async () => {
    process.env[RADIO_GITHUB_TOKEN_ENV] = DUMMY_TOKEN;
    try {
      let execEnv: NodeJS.ProcessEnv | undefined;
      await resolveRemoteBranchTipViaGitLsRemote({
        repositoryUrl: NON_GITHUB_REPO,
        branch: "main",
        execFileImpl: (async (
          _f: string,
          _a: string[],
          opts: { env?: NodeJS.ProcessEnv },
        ) => {
          execEnv = opts.env;
          return { stdout: `${FULL_SHA}\trefs/heads/main\n`, stderr: "" };
        }) as never,
      });
      expect(execEnv?.GIT_ASKPASS).toBeUndefined();
    } finally {
      delete process.env[RADIO_GITHUB_TOKEN_ENV];
    }
  });

  it("PRIVATE_REPO_AUTH_FAILURE_FAILS_CLOSED", async () => {
    process.env[RADIO_GITHUB_TOKEN_ENV] = "ghp_invalid_dummy_token";
    try {
      await expect(
        resolveRemoteBranchTipViaGitLsRemote({
          repositoryUrl: GITHUB_REPO,
          branch: "cursor/ux-wave1-verification-integrity",
          execFileImpl: (async () => {
            throw new Error("fatal: could not read Username for 'https://github.com'");
          }) as never,
        }),
      ).rejects.toMatchObject({ code: "SOURCE_REF_PRECHECK_FAILED" });
    } finally {
      delete process.env[RADIO_GITHUB_TOKEN_ENV];
    }
  });

  it("PUBLIC_REPO_WITHOUT_TOKEN_REMAINS_SUPPORTED via mock", async () => {
    delete process.env[RADIO_GITHUB_TOKEN_ENV];
    const sha = await resolveRemoteBranchTipViaGitLsRemote({
      repositoryUrl: "https://github.com/public/example",
      branch: "main",
      execFileImpl: (async () => ({
        stdout: `${FULL_SHA}\trefs/heads/main\n`,
        stderr: "",
      })) as never,
    });
    expect(sha).toBe(FULL_SHA);
  });
});

describe("source verification regression (unchanged authority semantics)", () => {
  it("correct full SHA: PASS", async () => {
    const result = await verifyRemoteSourceRef({
      intent: {
        repository: GITHUB_REPO,
        expectedCommitSha: FULL_SHA,
        transportStartingRef: "cursor/ux-wave1-verification-integrity",
      },
      resolveRemoteBranchTip: async () => FULL_SHA,
    });
    expect(result.remoteResolvedSha).toBe(FULL_SHA);
  });

  it("incorrect SHA: FAIL CLOSED", async () => {
    await expect(
      verifyRemoteSourceRef({
        intent: {
          repository: GITHUB_REPO,
          expectedCommitSha: FULL_SHA,
          transportStartingRef: "cursor/ux-wave1-verification-integrity",
        },
        resolveRemoteBranchTip: async () =>
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_REF_PRECHECK_FAILED" });
  });

  it("branch missing: FAIL CLOSED", async () => {
    await expect(
      resolveRemoteBranchTipViaGitLsRemote({
        repositoryUrl: GITHUB_REPO,
        branch: "nonexistent-branch",
        execFileImpl: (async () => ({ stdout: "", stderr: "" })) as never,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_REF_PRECHECK_FAILED" });
  });

  it("SHA prefix only in verify: FAIL CLOSED", async () => {
    await expect(
      verifyRemoteSourceRef({
        intent: {
          repository: GITHUB_REPO,
          expectedCommitSha: FULL_SHA.slice(0, 7),
          transportStartingRef: "main",
        },
        resolveRemoteBranchTip: async () => FULL_SHA,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_REF_PRECHECK_FAILED" });
  });

  it("parseLsRemoteSha unchanged", () => {
    expect(parseLsRemoteSha(`${FULL_SHA}\trefs/heads/main\n`)).toBe(FULL_SHA);
    expect(parseLsRemoteSha("")).toBeNull();
  });
});

describe("askpass helper script", () => {
  it("responds with x-access-token username and token password from env", async () => {
    const script = resolveRadioGithubAskpassScriptPath();
    const execFileAsync = promisify(execFile);
    const askpassEnv = {
      PATH: process.env.PATH ?? "",
      RADIO_GITHUB_TOKEN: DUMMY_TOKEN,
    };
    const username = await execFileAsync(
      process.execPath,
      [script, "Username for 'https://github.com':"],
      { env: askpassEnv },
    );
    expect(username.stdout.trim()).toBe("x-access-token");
    expect(username.stdout).not.toContain(DUMMY_TOKEN);

    const password = await execFileAsync(
      process.execPath,
      [script, "Password for 'https://github.com':"],
      { env: askpassEnv },
    );
    expect(password.stdout.trim()).toBe(DUMMY_TOKEN);
  });
});
