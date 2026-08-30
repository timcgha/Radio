import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import {
  FIXTURE_PHASE3_IDENTITIES,
  loadObjectiveAuthority,
  persistObjectiveAuthority,
  STAGE2_PLAYTEST_APPROVAL_ID,
  validateObjectiveAuthorityForLiveEntry,
} from "../src/runtime/objective-authority.js";
import { prepareAcceptedBaselineForObjectiveStart } from "../src/runtime/phase3-objective-start.js";
import {
  phase3DefaultObjectivePath,
  phase3PlanningSeedPath,
  runPhase3Loop,
} from "../src/runtime/phase3.js";
import { resolvePhase0Config } from "../src/runtime/pilot-bellhop.js";
import { loadProjectState } from "../src/state/store.js";
import type { ObjectiveAuthority, OrchestratorDecision, RuntimeState, WorkType } from "../src/types.js";
import {
  newId,
  readJsonFile,
  resolveRepoPath,
  writeJsonAtomic,
} from "../src/util/io.js";

function bindDecision(
  decision: OrchestratorDecision,
  authority: ObjectiveAuthority,
): OrchestratorDecision {
  return {
    ...decision,
    projectId: authority.projectId,
    workstreamId: authority.workstreamId,
    transactionId: authority.transactionId,
  };
}

function launchCursorDecision(input: {
  authority: ObjectiveAuthority;
  from: RuntimeState;
  to: RuntimeState;
  workType?: WorkType;
  prompt?: string;
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
      reason: "Mock live launch.",
    },
    cursorInstruction: {
      agentAction: "FRESH_ORDINARY_AGENT_REQUIRED",
      workType: input.workType ?? "VERIFICATION",
      objective: input.authority.summary,
      baseBranch: "level3",
      expectedStartingSha: "847ca2d64090aaeb94ca681b651a44062ab9f644",
      prompt:
        input.prompt ??
        "AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED\nReturn report in one fenced text block.\n",
      expectedTerminalVerdicts: ["RADIO_PHASE3_LIVE_VERIFIED"],
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

function humanGateDecision(authority: ObjectiveAuthority): OrchestratorDecision {
  return {
    schemaVersion: "1.0",
    decisionId: newId("dec"),
    generatedAt: new Date().toISOString(),
    projectId: authority.projectId,
    workstreamId: authority.workstreamId,
    transactionId: authority.transactionId,
    decision: "REQUEST_HUMAN_APPROVAL",
    reason: "Human judgment required.",
    confidence: "HIGH",
    authority: {
      classification: "HUMAN_APPROVAL_REQUIRED",
      withinAutonomousAuthority: false,
      humanApprovalRequired: true,
      reason: "Human gate.",
    },
    evidenceBasis: [],
    policyReferences: [],
    blockers: [],
    stateTransition: {
      from: "REVIEWING",
      to: "READY_FOR_HUMAN",
      reason: "Stop for human judgment.",
    },
    cursorInstruction: null,
    humanApproval: {
      approvalType: "OTHER",
      summary: authority.summary,
      requestedAction: "HUMAN_REVIEW",
      risk: "MEDIUM",
      allowedChoices: ["APPROVE", "REJECT"],
    },
    wait: null,
    terminal: null,
    proposedStateUpdates: {
      workstreamStatus: "READY_FOR_HUMAN",
      transactionStatus: "READY_FOR_HUMAN",
      terminalVerdict: null,
      pendingHumanDecisionType: "OTHER",
    },
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-phase3-live-"));
}

function seedAcceptedBaseline(dir: string) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(
    resolveRepoPath("fixtures", "state", "bellhop-accepted-baseline-seed.json"),
    statePath,
  );
  fs.writeFileSync(ledgerPath, "", "utf8");
  return { statePath, ledgerPath, runDir: dir };
}

function liveEntryAuthorityPath(): string {
  return resolveRepoPath(
    "fixtures",
    "phase3",
    "live-entry-objective-authority.json",
  );
}

function livePlanningSeedPath(): string {
  return resolveRepoPath("fixtures", "state", "phase3-live-planning-seed.json");
}

function seedLivePlanning(dir: string, authorityOverrides?: Partial<ObjectiveAuthority>) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(livePlanningSeedPath(), statePath);
  fs.writeFileSync(ledgerPath, "", "utf8");
  const base = loadObjectiveAuthority(liveEntryAuthorityPath());
  persistObjectiveAuthority(path.join(dir, "objective-authority.json"), {
    ...base,
    ...authorityOverrides,
    accounting: {
      ...base.accounting,
      ...(authorityOverrides?.accounting ?? {}),
    },
  });
  return {
    statePath,
    ledgerPath,
    authorityPath: path.join(dir, "objective-authority.json"),
    runDir: dir,
  };
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

function stage3AuthorityPath(): string {
  return resolveRepoPath("fixtures", "phase3", "stage3-objective-authority.json");
}

describe("Phase 3 live entry gating", () => {
  it("live mode without objective authority fails closed", async () => {
    await expect(
      runPhase3Loop({
        projectId: "bellhop",
        workstreamId: "bellhop-stage3-foundation-01",
        transactionId: "bellhop-stage3-foundation-tx-01",
        model: "gpt-5.6-sol",
        mode: "live",
        objectiveAuthorityPath: path.join(tmpDir(), "missing-authority.json"),
        statePath: phase3PlanningSeedPath(),
        ledgerPath: path.join(tmpDir(), "ledger.jsonl"),
      }),
    ).rejects.toThrow();
  });

  it("CLI live mode without --objective-authority resolves null path", () => {
    const liveCfg = resolvePhase0Config(["node", "pilot", "--phase3"]);
    expect(liveCfg.phase3Live).toBe(true);
    expect(liveCfg.objectiveAuthorityPath).toBeNull();
    expect(liveCfg.workstreamId).not.toBe("radio-phase3-fixture-01");
    expect(liveCfg.transactionId).not.toBe(
      "radio-phase3-fixture-01-bounded-verify",
    );
  });

  it("live mode never resolves fixture workstream/transaction identities", () => {
    const liveCfg = resolvePhase0Config([
      "node",
      "pilot",
      "--phase3",
      "--objective-authority",
      stage3AuthorityPath(),
    ]);
    expect(liveCfg.phase3Live).toBe(true);
    for (const fixtureId of FIXTURE_PHASE3_IDENTITIES) {
      expect(liveCfg.workstreamId).not.toBe(fixtureId);
      expect(liveCfg.transactionId).not.toBe(fixtureId);
    }
    const authority = loadObjectiveAuthority(stage3AuthorityPath());
    expect(authority.workstreamId).not.toBe("radio-phase3-fixture-01");
    expect(authority.transactionId).not.toBe(
      "radio-phase3-fixture-01-bounded-verify",
    );
  });

  it("denies foreign prior Stage 2 approval as objective authority", () => {
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: resolveRepoPath(
        "fixtures",
        "state",
        "bellhop-accepted-baseline-seed.json",
      ),
    });
    const authority: ObjectiveAuthority = {
      ...loadObjectiveAuthority(stage3AuthorityPath()),
      approvalId: STAGE2_PLAYTEST_APPROVAL_ID,
    };
    const check = validateObjectiveAuthorityForLiveEntry({
      authority,
      state: loaded.state,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });
    expect(check.ok).toBe(false);
    expect(check.code).toBe("FOREIGN_APPROVAL_REUSE");
  });

  it("denies consumed objective authority", () => {
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const authority: ObjectiveAuthority = {
      ...loadObjectiveAuthority(phase3DefaultObjectivePath()),
      consumed: true,
    };
    const check = validateObjectiveAuthorityForLiveEntry({
      authority,
      state: loaded.state,
    });
    expect(check.ok).toBe(false);
    expect(check.code).toBe("OBJECTIVE_CONSUMED");
  });

  it("denies expired objective authority when expiry is supported", () => {
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const authority: ObjectiveAuthority = {
      ...loadObjectiveAuthority(phase3DefaultObjectivePath()),
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    const check = validateObjectiveAuthorityForLiveEntry({
      authority,
      state: loaded.state,
    });
    expect(check.ok).toBe(false);
    expect(check.code).toBe("AUTHORITY_EXPIRED");
  });

  it("denies wrong project binding", () => {
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const authority: ObjectiveAuthority = {
      ...loadObjectiveAuthority(phase3DefaultObjectivePath()),
      projectId: "cyber-assurance",
    };
    const check = validateObjectiveAuthorityForLiveEntry({
      authority,
      state: loaded.state,
    });
    expect(check.ok).toBe(false);
    expect(check.code).toBe("PROJECT_MISMATCH");
  });

  it("denies wrong workstream/objective fixture identity in live mode", () => {
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const authority: ObjectiveAuthority = {
      ...loadObjectiveAuthority(phase3DefaultObjectivePath()),
      workstreamId: "radio-phase3-fixture-01",
    };
    const check = validateObjectiveAuthorityForLiveEntry({
      authority,
      state: loaded.state,
    });
    expect(check.ok).toBe(false);
    expect(check.code).toBe("FIXTURE_IDENTITY_LEAK");
  });

  it("denies budget-invalid objective envelope", () => {
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: livePlanningSeedPath(),
    });
    const authority: ObjectiveAuthority = {
      ...loadObjectiveAuthority(liveEntryAuthorityPath()),
      maxCursorAgents: 0,
    };
    const check = validateObjectiveAuthorityForLiveEntry({
      authority,
      state: loaded.state,
    });
    expect(check.ok).toBe(false);
    expect(check.code).toBe("INVALID_BUDGET");
  });

  it("valid mocked live authority enters the Phase 3 loop", async () => {
    const dir = tmpDir();
    const paths = seedLivePlanning(dir);
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const client = createPhase3FixtureCursorClient([
      { rawResult: failRaw() },
      { rawResult: passRaw() },
    ]);
    const initial = launchCursorDecision({
      authority,
      from: "PLANNING",
      to: "IMPLEMENTING",
    });
    let continuationIndex = 0;
    const continuations = [
      launchCursorDecision({ authority, from: "REVIEWING", to: "PLANNING" }),
      humanGateDecision(authority),
    ];
    const solPhase2Call = async () => {
      const decision = bindDecision(
        continuations[continuationIndex] ?? humanGateDecision(authority),
        authority,
      );
      continuationIndex += 1;
      const assessment = {
        resultClass: "UNKNOWN" as const,
        confidence: "HIGH" as const,
        summary: "Mock live continuation.",
        materialFindings: [],
        sourceIntegrityAssessment: "Radio-owned pins authoritative.",
        requiresHumanJudgment: false,
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
    };

    const result = await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      initialDecision: initial,
      solPhase2Call,
      cursorRawResultSequence: [failRaw(), passRaw()],
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(result.terminalVerdict).toBe("RADIO_PHASE3_AUTONOMOUS_LOOP_READY");
    expect(result.cursorExecutionCount).toBe(2);
    expect(result.authority.consumed).toBe(true);
    expect(client.logicalLaunchCount).toBe(2);
    expect(
      fs.existsSync(path.join(paths.runDir, "live-entry-validation.json")),
    ).toBe(true);
  });

  it("does not consume authority merely because live loop started and stopped early", async () => {
    const dir = tmpDir();
    // Use accounting exhaustion after entry validation (valid envelope, spent budget).
    const paths = seedLivePlanning(dir, {
      accounting: {
        iterationsUsed: 0,
        cursorAgentsUsed: 2,
        retriesUsed: 0,
        cursorUsageTokensUsed: 0,
        estimatedSpendUsed: 0,
      },
    });
    const authority = loadObjectiveAuthority(paths.authorityPath);
    const decision = readJsonFile<OrchestratorDecision>(
      resolveRepoPath("fixtures", "decisions", "phase3-initial-launch.json"),
    );
    const clean: OrchestratorDecision = {
      ...decision,
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      cursorInstruction: decision.cursorInstruction
        ? {
            ...decision.cursorInstruction,
            prompt:
              "AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED\nVerify bounded fixture only.\n",
          }
        : null,
    };

    const before = loadObjectiveAuthority(paths.authorityPath);
    expect(before.consumed).toBe(false);

    const result = await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      initialDecision: clean,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(result.terminalVerdict).toBe("RADIO_PHASE3_BUDGET_EXHAUSTED");
    const after = loadObjectiveAuthority(
      path.join(paths.runDir, "objective-authority.json"),
    );
    expect(after.consumed).toBe(false);
    expect(after.accounting.cursorAgentsUsed).toBe(2);
  });

  it("accepted baseline can legally prepare and enter Phase 3 loop with fresh Stage 3 authority", async () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
    const authorityPath = path.join(dir, "objective-authority.json");
    fs.copyFileSync(stage3AuthorityPath(), authorityPath);
    const authority = loadObjectiveAuthority(authorityPath);

    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: paths.statePath,
    });
    expect(loaded.state.radioRuntime.state).toBe("ACCEPTED");
    expect(loaded.state.stateRevision).toBe(11);
    expect(loaded.state.activeAgent).toBeNull();
    expect(loaded.state.canonicalState.mainSha).toBe("847ca2d");

    const entry = validateObjectiveAuthorityForLiveEntry({
      authority,
      state: loaded.state,
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });
    expect(entry.ok).toBe(true);
    expect(entry.code).toBe("LIVE_ENTRY_OK");

    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);
    const stage3Launch = launchCursorDecision({
      authority,
      from: "PLANNING",
      to: "IMPLEMENTING",
      workType: "VERIFICATION",
      prompt:
        "AGENT REQUIREMENT: FRESH ORDINARY AGENT REQUIRED\nStage 3 foundation verification only.\n",
    });

    const result = await runPhase3Loop({
      projectId: authority.projectId,
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "live",
      objectiveAuthorityPath: authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      cursorClient: client,
      initialDecision: stage3Launch,
      solPhase2Call: async () => {
        const decision = humanGateDecision(authority);
        const assessment = {
          resultClass: "PASS" as const,
          confidence: "HIGH" as const,
          summary: "Mock Stage 3 human gate.",
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
      cursorRawResultSequence: [passRaw()],
      foreignApprovalIds: [STAGE2_PLAYTEST_APPROVAL_ID],
    });

    expect(result.runtimeState).toBe("READY_FOR_HUMAN");
    expect(result.state.activeWorkstream?.id).toBe(authority.workstreamId);
    expect(result.state.currentTransaction?.id).toBe(authority.transactionId);
    expect(result.state.radioRuntime.state).toBe("READY_FOR_HUMAN");
    expect(result.cursorExecutionCount).toBe(1);
    expect(
      fs.existsSync(path.join(paths.runDir, "objective-start.json")),
    ).toBe(true);
  });

  it("prepareAcceptedBaselineForObjectiveStart transitions ACCEPTED to PLANNING", () => {
    const dir = tmpDir();
    const paths = seedAcceptedBaseline(dir);
    const authority = loadObjectiveAuthority(stage3AuthorityPath());
    const loaded = loadProjectState({
      projectId: "bellhop",
      statePath: paths.statePath,
    });

    const prepared = prepareAcceptedBaselineForObjectiveStart({
      state: loaded.state,
      authority,
      statePath: paths.statePath,
    });

    expect(prepared.ok).toBe(true);
    expect(prepared.state.radioRuntime.state).toBe("PLANNING");
    expect(prepared.state.activeWorkstream?.id).toBe(authority.workstreamId);
    expect(prepared.state.currentTransaction?.id).toBe(authority.transactionId);
    expect(prepared.state.stateRevision).toBe(12);
  });
});
