/**
 * Control-plane reliability: global objective lease, resumable WAITING_FOR_AGENT,
 * explicit Cursor worker model, usage telemetry. Mocked only — no live APIs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildCreateAgentRequest } from "../src/cursor/adapter.js";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import {
  createMemoryObjectiveLeaseStore,
  createGitRemoteObjectiveLeaseStore,
  objectiveLeaseRefName,
} from "../src/runtime/objective-lease.js";
import {
  CURSOR_LIVE_MODEL_FIELD,
  DEFAULT_APPROVED_CURSOR_WORKER_MODEL,
  evaluateCursorWorkerModel,
  resolveCursorWorkerModelPolicy,
  buildUsageTelemetrySnapshot,
  usageDeltaTokens,
} from "../src/runtime/cursor-worker-model.js";
import {
  loadObjectiveAuthority,
  persistObjectiveAuthority,
  STAGE2_PLAYTEST_APPROVAL_ID,
} from "../src/runtime/objective-authority.js";
import { runPhase3Loop } from "../src/runtime/phase3.js";
import { renderCursorPrompt } from "../src/cursor/prompt-renderer.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { loadProjectState } from "../src/state/store.js";
import { computeStateFingerprint } from "../src/state/fingerprint.js";
import type {
  ObjectiveAuthority,
  OrchestratorDecision,
} from "../src/types.js";
import { readJsonFile, resolveRepoPath } from "../src/util/io.js";
import { execFileSync } from "node:child_process";

function tmpDir(prefix = "radio-cost-concurrency-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function objectivePath(): string {
  return resolveRepoPath("fixtures", "phase3", "objective-authority.json");
}

function planningSeed(): string {
  return resolveRepoPath("fixtures", "state", "phase3-planning-seed.json");
}

function failRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-fail.txt"),
    "utf8",
  );
}

function passRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
    "utf8",
  );
}

function seedWorkspace(dir: string, authorityOverrides?: Partial<ObjectiveAuthority>) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(planningSeed(), statePath);
  fs.writeFileSync(ledgerPath, "", "utf8");
  const base = loadObjectiveAuthority(objectivePath());
  const authorityPath = path.join(dir, "objective-authority.json");
  persistObjectiveAuthority(authorityPath, {
    ...base,
    ...authorityOverrides,
    accounting: {
      ...base.accounting,
      ...(authorityOverrides?.accounting ?? {}),
    },
  });
  return { statePath, ledgerPath, authorityPath, runDir: dir };
}

function phase3Fixtures() {
  return {
    initialDecisionFixturePath: resolveRepoPath(
      "fixtures",
      "decisions",
      "phase3-initial-launch.json",
    ),
    continuationDecisionFixturePaths: [
      resolveRepoPath("fixtures", "decisions", "phase3-retry-launch.json"),
      resolveRepoPath("fixtures", "decisions", "phase3-human-gate.json"),
    ],
  };
}

describe("global objective lease", () => {
  it("concurrent same-objective acquisition: exactly one winner", async () => {
    const store = createMemoryObjectiveLeaseStore();
    const objectiveId = "obj-concurrent-lease-test-01";
    const base = {
      objectiveId,
      approvalId: "ha-concurrent-01",
      workstreamId: "ws-concurrent-01",
      transactionId: "txn-concurrent-01",
    };

    const [a, b] = await Promise.all([
      store.tryAcquire({
        ...base,
        runId: "run-A",
        ownerFingerprint: "owner-A",
      }),
      store.tryAcquire({
        ...base,
        runId: "run-B",
        ownerFingerprint: "owner-B",
      }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.code).toBe("OBJECTIVE_ALREADY_LEASED");
    expect(winners[0]!.lease?.status).toBe("ACTIVE");
  });

  it("different objective ids may proceed independently", async () => {
    const store = createMemoryObjectiveLeaseStore();
    const [a, b] = await Promise.all([
      store.tryAcquire({
        objectiveId: "obj-diff-A",
        approvalId: "ha-A",
        workstreamId: "ws-A",
        transactionId: "txn-A",
        runId: "run-A",
        ownerFingerprint: "fp-A",
      }),
      store.tryAcquire({
        objectiveId: "obj-diff-B",
        approvalId: "ha-B",
        workstreamId: "ws-B",
        transactionId: "txn-B",
        runId: "run-B",
        ownerFingerprint: "fp-B",
      }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("git-remote-ref create-if-absent is atomic across two pushers", async () => {
    const bare = tmpDir("radio-lease-bare-");
    execFileSync("git", ["init", "--bare", bare], { encoding: "utf8" });
    const store = createGitRemoteObjectiveLeaseStore({ remote: bare });
    const objectiveId = `obj-git-lease-${Date.now()}`;
    const base = {
      objectiveId,
      approvalId: "ha-git",
      workstreamId: "ws-git",
      transactionId: "txn-git",
    };
    const [a, b] = await Promise.all([
      store.tryAcquire({
        ...base,
        runId: "run-git-A",
        ownerFingerprint: "fp-git-A",
      }),
      store.tryAcquire({
        ...base,
        runId: "run-git-B",
        ownerFingerprint: "fp-git-B",
      }),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.code).toBe("OBJECTIVE_ALREADY_LEASED");
    expect(objectiveLeaseRefName(objectiveId)).toContain(
      "refs/radio-objective-leases/",
    );
  });

  it("same-objective Phase3 processes: loser has 0 Sol and 0 Cursor creates", async () => {
    const store = createMemoryObjectiveLeaseStore();
    const sharedAuthorityId = `obj-phase3-concurrent-${Date.now()}`;
    const dirA = tmpDir("radio-lease-a-");
    const dirB = tmpDir("radio-lease-b-");
    const pathsA = seedWorkspace(dirA, { objectiveId: sharedAuthorityId });
    const pathsB = seedWorkspace(dirB, { objectiveId: sharedAuthorityId });
    const fixtures = phase3Fixtures();

    const clientA = createPhase3FixtureCursorClient([
      { rawResult: failRaw() },
      { rawResult: passRaw() },
    ]);
    const clientB = createPhase3FixtureCursorClient([
      { rawResult: failRaw() },
      { rawResult: passRaw() },
    ]);

    const [resultA, resultB] = await Promise.all([
      runPhase3Loop({
        projectId: "bellhop",
        workstreamId: "radio-phase3-fixture-01",
        transactionId: "radio-phase3-fixture-01-bounded-verify",
        model: "gpt-5.6-sol",
        mode: "fixture",
        objectiveAuthorityPath: pathsA.authorityPath,
        statePath: pathsA.statePath,
        ledgerPath: pathsA.ledgerPath,
        runDir: pathsA.runDir,
        cursorClient: clientA,
        objectiveLeaseStore: store,
        initialDecisionFixturePath: fixtures.initialDecisionFixturePath,
        continuationDecisionFixturePaths:
          fixtures.continuationDecisionFixturePaths,
        cursorRawResultSequence: [failRaw(), passRaw()],
        pollIntervalMs: 1,
        pollMaxAttempts: 5,
        sleep: async () => undefined,
        foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
        env: { RADIO_OBJECTIVE_LEASE_BACKEND: "memory" },
      }),
      runPhase3Loop({
        projectId: "bellhop",
        workstreamId: "radio-phase3-fixture-01",
        transactionId: "radio-phase3-fixture-01-bounded-verify",
        model: "gpt-5.6-sol",
        mode: "fixture",
        objectiveAuthorityPath: pathsB.authorityPath,
        statePath: pathsB.statePath,
        ledgerPath: pathsB.ledgerPath,
        runDir: pathsB.runDir,
        cursorClient: clientB,
        objectiveLeaseStore: store,
        initialDecisionFixturePath: fixtures.initialDecisionFixturePath,
        continuationDecisionFixturePaths:
          fixtures.continuationDecisionFixturePaths,
        cursorRawResultSequence: [failRaw(), passRaw()],
        pollIntervalMs: 1,
        pollMaxAttempts: 5,
        sleep: async () => undefined,
        foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
        env: { RADIO_OBJECTIVE_LEASE_BACKEND: "memory" },
      }),
    ]);

    const outcomes = [resultA, resultB];
    const winners = outcomes.filter(
      (r) => r.terminalVerdict !== "RADIO_PHASE3_OBJECTIVE_ALREADY_LEASED",
    );
    const losers = outcomes.filter(
      (r) => r.terminalVerdict === "RADIO_PHASE3_OBJECTIVE_ALREADY_LEASED",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.solDecisionCount).toBe(0);
    expect(losers[0]!.cursorExecutionCount).toBe(0);
    const loserClient =
      losers[0] === resultA ? clientA : clientB;
    expect(loserClient.createCallCount).toBe(0);
    expect(losers[0]!.stopReason).toMatch(/OBJECTIVE_ALREADY_LEASED/);
  });
});

describe("resumable WAITING_FOR_AGENT", () => {
  it("poll observation timeout stays WAITING_FOR_AGENT (not infrastructure blocked)", async () => {
    const dir = tmpDir("radio-wait-");
    const paths = seedWorkspace(dir);
    const fixtures = phase3Fixtures();
    const client = createPhase3FixtureCursorClient([
      { rawResult: passRaw(), remainRunningPolls: 100 },
    ]);

    const result = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      objectiveLeaseStore: createMemoryObjectiveLeaseStore(),
      initialDecisionFixturePath: fixtures.initialDecisionFixturePath,
      continuationDecisionFixturePaths: fixtures.continuationDecisionFixturePaths,
      cursorRawResultSequence: [passRaw()],
      pollIntervalMs: 1,
      pollMaxAttempts: 2,
      sleep: async () => undefined,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(result.terminalVerdict).toBe("RADIO_PHASE3_WAITING_FOR_AGENT");
    expect(result.runtimeState).toBe("WAITING_FOR_AGENT");
    expect(result.state.activeAgent?.agentId).toBeTruthy();
    expect(client.createCallCount).toBe(1);
    expect(result.terminalVerdict).not.toBe(
      "RADIO_PHASE3_INFRASTRUCTURE_BLOCKED",
    );
  });

  it("late FINISHED reconciliation: same agent/run, Sol continuation, no duplicate create", async () => {
    const dir = tmpDir("radio-late-finished-");
    const paths = seedWorkspace(dir);
    const fixtures = phase3Fixtures();
    const leaseStore = createMemoryObjectiveLeaseStore();
    const client = createPhase3FixtureCursorClient([
      { rawResult: passRaw(), remainRunningPolls: 2 },
    ]);

    const first = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      objectiveLeaseStore: leaseStore,
      initialDecisionFixturePath: fixtures.initialDecisionFixturePath,
      continuationDecisionFixturePaths: [
        resolveRepoPath("fixtures", "decisions", "phase3-human-gate.json"),
      ],
      cursorRawResultSequence: [passRaw()],
      pollIntervalMs: 1,
      pollMaxAttempts: 2,
      sleep: async () => undefined,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(first.terminalVerdict).toBe("RADIO_PHASE3_WAITING_FOR_AGENT");
    expect(client.createCallCount).toBe(1);
    const agentId = first.state.activeAgent?.agentId;
    const runId =
      typeof first.state.activeAgent?.runId === "string"
        ? first.state.activeAgent.runId
        : null;
    expect(agentId).toBeTruthy();
    expect(runId).toBeTruthy();

    const resumed = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      resumeRunDir: paths.runDir,
      cursorClient: client,
      objectiveLeaseStore: leaseStore,
      continuationDecisionFixturePaths: [
        resolveRepoPath("fixtures", "decisions", "phase3-human-gate.json"),
      ],
      pollIntervalMs: 1,
      pollMaxAttempts: 10,
      sleep: async () => undefined,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(client.createCallCount).toBe(1);
    const checkpoint = readJsonFile<{
      lastAgentId: string | null;
      lastRunId: string | null;
    }>(path.join(paths.runDir, "phase3-checkpoint.json"));
    expect(checkpoint.lastAgentId).toBe(agentId);
    expect(checkpoint.lastRunId).toBe(runId);
    expect(resumed.terminalVerdict).toMatch(
      /RADIO_PHASE3_READY_FOR_HUMAN|RADIO_PHASE3_AUTONOMOUS_LOOP_READY|RADIO_PHASE3_OBJECTIVE_COMPLETE/,
    );
    expect(resumed.solDecisionCount).toBeGreaterThanOrEqual(1);
  });

  it("late ERROR reconciliation: same run, no duplicate worker", async () => {
    const dir = tmpDir("radio-late-error-");
    const paths = seedWorkspace(dir);
    const fixtures = phase3Fixtures();
    const leaseStore = createMemoryObjectiveLeaseStore();
    const client = createPhase3FixtureCursorClient([
      {
        rawResult: "worker terminal ERROR evidence",
        remainRunningPolls: 2,
        terminalStatus: "ERROR",
      },
    ]);

    const first = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      objectiveLeaseStore: leaseStore,
      initialDecisionFixturePath: fixtures.initialDecisionFixturePath,
      continuationDecisionFixturePaths: fixtures.continuationDecisionFixturePaths,
      pollIntervalMs: 1,
      pollMaxAttempts: 2,
      sleep: async () => undefined,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });
    expect(first.terminalVerdict).toBe("RADIO_PHASE3_WAITING_FOR_AGENT");
    expect(client.createCallCount).toBe(1);
    const agentId = first.state.activeAgent?.agentId;

    const resumed = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      resumeRunDir: paths.runDir,
      cursorClient: client,
      objectiveLeaseStore: leaseStore,
      continuationDecisionFixturePaths: fixtures.continuationDecisionFixturePaths,
      pollIntervalMs: 1,
      pollMaxAttempts: 10,
      sleep: async () => undefined,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(client.createCallCount).toBe(1);
    expect(resumed.state.activeAgent?.agentId).toBe(agentId);
    expect(resumed.terminalVerdict).toBe("RADIO_PHASE3_BLOCKED");
    expect(resumed.terminalVerdict).not.toBe(
      "RADIO_PHASE3_INFRASTRUCTURE_BLOCKED",
    );
    expect(resumed.stopReason).toMatch(/non-success/i);
    expect(
      fs.existsSync(path.join(paths.runDir, "cursor-late-terminal-evidence.json")),
    ).toBe(true);
  });
});

describe("explicit Cursor worker model policy", () => {
  it("reports current baseline field and fail-closed omitted model", () => {
    expect(CURSOR_LIVE_MODEL_FIELD).toBe("model.id");
    expect(DEFAULT_APPROVED_CURSOR_WORKER_MODEL).toBe("composer-2");
    const policy = resolveCursorWorkerModelPolicy({});
    const omitted = evaluateCursorWorkerModel({
      modelId: null,
      policy,
      allowPolicyDefault: false,
    });
    expect(omitted.ok).toBe(false);
    expect(omitted.code).toBe("MODEL_OMITTED");
    expect(omitted.exactDollarBudgetSupported).toBe(false);
  });

  it("approved cost-controlled model allows; premium requires human", () => {
    const policy = resolveCursorWorkerModelPolicy({
      RADIO_CURSOR_WORKER_MODEL: "composer-2",
      RADIO_CURSOR_APPROVED_MODELS: "composer-2,composer-2.5",
      RADIO_CURSOR_PREMIUM_MODELS: "claude-4.6-sonnet-thinking",
      RADIO_CURSOR_PREMIUM_MODEL_APPROVED: "false",
    });
    const approved = evaluateCursorWorkerModel({
      modelId: "composer-2",
      policy,
    });
    expect(approved.ok).toBe(true);
    expect(approved.code).toBe("ALLOW");

    const premium = evaluateCursorWorkerModel({
      modelId: "claude-4.6-sonnet-thinking",
      policy,
    });
    expect(premium.ok).toBe(false);
    expect(premium.code).toBe("PREMIUM_MODEL_REQUIRES_HUMAN");
    expect(premium.humanApprovalRequired).toBe(true);
  });

  it("buildCreateAgentRequest requires explicit model.id", () => {
    const dir = tmpDir("radio-model-wo-");
    const paths = seedWorkspace(dir);
    const state = loadProjectState({
      projectId: "bellhop",
      statePath: paths.statePath,
    }).state;
    const fingerprint = computeStateFingerprint(state);
    const decision = readJsonFile<OrchestratorDecision>(
      resolveRepoPath("fixtures", "decisions", "phase3-initial-launch.json"),
    );
    const envelope = {
      schemaVersion: "phase0-1.0" as const,
      decisionId: decision.decisionId,
      projectId: decision.projectId,
      workstreamId: decision.workstreamId!,
      transactionId: decision.transactionId!,
      stateRevision: state.stateRevision,
      requestFingerprint: fingerprint,
      model: "gpt-5.6-sol",
      mode: "fixture" as const,
      generatedAt: new Date().toISOString(),
      cursorExecutionEnabled: false,
      notes: [],
    };
    const policy = evaluatePolicy({
      decision,
      state,
      envelope,
      currentFingerprint: fingerprint,
    });
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const workOrder = buildCursorWorkOrder({
      state,
      decision,
      policy,
      objectiveAuthority: authority,
      workerModel: DEFAULT_APPROVED_CURSOR_WORKER_MODEL,
    });
    expect(workOrder.agentPlan.workerModel).toBe("composer-2");
    const req = buildCreateAgentRequest({
      workOrder,
      prompt: renderCursorPrompt(workOrder),
      plannedAgentId: "bc-00000000-0000-4000-8000-0000000000aa",
      modelId: workOrder.agentPlan.workerModel!,
    });
    expect(req.model?.id).toBe("composer-2");
    expect(() =>
      buildCreateAgentRequest({
        workOrder,
        prompt: "x",
        plannedAgentId: "bc-00000000-0000-4000-8000-0000000000ab",
        modelId: "",
      }),
    ).toThrow(/MODEL_OMITTED/);
  });

  it("usage telemetry captures worker model and tokens without claiming dollar budget", () => {
    const before = buildUsageTelemetrySnapshot({
      objectiveId: "obj-1",
      agentId: "bc-1",
      runId: "run-1",
      workerModel: "composer-2",
      phase: "before",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 15,
      },
      usageCaptureStatus: "captured",
    });
    const after = buildUsageTelemetrySnapshot({
      objectiveId: "obj-1",
      agentId: "bc-1",
      runId: "run-1",
      workerModel: "composer-2",
      phase: "after",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
      },
      usageCaptureStatus: "captured",
      runtimeMs: 42,
    });
    expect(before.exactDollarBudgetSupported).toBe(false);
    expect(before.exactDollarSpend).toBeNull();
    expect(usageDeltaTokens(before, after)).toBe(135);
  });
});

describe("mocked duplicate-objective controlled run", () => {
  it("A wins lease + one Cursor create; B rejected; late FINISHED → Sol continuation", async () => {
    const store = createMemoryObjectiveLeaseStore();
    const objectiveId = `obj-mock-dup-${Date.now()}`;
    const dirA = tmpDir("radio-mock-a-");
    const dirB = tmpDir("radio-mock-b-");
    const pathsA = seedWorkspace(dirA, { objectiveId });
    const pathsB = seedWorkspace(dirB, { objectiveId });
    const fixtures = phase3Fixtures();
    const client = createPhase3FixtureCursorClient([
      { rawResult: passRaw(), remainRunningPolls: 2 },
    ]);

    const firstA = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: pathsA.authorityPath,
      statePath: pathsA.statePath,
      ledgerPath: pathsA.ledgerPath,
      runDir: pathsA.runDir,
      cursorClient: client,
      objectiveLeaseStore: store,
      initialDecisionFixturePath: fixtures.initialDecisionFixturePath,
      continuationDecisionFixturePaths: [
        resolveRepoPath("fixtures", "decisions", "phase3-human-gate.json"),
      ],
      pollIntervalMs: 1,
      pollMaxAttempts: 2,
      sleep: async () => undefined,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    const loserB = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: pathsB.authorityPath,
      statePath: pathsB.statePath,
      ledgerPath: pathsB.ledgerPath,
      runDir: pathsB.runDir,
      cursorClient: createPhase3FixtureCursorClient([{ rawResult: passRaw() }]),
      objectiveLeaseStore: store,
      initialDecisionFixturePath: fixtures.initialDecisionFixturePath,
      continuationDecisionFixturePaths: fixtures.continuationDecisionFixturePaths,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(firstA.terminalVerdict).toBe("RADIO_PHASE3_WAITING_FOR_AGENT");
    expect(client.createCallCount).toBe(1);
    expect(loserB.terminalVerdict).toBe("RADIO_PHASE3_OBJECTIVE_ALREADY_LEASED");
    expect(loserB.solDecisionCount).toBe(0);

    const resumed = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: pathsA.authorityPath,
      statePath: pathsA.statePath,
      ledgerPath: pathsA.ledgerPath,
      runDir: pathsA.runDir,
      resumeRunDir: pathsA.runDir,
      cursorClient: client,
      objectiveLeaseStore: store,
      continuationDecisionFixturePaths: [
        resolveRepoPath("fixtures", "decisions", "phase3-human-gate.json"),
      ],
      pollIntervalMs: 1,
      pollMaxAttempts: 10,
      sleep: async () => undefined,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(client.createCallCount).toBe(1);
    expect(resumed.terminalVerdict).toMatch(
      /RADIO_PHASE3_READY_FOR_HUMAN|RADIO_PHASE3_AUTONOMOUS_LOOP_READY/,
    );
    // Sol initial (first) + Sol continuation (resume) — no manual copy/paste.
    expect(firstA.solDecisionCount + resumed.solDecisionCount).toBeGreaterThanOrEqual(2);
  });
});
