import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMinimalValidReportSkeleton,
  buildMachineReadableCompletionContract,
  computeCompletionSchemaHash,
} from "../src/cursor/completion-contract.js";
import { validateCompletionReport } from "../src/cursor/completion-validator.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { createDefaultFixtureObjectiveAuthority } from "../src/runtime/objective-authority.js";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import { phase3PlanningSeedPath, runPhase3Loop } from "../src/runtime/phase3.js";
import { attemptBoundedReportRepair, MAX_REPORT_REPAIR_ATTEMPTS } from "../src/runtime/report-repair.js";
import {
  resolveRemediationBudget,
  remediationBudgetExhausted,
} from "../src/runtime/remediation-budget.js";
import { preflightWorkTypeDispatch } from "../src/runtime/work-type-preflight.js";
import { classifyWorkerReportDiagnostics } from "../src/runtime/execution-outcome.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  CursorWorkOrder,
  DecisionEnvelope,
  ObjectiveAuthority,
  OrchestratorDecision,
  ProjectState,
} from "../src/types.js";
import { getSchemaValidator, readJsonFile, resolveRepoPath } from "../src/util/io.js";

const STARTING_SHA = "aa512d6ef721f855be33ddc36da490f9de66dc23";
const FRESH_EXECUTABLE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVIDENCE_TIP_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const REMOTE_BRANCH = "cursor/recovery-retry-09";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-op-mvp-"));
}

function fenceJson(report: Record<string, unknown>): string {
  return `\`\`\`text\n${JSON.stringify(report, null, 2)}\n\`\`\``;
}

function schemaInvalidRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "operational-mvp", "schema-invalid-initial.txt"),
    "utf8",
  );
}

function validPublicationReport(
  workOrder?: CursorWorkOrder,
  agentId = "<<FIXTURE_AGENT_ID>>",
): Record<string, unknown> {
  const blocked = readJsonFile<Record<string, unknown>>(
    resolveRepoPath("fixtures", "phase2", "bellhop-blocked-source-report.json"),
  );
  const report = structuredClone(blocked);
  if (workOrder) {
    report.workOrderId = workOrder.workOrderId;
    report.workOrderRevision = workOrder.revision;
    report.projectId = workOrder.projectId;
    report.workstreamId = workOrder.workstreamId;
    report.transactionId = workOrder.transactionId;
    report.decisionId = workOrder.decisionId;
    (report.execution as Record<string, unknown>).agentAction = workOrder.agentAction;
    (report.execution as Record<string, unknown>).workType = workOrder.workType;
    const rs = report.repositoryState as Record<string, unknown>;
    rs.repository = workOrder.source.repository;
    rs.canonicalMainBranch = workOrder.source.canonicalMainBranch;
    rs.expectedCanonicalMainSha = workOrder.source.canonicalMainSha;
    rs.baseBranch = workOrder.source.baseBranch;
    rs.expectedBaseTipSha = workOrder.source.expectedBaseTipSha;
  }
  report.resultClass = "READY";
  report.terminalVerdict = "RADIO_PHASE3_FIXTURE_VERIFIED";
  (report.execution as Record<string, unknown>).status = "COMPLETED";
  const exec = report.execution as Record<string, unknown>;
  const ordinary = exec.ordinaryAgent as Record<string, unknown>;
  if (ordinary) {
    ordinary.agentId = agentId;
    ordinary.status = "COMPLETED";
    ordinary.verdict = "RADIO_PHASE3_FIXTURE_VERIFIED";
  }
  const rs = report.repositoryState as Record<string, unknown>;
  rs.sourcePinsMatched = true;
  rs.observedBaseTipSha = rs.expectedBaseTipSha ?? STARTING_SHA;
  rs.observedCanonicalMainSha = rs.expectedCanonicalMainSha;
  rs.startingWorkingSha = rs.expectedBaseTipSha ?? STARTING_SHA;
  rs.finalExecutableSha = FRESH_EXECUTABLE_SHA;
  rs.evidenceTipSha = EVIDENCE_TIP_SHA;
  rs.workingBranch = REMOTE_BRANCH;
  rs.branchTipSha = rs.expectedBaseTipSha ?? STARTING_SHA;
  report.blockers = [];
  report.requirementResults = [
    {
      requirementId: "REQ-VERIFICATION",
      status: "PASS",
      summary: "Verification complete",
      evidenceRefs: ["tests"],
      blocksAcceptance: false,
    },
  ];
  report.testResults = [
    {
      name: "node tests/run.js",
      category: "FULL",
      command: "node tests/run.js",
      result: "PASS",
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      warnings: [],
      evidenceRef: "tests",
    },
  ];
  report.remediation = {
    budget: workOrder?.budgets.maxRemediationPasses ?? 0,
    passesUsed: 0,
    exhausted: (workOrder?.budgets.maxRemediationPasses ?? 0) === 0,
    commitShas: [FRESH_EXECUTABLE_SHA],
    findingsAddressed: [],
    findingsRemaining: [],
    executableChangedAfterRemediation: false,
  };
  report.gitPr = {
    branchPushed: true,
    remoteBranch: REMOTE_BRANCH,
    branchTipSha: EVIDENCE_TIP_SHA,
    prCreationAllowed: false,
    prCreationRequired: false,
    prState: "NOT_OPENED",
    prNumber: null,
    prUrl: null,
    mergeState: "NOT_MERGED",
    mergeAttempted: false,
  };
  report.evidenceBinding = {
    finalExecutableSha: FRESH_EXECUTABLE_SHA,
    evidenceTipSha: EVIDENCE_TIP_SHA,
    browserBoundToExecutable: false,
    finalReviewsBoundToExecutable: false,
    postExecutableExecutableDiffPresent: false,
    summariesContainBothShas: true,
  };
  return report;
}

function publicationAuthority(
  overrides?: Partial<ObjectiveAuthority>,
): ObjectiveAuthority {
  const base = createDefaultFixtureObjectiveAuthority({
    projectId: "bellhop",
    workstreamId: "radio-phase3-fixture-01",
    transactionId: "radio-phase3-fixture-01-bounded-verify",
    stateRevisionBasis: 1,
    expectedStartingSha: STARTING_SHA,
  });
  return {
    ...base,
    permittedWorkTypes: ["IMPLEMENTATION", "VERIFICATION", "REMEDIATION", "CLOSEOUT"],
    completionRequirements: {
      structuredWorkerReportRequired: true,
      commitRequired: true,
      remotePublicationRequired: true,
      freshExecutableShaRequired: true,
      evidenceTipRequired: true,
    },
    ...overrides,
  };
}

function baselineWorkOrder(authority: ObjectiveAuthority): CursorWorkOrder {
  const { state, fingerprint } = loadProjectState({
    projectId: "bellhop",
    statePath: phase3PlanningSeedPath(),
  });
  const decision = structuredClone(
    readJsonFile(
      resolveRepoPath("fixtures", "decisions", "phase3-initial-launch.json"),
    ),
  ) as OrchestratorDecision;
  const envelope: DecisionEnvelope = {
    schemaVersion: "phase0-1.0",
    decisionId: decision.decisionId,
    projectId: "bellhop",
    workstreamId: authority.workstreamId,
    transactionId: authority.transactionId,
    stateRevision: state.stateRevision,
    requestFingerprint: fingerprint,
    model: "gpt-5.6-sol",
    mode: "fixture",
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
  return buildCursorWorkOrder({ state, decision, policy, objectiveAuthority: authority });
}

function extractMinimalSkeletonFromRepairPrompt(
  promptText: string,
): Record<string, unknown> {
  const marker = "MINIMAL VALID SKELETON (schema-valid — fill values, keep structure):";
  const start = promptText.indexOf(marker);
  if (start < 0) {
    throw new Error("Repair prompt missing minimal skeleton block");
  }
  const fenceStart = promptText.indexOf("```json", start);
  const jsonStart = promptText.indexOf("\n", fenceStart) + 1;
  const fenceEnd = promptText.indexOf("```", jsonStart);
  return JSON.parse(promptText.slice(jsonStart, fenceEnd).trim()) as Record<
    string,
    unknown
  >;
}

function workOrderFromRepairPrompt(promptText: string): CursorWorkOrder {
  const skeleton = extractMinimalSkeletonFromRepairPrompt(promptText);
  const rs = skeleton.repositoryState as Record<string, unknown>;
  const exec = skeleton.execution as Record<string, unknown>;
  return {
    workOrderId: skeleton.workOrderId as string,
    revision: skeleton.workOrderRevision as number,
    projectId: skeleton.projectId as string,
    workstreamId: skeleton.workstreamId as string,
    transactionId: skeleton.transactionId as string,
    decisionId: skeleton.decisionId as string,
    agentAction: exec.agentAction as CursorWorkOrder["agentAction"],
    workType: exec.workType as CursorWorkOrder["workType"],
    source: {
      repository: rs.repository as string,
      canonicalMainBranch: rs.canonicalMainBranch as string,
      canonicalMainSha: rs.expectedCanonicalMainSha as string,
      baseBranch: rs.baseBranch as string,
      expectedBaseTipSha: rs.expectedBaseTipSha as string,
      workingBranch: (rs.workingBranch as string | undefined) ?? (rs.baseBranch as string),
    },
    budgets: { maxRemediationPasses: 1 },
  } as CursorWorkOrder;
}

function seedPublicationRun(dir: string, authority: ObjectiveAuthority) {
  const statePath = path.join(dir, "PROJECT-STATE.working.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  const authorityPath = path.join(dir, "objective-authority.json");
  fs.copyFileSync(phase3PlanningSeedPath(), statePath);
  fs.writeFileSync(ledgerPath, "", "utf8");
  fs.writeFileSync(authorityPath, JSON.stringify(authority, null, 2));
  return { statePath, ledgerPath, authorityPath, runDir: dir };
}

describe("completion contract — minimal valid skeleton", () => {
  it("template validates against canonical schema", () => {
    const authority = publicationAuthority();
    const workOrder = baselineWorkOrder(authority);
    const skeleton = buildMinimalValidReportSkeleton(workOrder, {
      plannedAgentId: "bc-test-agent-0001",
    });
    const validate = getSchemaValidator("cursor-completion-report.schema.json");
    expect(validate(skeleton)).toBe(true);
    const contract = buildMachineReadableCompletionContract(workOrder, {
      plannedAgentId: "bc-test-agent-0001",
    });
    expect(contract.schemaHash).toBe(computeCompletionSchemaHash());
    expect(contract.minimalValidTemplate).toEqual(skeleton);
  });
});

describe("report repair — same worker", () => {
  it("invalid report auto-repair: same agent, no new implementation worker", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const workOrder = baselineWorkOrder(authority);
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const invalid = schemaInvalidRaw();
    const valid = fenceJson(validPublicationReport(workOrder, "bc-op-mvp-repair-001"));
    const client = createPhase3FixtureCursorClient([
      {
        rawResult: invalid,
        agentId: "bc-op-mvp-repair-001",
        followUpResults: [valid],
      },
    ]);
    await client.createAgent({
      prompt: { text: "implementation" },
      agentId: "bc-op-mvp-repair-001",
      repos: [{ url: "https://github.com/timcgha/Bellhop" }],
    });

    const repair = await attemptBoundedReportRepair({
      agentId: "bc-op-mvp-repair-001",
      runId: "run-001",
      workOrder,
      state,
      rawResultText: invalid,
      structuredWorkerReportRequired: true,
      client,
      repairRunDir: path.join(dir, "repair"),
      pollIntervalMs: 1,
      pollMaxAttempts: 3,
    });

    expect(repair.ok).toBe(true);
    expect(repair.code).toBe("REPAIR_SUCCEEDED");
    expect(repair.sameAgentUsed).toBe(true);
    expect(repair.newImplementationAgentCreated).toBe(false);
    expect(repair.sourceMutationDuringReportRepair).toBe(false);
    expect(repair.remediationBudgetConsumed).toBe(false);
    expect(client.followUpCallCount).toBe(1);
    expect(repair.newImplementationAgentCreated).toBe(false);
    expect(repair.reportValid).toBe(true);
  });

  it("second repair attempt succeeds", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const workOrder = baselineWorkOrder(authority);
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const invalid = schemaInvalidRaw();
    const stillInvalid = schemaInvalidRaw();
    const valid = fenceJson(validPublicationReport(workOrder, "bc-op-mvp-repair-002"));
    const client = createPhase3FixtureCursorClient([
      {
        rawResult: invalid,
        agentId: "bc-op-mvp-repair-002",
        followUpResults: [stillInvalid, valid],
      },
    ]);
    await client.createAgent({
      prompt: { text: "implementation" },
      agentId: "bc-op-mvp-repair-002",
      repos: [{ url: "https://github.com/timcgha/Bellhop" }],
    });

    const repair = await attemptBoundedReportRepair({
      agentId: "bc-op-mvp-repair-002",
      runId: "run-002",
      workOrder,
      state,
      rawResultText: invalid,
      structuredWorkerReportRequired: true,
      client,
      repairRunDir: path.join(dir, "repair"),
      pollIntervalMs: 1,
      pollMaxAttempts: 3,
    });

    expect(repair.ok).toBe(true);
    expect(repair.attempts).toBe(2);
    expect(repair.code).toBe("REPAIR_SUCCEEDED");
    expect(client.followUpCallCount).toBe(2);
  });

  it("repair exhaustion fail-closed", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const workOrder = baselineWorkOrder(authority);
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const invalid = schemaInvalidRaw();
    const client = createPhase3FixtureCursorClient([
      {
        rawResult: invalid,
        agentId: "bc-op-mvp-repair-003",
        followUpResults: [invalid, invalid],
      },
    ]);
    await client.createAgent({
      prompt: { text: "implementation" },
      agentId: "bc-op-mvp-repair-003",
      repos: [{ url: "https://github.com/timcgha/Bellhop" }],
    });

    const repair = await attemptBoundedReportRepair({
      agentId: "bc-op-mvp-repair-003",
      runId: "run-003",
      workOrder,
      state,
      rawResultText: invalid,
      structuredWorkerReportRequired: true,
      client,
      repairRunDir: path.join(dir, "repair"),
      pollIntervalMs: 1,
      pollMaxAttempts: 3,
    });

    expect(repair.ok).toBe(false);
    expect(repair.code).toBe("WORKER_REPORT_SCHEMA_REPAIR_EXHAUSTED");
    expect(repair.attempts).toBe(MAX_REPORT_REPAIR_ATTEMPTS);
    expect(client.followUpCallCount).toBe(MAX_REPORT_REPAIR_ATTEMPTS);
  });

  it("missing evidence is not fabricated", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const workOrder = baselineWorkOrder(authority);
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const invalid = schemaInvalidRaw();
    const missingEvidence = fenceJson({
      ...validPublicationReport(workOrder, "bc-op-mvp-repair-004"),
      summary: "Required evidence is absent — cannot populate required remote publication fields truthfully.",
      gitPr: {
        branchPushed: false,
        remoteBranch: null,
        branchTipSha: null,
        prCreationAllowed: false,
        prCreationRequired: false,
        prState: "NOT_APPLICABLE",
        prNumber: null,
        prUrl: null,
        mergeState: "NOT_APPLICABLE",
        mergeAttempted: false,
      },
    });
    const client = createPhase3FixtureCursorClient([
      {
        rawResult: invalid,
        agentId: "bc-op-mvp-repair-004",
        followUpResults: [
          "```text\nRequired evidence is absent — cannot populate required schema fields.\n```",
          missingEvidence,
        ],
      },
    ]);
    await client.createAgent({
      prompt: { text: "implementation" },
      agentId: "bc-op-mvp-repair-004",
      repos: [{ url: "https://github.com/timcgha/Bellhop" }],
    });

    const repair = await attemptBoundedReportRepair({
      agentId: "bc-op-mvp-repair-004",
      runId: "run-004",
      workOrder,
      state,
      rawResultText: invalid,
      structuredWorkerReportRequired: true,
      client,
      repairRunDir: path.join(dir, "repair"),
      pollIntervalMs: 1,
      pollMaxAttempts: 3,
    });

    expect(repair.ok).toBe(false);
    expect(["MISSING_EVIDENCE_NOT_FABRICATED", "WORKER_REPORT_SCHEMA_REPAIR_EXHAUSTED"]).toContain(
      repair.code,
    );
    expect(repair.reportValid).toBe(false);
  });
});

describe("remediation budget preflight", () => {
  function planningState(remediationBudget: number): ProjectState {
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    return {
      ...state,
      currentTransaction: state.currentTransaction
        ? {
            ...state.currentTransaction,
            remediationBudget,
            remediationsUsed: 0,
            remediationBudgetExhausted: remediationBudget <= 0,
          }
        : null,
    };
  }

  it("unspecified budget inherits project default", () => {
    const authority = publicationAuthority();
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const resolved = resolveRemediationBudget({ authority, state });
    expect(resolved.budget).toBe(1);
    expect(resolved.source).toBe("PROJECT_DEFAULT");
    expect(resolved.explicitZero).toBe(false);
    expect(remediationBudgetExhausted(resolved.budget, 0)).toBe(false);
  });

  it("explicit zero budget preserved", () => {
    const authority = publicationAuthority({ remediationBudget: 0 });
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const resolved = resolveRemediationBudget({ authority, state });
    expect(resolved.budget).toBe(0);
    expect(resolved.explicitZero).toBe(true);
    expect(resolved.source).toBe("EXPLICIT_OBJECTIVE");
  });

  it("REMEDIATION dispatch rejected before external worker when explicit zero", () => {
    const authority = publicationAuthority({ remediationBudget: 0 });
    const state = planningState(0);
    const decision = structuredClone(
      readJsonFile(
        resolveRepoPath("fixtures", "decisions", "phase3-initial-launch.json"),
      ),
    ) as OrchestratorDecision;
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      workType: "REMEDIATION",
      maxRemediationPasses: 1,
    };
    const preflight = preflightWorkTypeDispatch({ decision, state, authority });
    expect(preflight.ok).toBe(false);
    expect(preflight.code).toBe("REMEDIATION_BUDGET_ZERO_EXPLICIT");
  });
});

describe("execution outcome classification", () => {
  it("schema invalid is machine recoverable when structured report required", () => {
    const c = classifyWorkerReportDiagnostics({
      structuredWorkerReportRequired: true,
      reportValid: false,
      diagnosticStatus: "SCHEMA_INVALID",
    });
    expect(c.machineRecoverable).toBe(true);
    expect(c.class).toBe("MACHINE_RECOVERABLE");
  });

  it("Bellhop without structured report requirement is backward compatible", () => {
    const c = classifyWorkerReportDiagnostics({
      structuredWorkerReportRequired: false,
      reportValid: false,
      diagnosticStatus: "PROSE",
    });
    expect(c.machineRecoverable).toBe(false);
  });
});

describe("zero-relay end-to-end simulation", () => {
  it("malformed report → same-worker repair → ACCEPT without human relay", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const paths = seedPublicationRun(dir, authority);
    const invalid = schemaInvalidRaw();
    const client = createPhase3FixtureCursorClient([
      {
        rawResult: invalid,
        followUpBuilders: [
          ({ agentId, promptText }) =>
            fenceJson(
              validPublicationReport(workOrderFromRepairPrompt(promptText), agentId),
            ),
        ],
      },
    ]);

    const result = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: paths.authorityPath,
      statePath: paths.statePath,
      ledgerPath: paths.ledgerPath,
      runDir: paths.runDir,
      skipObjectiveLease: true,
      initialDecisionFixturePath: resolveRepoPath(
        "fixtures",
        "decisions",
        "phase3-initial-launch.json",
      ),
      continuationDecisionFixturePaths: [
        resolveRepoPath("fixtures", "decisions", "phase3-accept-workstream.json"),
      ],
      cursorClient: client,
      resolveRemoteBranchTip: async (input) => {
        if (input.branch.includes("asteroid-garden")) {
          return STARTING_SHA;
        }
        return EVIDENCE_TIP_SHA;
      },
      verifyRemoteCommitExists: async () => true,
      verifyCommitAncestry: async () => true,
    });

    expect(result.terminalVerdict).toBe("RADIO_PHASE3_OBJECTIVE_COMPLETE");
    expect(result.runtimeState).toBe("ACCEPTED");
    expect(result.operationalTelemetry.HUMAN_MESSAGES_REQUIRED_AFTER_LAUNCH).toBe(0);
    expect(result.operationalTelemetry.SAME_WORKER_REPORT_REPAIR_USED).toBe(true);
    expect(result.operationalTelemetry.REPORT_REPAIR_ATTEMPTS).toBe(1);
    expect(result.operationalTelemetry.IMPLEMENTATION_WORKERS_CREATED).toBe(1);
    expect(client.logicalLaunchCount).toBe(1);
    expect(client.followUpCallCount).toBe(1);
    expect(fs.existsSync(path.join(dir, "report-repair-exec-1"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "phase3-checkpoint.json"))).toBe(true);

    const workOrder = readJsonFile<CursorWorkOrder>(
      path.join(dir, "work-order-iter-1.json"),
    );
    const checkpoint = readJsonFile<{ lastAgentId: string | null }>(
      path.join(dir, "phase3-checkpoint.json"),
    );
    const validation = validateCompletionReport(
      validPublicationReport(workOrder, checkpoint.lastAgentId ?? undefined),
      {
        state: result.state,
        workOrder,
        expectedAgentId: checkpoint.lastAgentId,
      },
    );
    expect(validation.ok).toBe(true);
    const skeleton = buildMinimalValidReportSkeleton(workOrder);
    expect(getSchemaValidator("cursor-completion-report.schema.json")(skeleton)).toBe(
      true,
    );
  });
});
