/**
 * Global ObjectiveAuthority lease — shared durable coordination.
 *
 * At most one live orchestration run may own an ObjectiveAuthority at a time.
 * Local filesystem state is insufficient across Cursor Cloud workspaces; the
 * default production backend uses an atomic Git remote ref create-if-absent.
 *
 * Tests inject an in-memory store that preserves the same atomic semantics.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalize, nowIso, sha256Hex, writeJsonAtomic } from "../util/io.js";

const execFileAsync = promisify(execFile);

export const OBJECTIVE_LEASE_REF_PREFIX = "refs/radio-objective-leases";

export type ObjectiveLeaseStatus = "ACTIVE" | "TERMINAL";

export interface ObjectiveLeaseRecord {
  schemaVersion: "objective-lease-1.0";
  objectiveId: string;
  approvalId: string;
  workstreamId: string;
  transactionId: string;
  runId: string;
  acquiredAt: string;
  status: ObjectiveLeaseStatus;
  /** Bound after Cursor create; null while pre-dispatch. */
  agentId: string | null;
  cursorRunId: string | null;
  /** Extra ownership fingerprint (workspace / process identity). */
  ownerFingerprint: string;
  updatedAt: string;
}

export type ObjectiveLeaseAcquireCode =
  | "ACQUIRED"
  | "RENEWED_SAME_OWNER"
  | "OBJECTIVE_ALREADY_LEASED"
  | "OBJECTIVE_LEASE_TERMINAL";

export interface ObjectiveLeaseAcquireResult {
  ok: boolean;
  code: ObjectiveLeaseAcquireCode;
  lease: ObjectiveLeaseRecord | null;
  summary: string;
}

export interface ObjectiveLeaseStore {
  readonly backend: "memory" | "git-remote-ref";
  tryAcquire(input: {
    objectiveId: string;
    approvalId: string;
    workstreamId: string;
    transactionId: string;
    runId: string;
    ownerFingerprint: string;
    agentId?: string | null;
    cursorRunId?: string | null;
  }): Promise<ObjectiveLeaseAcquireResult>;
  get(objectiveId: string): Promise<ObjectiveLeaseRecord | null>;
  /** Owner-only update (bind agent / refresh timestamps). */
  updateBinding(input: {
    objectiveId: string;
    runId: string;
    agentId: string | null;
    cursorRunId: string | null;
  }): Promise<boolean>;
  /** Owner-only terminalization when objective is consumed/closed. */
  markTerminal(input: {
    objectiveId: string;
    runId: string;
  }): Promise<boolean>;
}

function sanitizeObjectiveIdForRef(objectiveId: string): string {
  const cleaned = objectiveId
    .trim()
    .replace(/[^A-Za-z0-9._\-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "");
  if (!cleaned) {
    throw new Error("OBJECTIVE_LEASE_INVALID_ID: empty objectiveId");
  }
  if (cleaned.length > 200) {
    return `${cleaned.slice(0, 160)}-${sha256Hex(objectiveId).slice(0, 16)}`;
  }
  return cleaned;
}

export function objectiveLeaseRefName(objectiveId: string): string {
  return `${OBJECTIVE_LEASE_REF_PREFIX}/${sanitizeObjectiveIdForRef(objectiveId)}`;
}

function buildLeaseRecord(input: {
  objectiveId: string;
  approvalId: string;
  workstreamId: string;
  transactionId: string;
  runId: string;
  ownerFingerprint: string;
  agentId?: string | null;
  cursorRunId?: string | null;
  status?: ObjectiveLeaseStatus;
  acquiredAt?: string;
}): ObjectiveLeaseRecord {
  const ts = nowIso();
  return {
    schemaVersion: "objective-lease-1.0",
    objectiveId: input.objectiveId,
    approvalId: input.approvalId,
    workstreamId: input.workstreamId,
    transactionId: input.transactionId,
    runId: input.runId,
    acquiredAt: input.acquiredAt ?? ts,
    status: input.status ?? "ACTIVE",
    agentId: input.agentId ?? null,
    cursorRunId: input.cursorRunId ?? null,
    ownerFingerprint: input.ownerFingerprint,
    updatedAt: ts,
  };
}

function sameOwner(
  existing: ObjectiveLeaseRecord,
  runId: string,
  ownerFingerprint: string,
): boolean {
  return (
    existing.runId === runId && existing.ownerFingerprint === ownerFingerprint
  );
}

/**
 * In-memory lease store with synchronous critical section — used by tests and
 * as a same-process fallback. Not safe across cloud workspaces.
 */
export function createMemoryObjectiveLeaseStore(): ObjectiveLeaseStore {
  const leases = new Map<string, ObjectiveLeaseRecord>();
  let chain: Promise<unknown> = Promise.resolve();

  function serialize<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T>;
  }

  return {
    backend: "memory",
    async tryAcquire(input) {
      return serialize(() => {
        const existing = leases.get(input.objectiveId) ?? null;
        if (!existing) {
          const lease = buildLeaseRecord(input);
          leases.set(input.objectiveId, lease);
          return {
            ok: true,
            code: "ACQUIRED",
            lease,
            summary: `Acquired objective lease for ${input.objectiveId}`,
          };
        }
        if (existing.status === "TERMINAL") {
          return {
            ok: false,
            code: "OBJECTIVE_LEASE_TERMINAL",
            lease: existing,
            summary: `Objective lease ${input.objectiveId} is TERMINAL (consumed)`,
          };
        }
        if (sameOwner(existing, input.runId, input.ownerFingerprint)) {
          const renewed: ObjectiveLeaseRecord = {
            ...existing,
            updatedAt: nowIso(),
            agentId: input.agentId ?? existing.agentId,
            cursorRunId: input.cursorRunId ?? existing.cursorRunId,
          };
          leases.set(input.objectiveId, renewed);
          return {
            ok: true,
            code: "RENEWED_SAME_OWNER",
            lease: renewed,
            summary: `Renewed same-owner lease for ${input.objectiveId}`,
          };
        }
        return {
          ok: false,
          code: "OBJECTIVE_ALREADY_LEASED",
          lease: existing,
          summary: `Objective ${input.objectiveId} already leased by run ${existing.runId}`,
        };
      });
    },
    async get(objectiveId) {
      return leases.get(objectiveId) ?? null;
    },
    async updateBinding(input) {
      return serialize(() => {
        const existing = leases.get(input.objectiveId);
        if (!existing || existing.runId !== input.runId) return false;
        if (existing.status !== "ACTIVE") return false;
        leases.set(input.objectiveId, {
          ...existing,
          agentId: input.agentId,
          cursorRunId: input.cursorRunId,
          updatedAt: nowIso(),
        });
        return true;
      });
    },
    async markTerminal(input) {
      return serialize(() => {
        const existing = leases.get(input.objectiveId);
        if (!existing || existing.runId !== input.runId) return false;
        leases.set(input.objectiveId, {
          ...existing,
          status: "TERMINAL",
          updatedAt: nowIso(),
        });
        return true;
      });
    },
  };
}

export interface GitRemoteObjectiveLeaseStoreOptions {
  /** Remote URL or git remote name (default: origin). */
  remote: string;
  /**
   * Optional local bare/worktree scratch for building lease commits.
   * Defaults to a temp directory per operation.
   */
  scratchRoot?: string;
  execFileImpl?: typeof execFileAsync;
}

/**
 * Git remote ref-backed lease store.
 *
 * Atomicity: `git push <remote> <commit>:refs/radio-objective-leases/<id>`
 * create-if-absent. Concurrent creators race; the remote accepts exactly one
 * new ref. Losers observe OBJECTIVE_ALREADY_LEASED.
 *
 * Updates (bind agent / terminal) use force-with-lease against the owner SHA.
 */
export function createGitRemoteObjectiveLeaseStore(
  options: GitRemoteObjectiveLeaseStoreOptions,
): ObjectiveLeaseStore {
  const run = options.execFileImpl ?? execFileAsync;
  const remote = options.remote;

  async function git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await run("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
      stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
    };
  }

  async function fetchLease(
    objectiveId: string,
  ): Promise<{ lease: ObjectiveLeaseRecord; commitSha: string } | null> {
    const ref = objectiveLeaseRefName(objectiveId);
    const scratch = fs.mkdtempSync(
      path.join(options.scratchRoot ?? os.tmpdir(), "radio-lease-fetch-"),
    );
    try {
      await git(scratch, ["init"]);
      try {
        await git(scratch, ["fetch", remote, `${ref}:refs/radio-lease-fetch`]);
      } catch {
        return null;
      }
      const { stdout: shaOut } = await git(scratch, [
        "rev-parse",
        "refs/radio-lease-fetch",
      ]);
      const commitSha = shaOut.trim();
      const { stdout: blob } = await git(scratch, [
        "show",
        `${commitSha}:lease.json`,
      ]);
      const lease = JSON.parse(blob) as ObjectiveLeaseRecord;
      return { lease, commitSha };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  async function pushLeaseCommit(
    lease: ObjectiveLeaseRecord,
    expectedOldSha: string | null,
  ): Promise<{ ok: boolean; commitSha: string | null; detail: string }> {
    const ref = objectiveLeaseRefName(lease.objectiveId);
    const scratch = fs.mkdtempSync(
      path.join(options.scratchRoot ?? os.tmpdir(), "radio-lease-push-"),
    );
    try {
      await git(scratch, ["init"]);
      await git(scratch, ["config", "user.email", "radio-lease@local"]);
      await git(scratch, ["config", "user.name", "Radio Objective Lease"]);
      const leasePath = path.join(scratch, "lease.json");
      writeJsonAtomic(leasePath, lease);
      await git(scratch, ["add", "lease.json"]);
      await git(scratch, [
        "commit",
        "-m",
        `radio-objective-lease ${lease.objectiveId} ${lease.status}`,
      ]);
      const { stdout: shaOut } = await git(scratch, ["rev-parse", "HEAD"]);
      const commitSha = shaOut.trim();

      const dst = `${commitSha}:${ref}`;
      try {
        if (expectedOldSha === null) {
          // Create-if-absent: non-force push fails if remote ref already exists.
          await git(scratch, ["push", remote, dst]);
        } else {
          await git(scratch, [
            "push",
            `--force-with-lease=${ref}:${expectedOldSha}`,
            remote,
            dst,
          ]);
        }
        return { ok: true, commitSha, detail: "pushed" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, commitSha, detail: message };
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  return {
    backend: "git-remote-ref",
    async tryAcquire(input) {
      const existing = await fetchLease(input.objectiveId);
      if (!existing) {
        const lease = buildLeaseRecord(input);
        const pushed = await pushLeaseCommit(lease, null);
        if (pushed.ok) {
          return {
            ok: true,
            code: "ACQUIRED",
            lease,
            summary: `Acquired git-remote objective lease for ${input.objectiveId}`,
          };
        }
        // Lost race — re-read winner.
        const winner = await fetchLease(input.objectiveId);
        if (winner) {
          if (winner.lease.status === "TERMINAL") {
            return {
              ok: false,
              code: "OBJECTIVE_LEASE_TERMINAL",
              lease: winner.lease,
              summary: `Objective lease ${input.objectiveId} is TERMINAL`,
            };
          }
          if (
            sameOwner(winner.lease, input.runId, input.ownerFingerprint)
          ) {
            return {
              ok: true,
              code: "RENEWED_SAME_OWNER",
              lease: winner.lease,
              summary: `Same-owner lease present for ${input.objectiveId}`,
            };
          }
          return {
            ok: false,
            code: "OBJECTIVE_ALREADY_LEASED",
            lease: winner.lease,
            summary: `Objective ${input.objectiveId} already leased by run ${winner.lease.runId}`,
          };
        }
        return {
          ok: false,
          code: "OBJECTIVE_ALREADY_LEASED",
          lease: null,
          summary: `Failed to acquire lease: ${pushed.detail}`,
        };
      }

      if (existing.lease.status === "TERMINAL") {
        return {
          ok: false,
          code: "OBJECTIVE_LEASE_TERMINAL",
          lease: existing.lease,
          summary: `Objective lease ${input.objectiveId} is TERMINAL (consumed)`,
        };
      }

      if (sameOwner(existing.lease, input.runId, input.ownerFingerprint)) {
        const renewed: ObjectiveLeaseRecord = {
          ...existing.lease,
          updatedAt: nowIso(),
          agentId: input.agentId ?? existing.lease.agentId,
          cursorRunId: input.cursorRunId ?? existing.lease.cursorRunId,
        };
        const pushed = await pushLeaseCommit(renewed, existing.commitSha);
        return {
          ok: true,
          code: "RENEWED_SAME_OWNER",
          lease: pushed.ok ? renewed : existing.lease,
          summary: `Renewed same-owner lease for ${input.objectiveId}`,
        };
      }

      return {
        ok: false,
        code: "OBJECTIVE_ALREADY_LEASED",
        lease: existing.lease,
        summary: `Objective ${input.objectiveId} already leased by run ${existing.lease.runId}`,
      };
    },
    async get(objectiveId) {
      const found = await fetchLease(objectiveId);
      return found?.lease ?? null;
    },
    async updateBinding(input) {
      const existing = await fetchLease(input.objectiveId);
      if (!existing || existing.lease.runId !== input.runId) return false;
      if (existing.lease.status !== "ACTIVE") return false;
      const next: ObjectiveLeaseRecord = {
        ...existing.lease,
        agentId: input.agentId,
        cursorRunId: input.cursorRunId,
        updatedAt: nowIso(),
      };
      const pushed = await pushLeaseCommit(next, existing.commitSha);
      return pushed.ok;
    },
    async markTerminal(input) {
      const existing = await fetchLease(input.objectiveId);
      if (!existing || existing.lease.runId !== input.runId) return false;
      const next: ObjectiveLeaseRecord = {
        ...existing.lease,
        status: "TERMINAL",
        updatedAt: nowIso(),
      };
      const pushed = await pushLeaseCommit(next, existing.commitSha);
      return pushed.ok;
    },
  };
}

export function resolveObjectiveLeaseStore(input: {
  env?: NodeJS.ProcessEnv;
  /** Injected store (tests). */
  store?: ObjectiveLeaseStore;
}): ObjectiveLeaseStore {
  if (input.store) return input.store;
  const env = input.env ?? process.env;
  const backend = (env.RADIO_OBJECTIVE_LEASE_BACKEND ?? "memory").trim();
  if (backend === "git-remote-ref" || backend === "git") {
    const remote =
      env.RADIO_OBJECTIVE_LEASE_REMOTE?.trim() ||
      env.RADIO_LEASE_GIT_REMOTE?.trim() ||
      "origin";
    return createGitRemoteObjectiveLeaseStore({ remote });
  }
  return createMemoryObjectiveLeaseStore();
}

export function leaseOwnerFingerprint(input: {
  runId: string;
  workstreamId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = input.env ?? process.env;
  const workspaceHint =
    env.CURSOR_AGENT_ID?.trim() ||
    env.HOSTNAME?.trim() ||
    env.RADIO_WORKSPACE_ID?.trim() ||
    "local";
  return sha256Hex(
    canonicalize({
      runId: input.runId,
      workstreamId: input.workstreamId,
      workspaceHint,
    }),
  ).slice(0, 32);
}
