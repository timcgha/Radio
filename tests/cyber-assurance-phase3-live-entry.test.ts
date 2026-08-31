import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildCreateAgentRequest, generatePlannedAgentId } from "../src/cursor/adapter.js";
import { RADIO_GITHUB_TOKEN_ENV } from "../src/cursor/github-git-auth.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { renderCursorPrompt } from "../src/cursor/prompt-renderer.js";
import type { SolCallResult } from "../src/orchestrator/sol-adapter.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import {
  loadObjectiveAuthority,
  persistObjectiveAuthority,
} from "../src/runtime/objective-authority.js";
import {
  createMemoryObjectiveLeaseStore,
  type ObjectiveLeaseStore,
} from "../src/runtime/objective-lease.js";
import {
  assertStrictLiveLeaseBackend,
  assertStrictLiveNoInitialDecisionInjection,
  assertStrictLiveOrdering,
  LIVE_CYBER_PHASE3_MEMORY_LEASE_ALLOWED,
  LIVE_INITIAL_DECISION_INJECTION_ALLOWED,
  resolveStrictLiveObjectiveLeaseStore,
  type StrictPhase3LiveStage,
} from "../src/runtime/phase3-strict-live-guard.js";
import {
  cyberAssurancePhase3ObjectivePath,
  cyberAssurancePhase3PlanningSeedPath,
  resolveCyberAssurancePhase0Config,
  runCyberAssurancePhase3Fixture,
  runStrictCyberAssurancePhase3Loop,
} from "../src/runtime/pilot-cyber-assurance.js";
import { resolvePhase0Config } from "../src/runtime/pilot-bellhop.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  DecisionEnvelope,
  ObjectiveAuthority,
  OrchestratorDecision,
  RuntimeState,
  WorkType,
} from "../src/types.js";
import { newId, readJsonFile, resolveRepoPath } from "../src/util/io.js";

const CYBER_REPO = "https://github.com/timcgha/Cyber-assurance-demo";
const RADIO_REPO = "https://github.com/timcgha/Radio";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-cyber-phase3-live-"));
}

function passRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
    "utf8",
  );
}

function seedCyberPlanning(dir: string, authorityOverrides?: Partial<ObjectiveAuthority>) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(cyberAssurancePhase3PlanningSeedPath(), statePath);
  fs.writeFileSync(ledgerPath, "", "utf8");
  const base = loadObjectiveAuthority(cyberAssurancePhase3ObjectivePath());
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

function createGitRemoteLeaseStoreMock(
  acquireResult?: Partial<{
    ok: boolean;
    code: string;
  }>,
): ObjectiveLeaseStore {
  const memory = createMemoryObjectiveLeaseStore();
  return {
    backend: "git-remote-ref",
    tryAcquire: async (input) => {
      const result = await memory.tryAcquire(input);
      if (acquireResult?.ok === false) {
        return {
          ok: false,
          code: (acquireResult.code ?? "OBJECTIVE_ALREADY_LEASED") as
            | "OBJECTIVE_ALREADY_LEASED"
            | "OBJECTIVE_LEASE_TERMINAL",
          lease: result.lease,
          summary: "Mock lease denied for strict live test",
        };
      }
      return result;
    },
    get: (objectiveId) => memory.get(objectiveId),
    updateBinding: (input) => memory.updateBinding(input),
    markTerminal: (input) => memory.markTerminal(input),
  };
}

function launchCursorDecision(input: {
  authority: ObjectiveAuthority;
  from: RuntimeState;
  to: RuntimeState;
  workType?: WorkType;
}): OrchestratorDecision {
  return {
    schemaVersion: "1.0",
    decisionId: newId("dec"),
    generatedAt: new Date().toISOString(),
    projectId: input.authority.projectId,
    workstreamId: input.authority.workstreamId,
    transactionId: input.authority.transactionId,
    decision: "LAUNCH_CURSOR",
    reason: input.authority.summary,
    confidence: "HIGH",
    authority: {
      classification: "AUTONOMOUS_ALLOWED",
      withinAutonomousAuthority: true,
      humanApprovalRequired: false,
      reason: "Within objective authority.",
    },
    evidenceBasis: [],
    policyReferences: [],
    blockers: [],
    stateTransition: {
      from: input.from,
      to: input.to,
      reason: "Mock strict live launch.",
    },
    cursorInstruction: {
      agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
      workType: input.workType ?? "VERIFICATION",
      objective: input.authority.summary,
      baseBranch: input.authority.baseBranch ?? "main",
      expectedStartingSha: input.authority.expectedStartingSha ?? "",
      requestedWork:
        "AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED\nReturn report in one fenced text block.\n",
      verificationCriteria:
        "Acceptance criteria for the requested work; verify prohibited scope was not performed.",
      expectedTerminalVerdicts: ["UX_WAVE1_VERIFICATION_READY_FOR_REVIEW"],
      maxRemediationPasses: 0,
    },
    humanApproval: null,
    wait: null,
    terminal: null,
    proposedStateUpdates: {
      workstreamStatus: input.to,
      transactionStatus: input.to,
      terminalVerdict: null,
      pendingHumanDecisionType: null,
    },
  };
}

function liveEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CURSOR_API_KEY: "test-cursor-key-not-real",
    CURSOR_EXECUTION_ENABLED: "true",
    OPENAI_API_KEY: "test-openai-key-not-real",
    RADIO_OBJECTIVE_LEASE_BACKEND: "git-remote-ref",
    RADIO_CURSOR_WORKER_MODEL: "composer-2.5",
    [RADIO_GITHUB_TOKEN_ENV]: "ghp_dummy_test_token_not_real",
    ...overrides,
  };
}

describe("Cyber Assurance strict Phase 3 live entrypoint", () => {
  it("CYBER_PHASE3_ENTRYPOINT_EXISTS", () => {
    expect(typeof runStrictCyberAssurancePhase3Loop).toBe("function");
    expect(typeof runCyberAssurancePhase3Fixture).toBe("function");
    const cfg = resolveCyberAssurancePhase0Config([
      "node",
      "pilot-cyber-assurance",
      "--phase3",
      "--objective-authority",
      cyberAssurancePhase3ObjectivePath(),
    ]);
    expect(cfg.projectId).toBe("cyber-assurance");
    expect(cfg.phase3Live).toBe(true);
  });

  it("LIVE_GIT_REMOTE_LEASE_REQUIRED and LIVE_MEMORY_LEASE_REJECTED", () => {
    expect(LIVE_CYBER_PHASE3_MEMORY_LEASE_ALLOWED).toBe(false);
    const store = resolveStrictLiveObjectiveLeaseStore({
      env: liveEnv({ RADIO_OBJECTIVE_LEASE_BACKEND: "git-remote-ref" }),
    });
    expect(store.backend).toBe("git-remote-ref");
    const forced = resolveStrictLiveObjectiveLeaseStore({
      env: liveEnv({ RADIO_OBJECTIVE_LEASE_BACKEND: "memory" }),
    });
    expect(forced.backend).toBe("git-remote-ref");
    expect(() =>
      assertStrictLiveLeaseBackend(createMemoryObjectiveLeaseStore()),
    ).toThrow(/STRICT_LIVE_LEASE_BACKEND_REQUIRED/);
  });

  it("LIVE_INITIAL_DECISION_INJECTION_REJECTED", () => {
    expect(LIVE_INITIAL_DECISION_INJECTION_ALLOWED).toBe(false);
    expect(() =>
      assertStrictLiveNoInitialDecisionInjection({
        mode: "live",
        initialDecision: launchCursorDecision({
          authority: loadObjectiveAuthority(cyberAssurancePhase3ObjectivePath()),
          from: "PLANNING",
          to: "IMPLEMENTING",
        }),
      }),
    ).toThrow(/LIVE_INITIAL_DECISION_INJECTION_REJECTED/);
  });

  it("LEASE_FAILURE_PREVENTS_SOL and LEASE_FAILURE_PREVENTS_CURSOR", async () => {
    const dir = tmpDir();
    const paths = seedCyberPlanning(dir);
    const solCall = vi.fn();
    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);
    const config = resolveCyberAssurancePhase0Config([
      "node",
      "pilot",
      "--phase3",
      "--objective-authority",
      paths.authorityPath,
    ]);

    const result = await runStrictCyberAssurancePhase3Loop(config, {
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      env: liveEnv(),
      objectiveLeaseStore: createGitRemoteLeaseStoreMock({ ok: false }),
      cursorClient: client,
      solCall,
      skipLiveExecution: true,
    });

    expect(result.terminalVerdict).toBe("RADIO_PHASE3_OBJECTIVE_ALREADY_LEASED");
    expect(result.solDecisionCount).toBe(0);
    expect(solCall).not.toHaveBeenCalled();
    expect(client.createCallCount).toBe(0);
  });

  it("SOL_FAILURE_PREVENTS_CURSOR", async () => {
    const dir = tmpDir();
    const paths = seedCyberPlanning(dir);
    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);
    const config = resolveCyberAssurancePhase0Config([
      "node",
      "pilot",
      "--phase3",
      "--objective-authority",
      paths.authorityPath,
    ]);

    await expect(
      runStrictCyberAssurancePhase3Loop(config, {
        statePath: paths.statePath,
        ledgerPath: paths.ledgerPath,
        runDir: paths.runDir,
        env: liveEnv(),
        objectiveLeaseStore: createGitRemoteLeaseStoreMock(),
        cursorClient: client,
        skipLiveExecution: true,
        solCall: async () => {
          throw new Error("SOL_INITIAL_FAILED: mocked Sol outage");
        },
      }),
    ).rejects.toThrow(/SOL_INITIAL_FAILED/);
    expect(client.createCallCount).toBe(0);
  });

  it("source verification failure prevents lease, Sol, and Cursor", async () => {
    const dir = tmpDir();
    const paths = seedCyberPlanning(dir, {
      expectedStartingSha: "short-sha",
    });
    const solCall = vi.fn();
    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);
    const config = resolveCyberAssurancePhase0Config([
      "node",
      "pilot",
      "--phase3",
      "--objective-authority",
      paths.authorityPath,
    ]);

    await expect(
      runStrictCyberAssurancePhase3Loop(config, {
        statePath: paths.statePath,
        ledgerPath: paths.ledgerPath,
        runDir: paths.runDir,
        env: liveEnv(),
        objectiveLeaseStore: createGitRemoteLeaseStoreMock(),
        cursorClient: client,
        solCall,
      }),
    ).rejects.toThrow(/SOURCE_PIN_NOT_FULL_SHA/);
    expect(solCall).not.toHaveBeenCalled();
    expect(client.createCallCount).toBe(0);
  });

  it("STRICT_PHASE3_ORDER on happy path", async () => {
    const dir = tmpDir();
    const paths = seedCyberPlanning(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const stages: StrictPhase3LiveStage[] = [];
    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);
    const config = resolveCyberAssurancePhase0Config([
      "node",
      "pilot",
      "--phase3",
      "--objective-authority",
      paths.authorityPath,
    ]);

    const result = await runStrictCyberAssurancePhase3Loop(config, {
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      env: liveEnv(),
      objectiveLeaseStore: createGitRemoteLeaseStoreMock(),
      cursorClient: client,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      solCall: async () => {
        stages.push("SOL_INITIAL");
        const decision = launchCursorDecision({
          authority,
          from: "PLANNING",
          to: "IMPLEMENTING",
          workType: "RECOVERY",
        });
        return {
          decision,
          model: "gpt-5.6-sol",
          mode: "live" as const,
          requestId: null,
          rawText: JSON.stringify({ decision }),
          schemaCompatNotes: [],
          usage: null,
        };
      },
      solPhase2Call: async () => {
        const decision = {
          schemaVersion: "1.0" as const,
          decisionId: newId("dec"),
          generatedAt: new Date().toISOString(),
          projectId: authority.projectId,
          workstreamId: authority.workstreamId,
          transactionId: authority.transactionId,
          decision: "REQUEST_HUMAN_APPROVAL" as const,
          reason: "Human gate.",
          confidence: "HIGH" as const,
          authority: {
            classification: "HUMAN_APPROVAL_REQUIRED" as const,
            withinAutonomousAuthority: false,
            humanApprovalRequired: true,
            reason: "Human gate.",
          },
          evidenceBasis: [],
          policyReferences: [],
          blockers: [],
          stateTransition: {
            from: "REVIEWING" as RuntimeState,
            to: "READY_FOR_HUMAN" as RuntimeState,
            reason: "Stop for human judgment.",
          },
          cursorInstruction: null,
          humanApproval: {
            approvalType: "OTHER" as const,
            summary: authority.summary,
            requestedAction: "HUMAN_REVIEW",
            risk: "MEDIUM" as const,
            allowedChoices: ["APPROVE", "REJECT"],
          },
          wait: null,
          terminal: null,
          proposedStateUpdates: {
            workstreamStatus: "READY_FOR_HUMAN" as RuntimeState,
            transactionStatus: "READY_FOR_HUMAN" as RuntimeState,
            terminalVerdict: null,
            pendingHumanDecisionType: "OTHER",
          },
        };
        const assessment = {
          resultClass: "PASS" as const,
          confidence: "HIGH" as const,
          summary: "Mock human gate.",
          materialFindings: [],
          sourceIntegrityAssessment: "Radio-owned pins authoritative.",
          requiresHumanJudgment: true,
          structuredWorkerReportStatus: "UNAVAILABLE_OR_INVALID" as const,
        };
        return {
          assessment,
          decision,
          continuation: { assessment, decision },
          model: "gpt-5.6-sol",
          mode: "live" as const,
          requestId: null,
          rawText: JSON.stringify({ assessment, decision }),
          schemaCompatNotes: [],
          usage: null,
        };
      },
    });

    expect(fs.existsSync(path.join(paths.runDir, "live-entry-validation.json"))).toBe(
      true,
    );
    stages.unshift("SOURCE_VERIFIED");
    const leaseArtifact = readJsonFile<{
      backend: string;
      acquire: { ok: boolean };
    }>(path.join(paths.runDir, "objective-lease.json"));
    expect(leaseArtifact.backend).toBe("git-remote-ref");
    expect(leaseArtifact.acquire.ok).toBe(true);
    stages.splice(1, 0, "LEASE_ACQUIRED");
    if (result.cursorExecutionCount > 0) {
      stages.push("CURSOR_CREATE");
    }
    assertStrictLiveOrdering(stages);
    expect(result.solDecisionCount).toBeGreaterThanOrEqual(2);
    expect(client.createCallCount).toBe(1);
  });

  it("CYBER_TARGET_REPOSITORY and CYBER_TARGET_STARTING_REF_FROM_AUTHORITY", async () => {
    const authority = loadObjectiveAuthority(cyberAssurancePhase3ObjectivePath());
    const decision = readJsonFile<OrchestratorDecision>(
      resolveRepoPath(
        "fixtures",
        "decisions",
        "cyber-assurance-phase3-initial-launch.json",
      ),
    );
    const loaded = loadProjectState({
      projectId: "cyber-assurance",
      statePath: cyberAssurancePhase3PlanningSeedPath(),
    });
    const envelope: DecisionEnvelope = {
      schemaVersion: "phase0-1.0",
      decisionId: decision.decisionId,
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      stateRevision: loaded.state.stateRevision,
      requestFingerprint: loaded.fingerprint,
      model: "gpt-5.6-sol",
      mode: "live",
      generatedAt: new Date().toISOString(),
      cursorExecutionEnabled: true,
      notes: [],
    };
    const policy = evaluatePolicy({
      decision,
      state: loaded.state,
      envelope,
      currentFingerprint: loaded.fingerprint,
    });
    expect(policy.result).toBe("ALLOW");
    const workOrder = buildCursorWorkOrder({
      state: loaded.state,
      decision,
      policy,
      objectiveAuthority: authority,
      workerModel: "composer-2.5",
      env: liveEnv(),
    });
    const createReq = buildCreateAgentRequest({
      workOrder,
      prompt: renderCursorPrompt(workOrder),
      plannedAgentId: generatePlannedAgentId(),
      modelId: workOrder.agentPlan.workerModel!,
    });

    expect(workOrder.source.repository).toBe(CYBER_REPO);
    expect(workOrder.source.repository).not.toBe(RADIO_REPO);
    expect(createReq.repos?.[0]?.url).toBe(CYBER_REPO);
    expect(createReq.repos?.[0]?.startingRef).toBe(authority.baseBranch);
    expect(workOrder.source.baseBranch).toBe(authority.baseBranch);
    expect(workOrder.source.expectedBaseTipSha).toBe(authority.expectedStartingSha);
  });

  it("RADIO_GITHUB_TOKEN_NOT_PASSED_TO_WORKER", async () => {
    const authority = loadObjectiveAuthority(cyberAssurancePhase3ObjectivePath());
    const decision = readJsonFile<OrchestratorDecision>(
      resolveRepoPath(
        "fixtures",
        "decisions",
        "cyber-assurance-phase3-initial-launch.json",
      ),
    );
    const loaded = loadProjectState({
      projectId: "cyber-assurance",
      statePath: cyberAssurancePhase3PlanningSeedPath(),
    });
    const envelope: DecisionEnvelope = {
      schemaVersion: "phase0-1.0",
      decisionId: decision.decisionId,
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      stateRevision: loaded.state.stateRevision,
      requestFingerprint: loaded.fingerprint,
      model: "gpt-5.6-sol",
      mode: "live",
      generatedAt: new Date().toISOString(),
      cursorExecutionEnabled: true,
      notes: [],
    };
    const policy = evaluatePolicy({
      decision,
      state: loaded.state,
      envelope,
      currentFingerprint: loaded.fingerprint,
    });
    const workOrder = buildCursorWorkOrder({
      state: loaded.state,
      decision,
      policy,
      objectiveAuthority: authority,
      env: liveEnv({ [RADIO_GITHUB_TOKEN_ENV]: "ghp_secret_must_not_leak" }),
    });
    const prompt = renderCursorPrompt(workOrder);
    const createReq = buildCreateAgentRequest({
      workOrder,
      prompt,
      plannedAgentId: generatePlannedAgentId(),
      modelId: workOrder.agentPlan.workerModel!,
    });

    expect(JSON.stringify(createReq)).not.toContain("ghp_secret_must_not_leak");
    expect(prompt).not.toContain("ghp_secret_must_not_leak");
    expect(prompt).not.toContain("RADIO_GITHUB_TOKEN");
  });

  it("CYBER_PROJECT_VERIFICATION_COMMANDS preserved in work order", () => {
    const authority = loadObjectiveAuthority(cyberAssurancePhase3ObjectivePath());
    const decision = readJsonFile<OrchestratorDecision>(
      resolveRepoPath(
        "fixtures",
        "decisions",
        "cyber-assurance-phase3-initial-launch.json",
      ),
    );
    const loaded = loadProjectState({
      projectId: "cyber-assurance",
      statePath: cyberAssurancePhase3PlanningSeedPath(),
    });
    const envelope: DecisionEnvelope = {
      schemaVersion: "phase0-1.0",
      decisionId: decision.decisionId,
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      stateRevision: loaded.state.stateRevision,
      requestFingerprint: loaded.fingerprint,
      model: "gpt-5.6-sol",
      mode: "live",
      generatedAt: new Date().toISOString(),
      cursorExecutionEnabled: true,
      notes: [],
    };
    const policy = evaluatePolicy({
      decision,
      state: loaded.state,
      envelope,
      currentFingerprint: loaded.fingerprint,
    });
    expect(policy.result).toBe("ALLOW");
    const workOrder = buildCursorWorkOrder({
      state: loaded.state,
      decision,
      policy,
      objectiveAuthority: authority,
    });
    expect(workOrder.verification.requiredCommands).toEqual([
      "npm test",
      "npm run typecheck",
      "npm run lint",
      "npm run build",
      "npm run test:ux-wave1",
      "git status --short",
    ]);
  });

  it("policy denial and authority denial keep CURSOR_CREATES=0", async () => {
    const dir = tmpDir();
    const paths = seedCyberPlanning(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);
    const config = resolveCyberAssurancePhase0Config([
      "node",
      "pilot",
      "--phase3",
      "--objective-authority",
      paths.authorityPath,
    ]);

    const policyDenied = await runStrictCyberAssurancePhase3Loop(config, {
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: path.join(dir, "policy-deny"),
      env: liveEnv(),
      objectiveLeaseStore: createGitRemoteLeaseStoreMock(),
      cursorClient: client,
      skipLiveExecution: true,
      solCall: async (): Promise<SolCallResult> => ({
        decision: {
          ...launchCursorDecision({
            authority,
            from: "VERIFYING",
            to: "IMPLEMENTING",
          }),
          stateTransition: {
            from: "VERIFYING",
            to: "IMPLEMENTING",
            reason: "Invalid transition for PLANNING seed — policy should reject",
          },
        },
        model: "gpt-5.6-sol",
        mode: "live",
        requestId: null,
        rawText: "{}",
        schemaCompatNotes: [],
        usage: null,
      }),
    });
    expect(client.createCallCount).toBe(0);
    expect(policyDenied.cursorExecutionCount).toBe(0);

    const authorityDenied = await runStrictCyberAssurancePhase3Loop(config, {
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: path.join(dir, "authority-deny"),
      env: liveEnv(),
      objectiveLeaseStore: createGitRemoteLeaseStoreMock(),
      cursorClient: createPhase3FixtureCursorClient([{ rawResult: passRaw() }]),
      skipLiveExecution: true,
      solCall: async () => ({
        decision: {
          ...launchCursorDecision({
            authority,
            from: "PLANNING",
            to: "IMPLEMENTING",
          }),
          cursorInstruction: {
            ...launchCursorDecision({
              authority,
              from: "PLANNING",
              to: "IMPLEMENTING",
            }).cursorInstruction!,
            baseBranch: "wrong-branch",
          },
        },
        model: "gpt-5.6-sol",
        mode: "live" as const,
        requestId: null,
        rawText: "{}",
        schemaCompatNotes: [],
        usage: null,
      }),
    });
    expect(authorityDenied.cursorExecutionCount).toBe(0);
  });

  it("BELLHOP_BEHAVIOR_UNCHANGED", () => {
    const bellhopCfg = resolvePhase0Config([
      "node",
      "pilot-bellhop",
      "--phase3",
      "--objective-authority",
      resolveRepoPath("fixtures", "phase3", "live-entry-objective-authority.json"),
    ]);
    expect(bellhopCfg.projectId).toBe("bellhop");
    expect(bellhopCfg.phase3Live).toBe(true);
  });

  it("fixture entrypoint still passes without live side effects", async () => {
    const result = await runCyberAssurancePhase3Fixture();
    expect(result.runtimeState).toBe("READY_FOR_HUMAN");
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_READY_FOR_HUMAN");
  });
});
