import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCompletionReportTemplate,
  getCompletionSchemaShape,
  listImmutableIdentityInstructions,
  renderCompletionContractSection,
  requiredCompletionReportFieldsFromSchema,
} from "../src/cursor/completion-contract.js";
import { extractCompletionReport } from "../src/cursor/completion-parser.js";
import { validateCompletionReport } from "../src/cursor/completion-validator.js";
import { renderCursorPrompt } from "../src/cursor/prompt-renderer.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { isLegalTransition } from "../src/policy/transitions.js";
import { runPhase2, type Phase2Metrics } from "../src/runtime/phase2.js";
import { recoverInvalidReport } from "../src/runtime/recover-invalid-report.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  CursorWorkOrder,
  DecisionEnvelope,
  OrchestratorDecision,
  ProjectState,
} from "../src/types.js";
import {
  loadSchema,
  newId,
  readJsonFile,
  resolveRepoPath,
  writeJsonAtomic,
} from "../src/util/io.js";

const AGENT_ID = "bc-f4e61939-43e9-4eb8-94c4-4c3c1a9e5df5";
const PLANNED_AGENT_ID = "bc-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function loadWorkOrder(): CursorWorkOrder {
  return readJsonFile(
    resolveRepoPath("fixtures", "phase2", "bellhop-phase1-work-order.json"),
  );
}

function loadBlockedReport(): Record<string, unknown> {
  return readJsonFile(
    resolveRepoPath("fixtures", "phase2", "bellhop-blocked-source-report.json"),
  );
}

function loadProseRaw(): string {
  return fs.readFileSync(
    resolveRepoPath(
      "fixtures",
      "phase2",
      "bellhop-prose-halt-precheck-raw-result.txt",
    ),
    "utf8",
  );
}

function loadVerifyingState(): ProjectState {
  return loadProjectState({
    projectId: "bellhop",
    statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
  }).state;
}

function fence(body: string): string {
  return `\`\`\`text\n${body}\n\`\`\``;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-contract-"));
}

function buildFreshWorkOrder(): CursorWorkOrder {
  const { state, fingerprint } = loadProjectState({
    projectId: "bellhop",
    statePath: resolveRepoPath("fixtures", "state", "bellhop-planning-seed.json"),
  });
  const decision = structuredClone(
    readJsonFile(
      resolveRepoPath("fixtures", "decisions", "bellhop-legal-launch-cursor.json"),
    ),
  ) as OrchestratorDecision;
  const envelope: DecisionEnvelope = {
    schemaVersion: "phase0-1.0",
    decisionId: decision.decisionId,
    projectId: "bellhop",
    workstreamId: "radio-pilot-01",
    transactionId: "bellhop-radio-pilot-01-stage2-verification",
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
  return buildCursorWorkOrder({ state, decision, policy });
}

describe("worker completion contract from canonical schema", () => {
  it("derives required fields from schemas/cursor-completion-report.schema.json", () => {
    const schema = loadSchema("cursor-completion-report.schema.json") as {
      required: string[];
    };
    const derived = requiredCompletionReportFieldsFromSchema();
    expect(derived).toEqual([...schema.required].sort());
    expect(derived).toContain("schemaVersion");
    expect(derived).toContain("execution");
    expect(derived).toContain("resultClass");
    expect(derived).toContain("terminalVerdict");
  });

  it("prevents schema drift vs worker template top-level keys", () => {
    const workOrder = loadWorkOrder();
    const template = buildCompletionReportTemplate(workOrder, {
      plannedAgentId: PLANNED_AGENT_ID,
    });
    const shape = getCompletionSchemaShape();
    expect(Object.keys(template).sort()).toEqual(shape.requiredTopLevel);
  });

  it("renders immutable identity values into the prompt contract", () => {
    const workOrder = buildFreshWorkOrder();
    const prompt = renderCursorPrompt(workOrder, {
      plannedAgentId: PLANNED_AGENT_ID,
    });
    expect(prompt).toContain("CRITICAL COMPLETION-OUTPUT CONTRACT (MANDATORY)");
    expect(prompt).toContain("VALID JSON ONLY");
    expect(prompt).toMatch(/exactly one fenced `text` code block/i);
    expect(prompt).toContain("schemas/cursor-completion-report.schema.json");
    expect(prompt).toContain(workOrder.workOrderId);
    expect(prompt).toContain(workOrder.decisionId);
    expect(prompt).toContain(workOrder.transactionId);
    expect(prompt).toContain(PLANNED_AGENT_ID);
    expect(prompt).toContain("IMMUTABLE RADIO-SUPPLIED VALUES");
    expect(prompt).toContain("PRECHECK_BLOCKED");
    expect(prompt).toContain("Narrative prose is NEVER an acceptable completion body");
    const immutable = listImmutableIdentityInstructions(workOrder, {
      plannedAgentId: PLANNED_AGENT_ID,
    });
    expect(immutable.some((l) => l.includes(workOrder.workOrderId))).toBe(true);
  });

  it("work-order requiredReportFields stay aligned with schema", () => {
    const workOrder = buildFreshWorkOrder();
    expect(workOrder.completion.requiredReportFields).toEqual(
      requiredCompletionReportFieldsFromSchema(),
    );
  });
});

describe("prompt ↔ Phase 2 end-to-end contract", () => {
  it("A/B: rendered prompt requires schema JSON + immutable identity", () => {
    const workOrder = loadWorkOrder();
    const section = renderCompletionContractSection(workOrder, {
      plannedAgentId: AGENT_ID,
    });
    expect(section).toMatch(/VALID JSON ONLY/);
    expect(section).toContain(AGENT_ID);
    expect(section).toContain(workOrder.source.expectedBaseTipSha!);
  });

  it("C: compliant blocked JSON from contract instructions passes Phase 2", async () => {
    const metrics: Phase2Metrics = {
      cursorCreateCalls: 0,
      cursorFollowUpCalls: 0,
      remediationCalls: 0,
      specialistCalls: 0,
      solContinuationCalls: 0,
    };
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: "run-fb22133a-f1b6-4c56-938a-ab2cae667efe",
      nextDecisionFixturePath: resolveRepoPath(
        "fixtures",
        "decisions",
        "bellhop-phase2-blocked-source-next.json",
      ),
      metrics,
    });
    expect(result.reportValid).toBe(true);
    expect(result.workOutcome).toBe("BELLHOP_RADIO_PILOT_BLOCKED");
    expect(result.runtimeState).toBe("REVIEWING");
    expect(result.solContinuationCalls).toBe(1);
    expect(result.cursorCreateCalls).toBe(0);
  });

  it("D: real prose-inside-text-fence report remains JSON_PARSE_FAILED", async () => {
    const extracted = extractCompletionReport(loadProseRaw());
    expect(extracted.ok).toBe(false);
    expect(extracted.code).toBe("JSON_PARSE_FAILED");

    const metrics: Phase2Metrics = {
      cursorCreateCalls: 0,
      cursorFollowUpCalls: 0,
      remediationCalls: 0,
      specialistCalls: 0,
      solContinuationCalls: 0,
    };
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      rawResultText: loadProseRaw(),
      cursorAgentId: AGENT_ID,
      metrics,
    });
    expect(result.reportValid).toBe(false);
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_REPORT_INVALID");
    expect(result.solContinuationCalls).toBe(0);
    expect(result.runtimeState).toBe("VERIFYING");
  });

  it("E: alternate formats remain rejected", () => {
    expect(extractCompletionReport(fence("PASS")).code).toBe("JSON_PARSE_FAILED");
    expect(
      extractCompletionReport(`Here:\n${fence("{}")}`).ok,
    ).toBe(false);
    const one = fence("{}");
    expect(extractCompletionReport(`${one}\n${one}`).code).toBe(
      "MULTIPLE_TEXT_FENCES",
    );
  });
});

describe("completion outcome matrix (PASS/FAIL/BLOCKED)", () => {
  it("VALID_JSON_BLOCKED_REPORT → valid blocked", () => {
    const { state } = { state: loadVerifyingState() };
    const result = validateCompletionReport(loadBlockedReport(), {
      state,
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.workOutcome).toBe("BLOCKED");
  });

  it("VALID_JSON_FAIL_REPORT → valid failed outcome", () => {
    const report = loadBlockedReport();
    report.resultClass = "FAILED";
    report.terminalVerdict = "BELLHOP_RADIO_PILOT_BLOCKED";
    report.execution = {
      ...(report.execution as object),
      status: "FAILED",
    };
    (report.repositoryState as Record<string, unknown>).sourcePinsMatched = true;
    (report.repositoryState as Record<string, unknown>).observedBaseTipSha =
      "aa512d6ef721f855be33ddc36da490f9de66dc23";
    (report.repositoryState as Record<string, unknown>).startingWorkingSha =
      "aa512d6ef721f855be33ddc36da490f9de66dc23";
    (report.repositoryState as Record<string, unknown>).branchTipSha =
      "aa512d6ef721f855be33ddc36da490f9de66dc23";
    (report.repositoryState as Record<string, unknown>).workingBranch =
      "cursor/level4-stage2-asteroid-garden-9dce";
    report.blockers = [
      {
        id: "BLK-TEST-001",
        severity: "P0",
        class: "TEST",
        summary: "Full test suite failed",
        evidenceRefs: ["node-tests"],
        blocksAcceptance: true,
        requiresHumanJudgment: false,
        recommendedNextAction: null,
      },
    ];
    (report.remediation as Record<string, unknown>).findingsRemaining = [];
    report.testResults = [
      {
        name: "node tests/run.js",
        category: "FULL",
        command: "node tests/run.js",
        result: "FAIL",
        exitCode: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        warnings: [],
        evidenceRef: null,
      },
    ];
    const result = validateCompletionReport(report, {
      state: loadVerifyingState(),
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.workOutcome).toBe("FAILED");
  });

  it("PROSE_INSIDE_SINGLE_TEXT_FENCE → JSON_PARSE_FAILED", () => {
    expect(extractCompletionReport(loadProseRaw()).code).toBe("JSON_PARSE_FAILED");
  });

  it("EXPECTED≠OBSERVED SHA + BLOCKED → valid", () => {
    const report = loadBlockedReport();
    const rs = report.repositoryState as Record<string, unknown>;
    expect(rs.expectedBaseTipSha).toBe(
      "aa512d6ef721f855be33ddc36da490f9de66dc23",
    );
    expect(rs.observedBaseTipSha).toBe(
      "6b5cc0f0218e40d1061927df685ad328a60f84b0",
    );
    expect(rs.sourcePinsMatched).toBe(false);
    expect(report.resultClass).toBe("BLOCKED");
  });
});

describe("human-authorized invalid-report recovery", () => {
  function setupRecoveryWorkspace(mutator?: (state: ProjectState) => ProjectState) {
    const dir = tempDir();
    const seed = resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json");
    let state = readJsonFile<ProjectState>(seed);
    if (mutator) state = mutator(state);
    const statePath = path.join(dir, "PROJECT-STATE.json");
    writeJsonAtomic(statePath, state);
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    fs.writeFileSync(ledgerPath, "", "utf8");
    const validationPath = resolveRepoPath(
      "fixtures",
      "phase2",
      "bellhop-prose-halt-precheck-validation.json",
    );
    return { dir, statePath, ledgerPath, validationPath, state };
  }

  it("denies without explicit human authorization", () => {
    const ctx = setupRecoveryWorkspace();
    const result = recoverInvalidReport({
      projectId: "bellhop",
      statePath: ctx.statePath,
      ledgerPath: ctx.ledgerPath,
      humanAuthorized: false,
      expectedRevision: 3,
      validationArtifactPath: ctx.validationPath,
      runDir: path.join(ctx.dir, "run"),
      isolateState: false,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(result.cursorCallCount).toBe(0);
    expect(result.openaiCallCount).toBe(0);
  });

  it("succeeds with human auth + valid preconditions", () => {
    const ctx = setupRecoveryWorkspace();
    const result = recoverInvalidReport({
      projectId: "bellhop",
      statePath: ctx.statePath,
      ledgerPath: ctx.ledgerPath,
      humanAuthorized: true,
      expectedRevision: 3,
      validationArtifactPath: ctx.validationPath,
      runDir: path.join(ctx.dir, "run"),
      isolateState: false,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("RECOVERY_APPLIED");
    expect(result.stateRevisionBefore).toBe(3);
    expect(result.stateRevisionAfter).toBe(4);
    expect(result.runtimeStateBefore).toBe("VERIFYING");
    expect(result.runtimeStateAfter).toBe("PLANNING");
    expect(result.rejectedAgentId).toBe(AGENT_ID);
    expect(result.rejectedWorkOrderId).toBe(
      "wo-4248cb95-5852-4868-9b9e-e74153df03f9",
    );
    expect(result.cursorCallCount).toBe(0);
    expect(result.openaiCallCount).toBe(0);
    expect(result.bellhopProductMutationCount).toBe(0);
    expect(result.futureRetryAutomaticallyLaunched).toBe(false);

    const next = readJsonFile<ProjectState>(ctx.statePath);
    expect(next.radioRuntime.state).toBe("PLANNING");
    expect(next.activeAgent).toBeNull();
    expect(next.stateRevision).toBe(4);
    expect(
      next.notes.some((n) => n.includes("RADIO_HUMAN_INVALID_REPORT_RECOVERY_V1:")),
    ).toBe(true);
    expect(
      fs.existsSync(result.artifactPaths.rejectedExecutionAttribution!),
    ).toBe(true);
  });

  it("second identical recovery is denied (idempotent)", () => {
    const ctx = setupRecoveryWorkspace();
    const first = recoverInvalidReport({
      projectId: "bellhop",
      statePath: ctx.statePath,
      ledgerPath: ctx.ledgerPath,
      humanAuthorized: true,
      expectedRevision: 3,
      validationArtifactPath: ctx.validationPath,
      runDir: path.join(ctx.dir, "run1"),
      isolateState: false,
    });
    expect(first.ok).toBe(true);

    // After recovery, runtime is PLANNING and revision 4 — either stale rev or wrong state.
    const secondSameRev = recoverInvalidReport({
      projectId: "bellhop",
      statePath: ctx.statePath,
      ledgerPath: ctx.ledgerPath,
      humanAuthorized: true,
      expectedRevision: 3,
      validationArtifactPath: ctx.validationPath,
      runDir: path.join(ctx.dir, "run2"),
      isolateState: false,
    });
    expect(secondSameRev.ok).toBe(false);
    expect(["STALE_REVISION", "RECOVERY_ALREADY_CONSUMED", "WRONG_RUNTIME_STATE"]).toContain(
      secondSameRev.code,
    );
  });

  it("denies stale expected revision", () => {
    const ctx = setupRecoveryWorkspace();
    const result = recoverInvalidReport({
      projectId: "bellhop",
      statePath: ctx.statePath,
      ledgerPath: ctx.ledgerPath,
      humanAuthorized: true,
      expectedRevision: 2,
      validationArtifactPath: ctx.validationPath,
      runDir: path.join(ctx.dir, "run"),
      isolateState: false,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("STALE_REVISION");
  });

  it("denies when validation artifact shows valid report", () => {
    const ctx = setupRecoveryWorkspace();
    const validPath = path.join(ctx.dir, "valid-validation.json");
    writeJsonAtomic(validPath, {
      ok: true,
      code: "REPORT_VALID",
      reportValid: true,
    });
    const result = recoverInvalidReport({
      projectId: "bellhop",
      statePath: ctx.statePath,
      ledgerPath: ctx.ledgerPath,
      humanAuthorized: true,
      expectedRevision: 3,
      validationArtifactPath: validPath,
      runDir: path.join(ctx.dir, "run"),
      isolateState: false,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("VALIDATION_NOT_REJECTED");
  });

  it("denies non-VERIFYING runtime", () => {
    const ctx = setupRecoveryWorkspace((s) => ({
      ...s,
      radioRuntime: { ...s.radioRuntime, state: "PLANNING" },
    }));
    const result = recoverInvalidReport({
      projectId: "bellhop",
      statePath: ctx.statePath,
      ledgerPath: ctx.ledgerPath,
      humanAuthorized: true,
      expectedRevision: 3,
      validationArtifactPath: ctx.validationPath,
      runDir: path.join(ctx.dir, "run"),
      isolateState: false,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("WRONG_RUNTIME_STATE");
  });

  it("denies when active agent is still RUNNING", () => {
    const ctx = setupRecoveryWorkspace((s) => ({
      ...s,
      activeAgent: s.activeAgent
        ? { ...s.activeAgent, status: "RUNNING" }
        : null,
    }));
    const result = recoverInvalidReport({
      projectId: "bellhop",
      statePath: ctx.statePath,
      ledgerPath: ctx.ledgerPath,
      humanAuthorized: true,
      expectedRevision: 3,
      validationArtifactPath: ctx.validationPath,
      runDir: path.join(ctx.dir, "run"),
      isolateState: false,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ACTIVE_AGENT_NOT_COMPLETED");
  });

  it("does not expose VERIFYING → PLANNING to Sol legal transitions", () => {
    expect(isLegalTransition("VERIFYING", "PLANNING")).toBe(false);
  });

  it("after recovery, a future Phase 1 plan can be built again without auto-launch", () => {
    const ctx = setupRecoveryWorkspace();
    const recovered = recoverInvalidReport({
      projectId: "bellhop",
      statePath: ctx.statePath,
      ledgerPath: ctx.ledgerPath,
      humanAuthorized: true,
      expectedRevision: 3,
      validationArtifactPath: ctx.validationPath,
      runDir: path.join(ctx.dir, "run"),
      isolateState: false,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.futureRetryAutomaticallyLaunched).toBe(false);

    const { state, fingerprint } = loadProjectState({
      projectId: "bellhop",
      statePath: ctx.statePath,
    });
    expect(state.radioRuntime.state).toBe("PLANNING");
    expect(state.activeAgent).toBeNull();

    const decision = structuredClone(
      readJsonFile(
        resolveRepoPath("fixtures", "decisions", "bellhop-legal-launch-cursor.json"),
      ),
    ) as OrchestratorDecision;
    decision.decisionId = newId("dec");
    const envelope: DecisionEnvelope = {
      schemaVersion: "phase0-1.0",
      decisionId: decision.decisionId,
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
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
    expect(policy.result).toBe("ALLOW");
    const workOrder = buildCursorWorkOrder({ state, decision, policy });
    const prompt = renderCursorPrompt(workOrder);
    expect(prompt).toContain("CRITICAL COMPLETION-OUTPUT CONTRACT");
    // Recovery itself did not create a work order launch — only planning capability restored.
    expect(recovered.cursorCallCount).toBe(0);
  });
});
