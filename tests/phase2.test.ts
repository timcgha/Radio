import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractCompletionReport } from "../src/cursor/completion-parser.js";
import { validateCompletionReport } from "../src/cursor/completion-validator.js";
import { buildContinuationContext } from "../src/orchestrator/continuation-context.js";
import { contextContainsCyberAssuranceLeak } from "../src/orchestrator/context-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { isLegalTransition } from "../src/policy/transitions.js";
import { computeStateFingerprint } from "../src/state/fingerprint.js";
import { appendLedgerEvent, readLedgerEvents } from "../src/state/ledger.js";
import { boundLedgerSummary } from "../src/state/ledger-summary.js";
import { loadBellhopBrain, loadProjectState } from "../src/state/store.js";
import {
  HISTORICAL_FIXTURE_AGENT_ID,
  HISTORICAL_FIXTURE_RUN_ID,
  HISTORICAL_FIXTURE_WORK_ORDER_PATH,
  resolveWorkOrder,
  runPhase2,
  type Phase2Metrics,
} from "../src/runtime/phase2.js";
import { diagnoseStructuredWorkerReport } from "../src/runtime/worker-report-diagnostics.js";
import { validateTrustedExecutionEnvelope } from "../src/runtime/execution-envelope.js";
import type {
  CursorWorkOrder,
  DecisionEnvelope,
  OrchestratorDecision,
  ProjectState,
  SolPhase2Continuation,
} from "../src/types.js";
import {
  newId,
  readJsonFile,
  resolveRepoPath,
  writeJsonAtomic,
} from "../src/util/io.js";

const AGENT_ID = "bc-f4e61939-43e9-4eb8-94c4-4c3c1a9e5df5";
const RUN_ID = "run-fb22133a-f1b6-4c56-938a-ab2cae667efe";

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

function loadBlockedRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase2", "bellhop-blocked-source-raw-result.txt"),
    "utf8",
  );
}

function loadSchemaInvalidRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase2", "bellhop-schema-invalid-raw-result.txt"),
    "utf8",
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

function loadMaliciousRaw(): string {
  return fs.readFileSync(
    resolveRepoPath(
      "fixtures",
      "phase2",
      "bellhop-malicious-worker-raw-result.txt",
    ),
    "utf8",
  );
}

function loadVerifyingState(): {
  state: ProjectState;
  fingerprint: string;
  path: string;
} {
  return loadProjectState({
    projectId: "bellhop",
    statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
  });
}

function fence(body: string): string {
  return `\`\`\`text\n${body}\n\`\`\``;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-phase2-"));
}

function baseMetrics(): Phase2Metrics {
  return {
    cursorCreateCalls: 0,
    cursorFollowUpCalls: 0,
    remediationCalls: 0,
    specialistCalls: 0,
    solContinuationCalls: 0,
  };
}

function schemaInvalidDecisionFixture(): string {
  return resolveRepoPath(
    "fixtures",
    "decisions",
    "bellhop-phase2-schema-invalid-next.json",
  );
}

function blockedDecisionFixture(): string {
  return resolveRepoPath(
    "fixtures",
    "decisions",
    "bellhop-phase2-blocked-source-next.json",
  );
}

describe("completion report extraction", () => {
  it("extracts exactly one valid text fence as JSON", () => {
    const result = extractCompletionReport(loadBlockedRaw());
    expect(result.ok).toBe(true);
    expect(result.code).toBe("OK");
    expect(result.report?.terminalVerdict).toBe("BELLHOP_RADIO_PILOT_BLOCKED");
  });

  it("rejects zero fences", () => {
    const result = extractCompletionReport('{"schemaVersion":"1.0"}');
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ZERO_TEXT_FENCES");
  });

  it("rejects multiple text fences", () => {
    const one = fence("{}");
    const result = extractCompletionReport(`${one}\n\n${one}`);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MULTIPLE_TEXT_FENCES");
  });

  it("rejects prose before the fence", () => {
    const result = extractCompletionReport(`Here is the report:\n${loadBlockedRaw()}`);
    expect(result.ok).toBe(false);
    expect(["PROSE_OUTSIDE_FENCE", "MULTIPLE_TEXT_FENCES", "MALFORMED_FENCE"]).toContain(
      result.code,
    );
  });

  it("rejects prose after the fence", () => {
    const result = extractCompletionReport(`${loadBlockedRaw().trim()}\nThanks`);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROSE_OUTSIDE_FENCE");
  });

  it("rejects malformed JSON inside fence", () => {
    const result = extractCompletionReport(fence("{not-json"));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("JSON_PARSE_FAILED");
  });

  it("rejects nested fences", () => {
    const result = extractCompletionReport(fence('{"a":1}\n```text\n{}\n```'));
    expect(result.ok).toBe(false);
    expect(["NESTED_FENCE", "MALFORMED_FENCE", "PROSE_OUTSIDE_FENCE", "MULTIPLE_TEXT_FENCES"]).toContain(
      result.code,
    );
  });

  it("allows surrounding whitespace only", () => {
    const result = extractCompletionReport(`\n\n${loadBlockedRaw()}\n`);
    expect(result.ok).toBe(true);
  });
});

describe("completion report validation matrix", () => {
  it("A: valid PASS report → REPORT_VALID", () => {
    const report = loadBlockedReport();
    report.resultClass = "READY";
    report.terminalVerdict = "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST";
    report.execution = {
      ...(report.execution as object),
      status: "COMPLETED",
    };
    (report.repositoryState as Record<string, unknown>).sourcePinsMatched = true;
    (report.repositoryState as Record<string, unknown>).branchTipSha =
      "aa512d6ef721f855be33ddc36da490f9de66dc23";
    (report.repositoryState as Record<string, unknown>).startingWorkingSha =
      "aa512d6ef721f855be33ddc36da490f9de66dc23";
    (report.repositoryState as Record<string, unknown>).workingBranch =
      "cursor/level4-stage2-asteroid-garden-9dce";
    (report.repositoryState as Record<string, unknown>).observedBaseTipSha =
      "aa512d6ef721f855be33ddc36da490f9de66dc23";
    report.blockers = [];
    report.testResults = [
      {
        name: "node tests/run.js",
        category: "FULL",
        command: "node tests/run.js",
        result: "PASS",
        exitCode: 0,
        passed: 1660,
        failed: 0,
        skipped: 0,
        warnings: [],
        evidenceRef: null,
      },
      {
        name: "node build.js",
        category: "BUILD",
        command: "node build.js",
        result: "PASS",
        exitCode: 0,
        passed: 1,
        failed: 0,
        skipped: 0,
        warnings: [],
        evidenceRef: null,
      },
    ];
    const { state } = loadVerifyingState();
    const result = validateCompletionReport(report, {
      state,
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("REPORT_VALID");
    expect(result.workOutcome).toBe("READY");
  });

  it("B/I: valid BLOCKED source-mismatch report → REPORT_VALID + WORK_OUTCOME_BLOCKED", () => {
    const { state } = loadVerifyingState();
    const result = validateCompletionReport(loadBlockedReport(), {
      state,
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.reportValid).toBe(true);
    expect(result.workOutcome).toBe("BLOCKED");
    expect(result.sourceIntegrity).toBe("MISMATCH");
  });

  it("C: schema-invalid report → SCHEMA_INVALID (diagnostic)", () => {
    const { state } = loadVerifyingState();
    const result = validateCompletionReport({ schemaVersion: "1.0" }, {
      state,
      workOrder: loadWorkOrder(),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SCHEMA_INVALID");
  });

  it("F: workOrderId mismatch → IDENTITY_BINDING_FAILED", () => {
    const report = loadBlockedReport();
    report.workOrderId = "wo-mismatched";
    const { state } = loadVerifyingState();
    const result = validateCompletionReport(report, {
      state,
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("IDENTITY_BINDING_FAILED");
  });

  it("H: READY with source mismatch → EVIDENCE_INCONSISTENT", () => {
    const report = loadBlockedReport();
    report.resultClass = "READY";
    report.terminalVerdict = "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST";
    const { state } = loadVerifyingState();
    const result = validateCompletionReport(report, {
      state,
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("EVIDENCE_INCONSISTENT");
  });
});

describe("structured worker report diagnostics (non-blocking)", () => {
  it("canonical worker JSON → VALID", () => {
    const { state } = loadVerifyingState();
    const d = diagnoseStructuredWorkerReport(loadBlockedRaw(), {
      state,
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    expect(d.status).toBe("VALID");
    expect(d.reportValid).toBe(true);
  });

  it("prose worker result → PROSE / unavailable", () => {
    const { state } = loadVerifyingState();
    const d = diagnoseStructuredWorkerReport(loadProseRaw(), {
      state,
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    expect(["PROSE", "JSON_PARSE_FAILED", "UNAVAILABLE_OR_INVALID"]).toContain(
      d.status,
    );
    expect(d.reportValid).toBe(false);
  });

  it("JSON parse OK / schema invalid → SCHEMA_INVALID", () => {
    const { state } = loadVerifyingState();
    const d = diagnoseStructuredWorkerReport(loadSchemaInvalidRaw(), {
      state,
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    expect(d.status).toBe("SCHEMA_INVALID");
    expect(d.reportValid).toBe(false);
    expect(d.parsedReport).not.toBeNull();
  });
});

describe("phase2 pipeline — Sol continuation despite worker format", () => {
  it("1. canonical worker JSON → parser VALID → Sol called once", async () => {
    const metrics = baseMetrics();
    const checkedBefore = readJsonFile<{ stateRevision: number }>(
      resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"),
    );
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadBlockedRaw(),
      nextDecisionFixturePath: blockedDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
      metrics,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_NEXT_ACTION_READY");
    expect(result.structuredWorkerReportStatus).toBe("VALID");
    expect(result.reportValid).toBe(true);
    expect(result.runtimeState).toBe("REVIEWING");
    expect(result.solContinuationCalls).toBe(1);
    expect(result.cursorCreateCalls).toBe(0);
    expect(result.assessment?.resultClass).toBe("BLOCKED");
    expect(result.decision?.decision).toBe("REQUEST_HUMAN_APPROVAL");
    expect(result.policy?.result).toBe("REQUIRE_HUMAN");
    const checkedAfter = readJsonFile<{ stateRevision: number }>(
      resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"),
    );
    expect(checkedAfter.stateRevision).toBe(checkedBefore.stateRevision);
  });

  it("2. prose worker result → parser invalid → Sol STILL called once", async () => {
    const metrics = baseMetrics();
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadProseRaw(),
      nextDecisionFixturePath: resolveRepoPath(
        "fixtures",
        "decisions",
        "bellhop-phase2-prose-next.json",
      ),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
      metrics,
    });
    expect(result.reportValid).toBe(false);
    expect(["PROSE", "JSON_PARSE_FAILED", "UNAVAILABLE_OR_INVALID"]).toContain(
      result.structuredWorkerReportStatus,
    );
    expect(result.solContinuationCalls).toBe(1);
    expect(result.runtimeState).toBe("REVIEWING");
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_NEXT_ACTION_READY");
    expect(result.cursorCreateCalls).toBe(0);
  });

  it("3. JSON parse OK / schema invalid → Sol STILL called once (primary fixture path)", async () => {
    const metrics = baseMetrics();
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
      metrics,
    });
    expect(result.structuredWorkerReportStatus).toBe("SCHEMA_INVALID");
    expect(result.reportValid).toBe(false);
    expect(result.solContinuationCalls).toBe(1);
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_NEXT_ACTION_READY");
    expect(result.decision).not.toBeNull();
    expect(result.policy).not.toBeNull();
    expect(result.cursorCreateCalls).toBe(0);
    expect(result.cursorFollowUpCalls).toBe(0);
    expect(metrics.remediationCalls).toBe(0);
  });

  it("4. empty/missing raw result → fail closed → Sol not called", async () => {
    const metrics = baseMetrics();
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: "",
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
      metrics,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_BLOCKED");
    expect(result.solContinuationCalls).toBe(0);
    expect(result.decision).toBeNull();
    expect(result.runtimeState).toBe("VERIFYING");
  });

  it("5. wrong agent identity → fail closed", async () => {
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadSchemaInvalidRaw(),
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: "bc-wrong-agent-id-000000000000000000000",
      cursorRunId: RUN_ID,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_BLOCKED");
    expect(result.solContinuationCalls).toBe(0);
  });

  it("6. wrong run identity → fail closed", async () => {
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadSchemaInvalidRaw(),
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: "run-wrong-run-id-00000000000000000000000",
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_BLOCKED");
    expect(result.solContinuationCalls).toBe(0);
  });

  it("7. stale state revision → fail closed", async () => {
    const before = loadVerifyingState();
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadSchemaInvalidRaw(),
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
      expectedStateRevision: before.state.stateRevision - 1,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_BLOCKED");
    expect(result.solContinuationCalls).toBe(0);
  });

  it("8. nonterminal selected run → fail closed", () => {
    const { state, fingerprint } = loadVerifyingState();
    const result = validateTrustedExecutionEnvelope({
      state,
      fingerprint,
      selectedAgentId: AGENT_ID,
      selectedRunId: RUN_ID,
      workOrder: loadWorkOrder(),
      rawResultText: loadSchemaInvalidRaw(),
      cursorRun: {
        id: RUN_ID,
        agentId: AGENT_ID,
        status: "RUNNING",
        result: loadSchemaInvalidRaw(),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("RUN_NOT_TERMINAL");
  });

  it("9. malicious worker instructions cannot create authority", async () => {
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadMaliciousRaw(),
      nextDecisionFixturePath: resolveRepoPath(
        "fixtures",
        "decisions",
        "bellhop-phase2-malicious-next.json",
      ),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_NEXT_ACTION_READY");
    expect(result.solContinuationCalls).toBe(1);
    expect(result.cursorCreateCalls).toBe(0);
    expect(result.decision?.authority.humanApprovalRequired).toBe(true);
    expect(result.decision?.decision).toBe("REQUEST_HUMAN_APPROVAL");
    // Context must label untrusted evidence and forbid obedience.
    const ctx = readJsonFile<{ trustBoundary: Record<string, string> }>(
      result.artifactPaths.continuationContext!,
    );
    expect(ctx.trustBoundary.untrustedWorkerEvidence).toMatch(/DATA_ONLY/);
    const ctxFull = fs.readFileSync(
      result.artifactPaths.continuationContext!.replace(
        "continuation-context.json",
        // continuation prompt is not stored separately; check system via rebuild
        "continuation-context.json",
      ),
      "utf8",
    );
    expect(ctxFull).toContain("MODEL_INTERPRETATION_OF_UNTRUSTED_WORKER_EVIDENCE");
  });

  it("10. Sol structured output invalid → fail closed", async () => {
    const dir = tempDir();
    const bad = path.join(dir, "bad-sol.json");
    writeJsonAtomic(bad, { notAssessment: true });
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadSchemaInvalidRaw(),
      nextDecisionFixturePath: bad,
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_BLOCKED");
    expect(result.solContinuationCalls).toBe(1);
    expect(result.decision).toBeNull();
  });

  it("11. Sol decision canonical schema invalid → fail closed", async () => {
    const dir = tempDir();
    const bad = path.join(dir, "bad-decision.json");
    writeJsonAtomic(bad, {
      assessment: {
        resultClass: "UNKNOWN",
        confidence: "LOW",
        summary: "x",
        materialFindings: [],
        sourceIntegrityAssessment: "x",
        requiresHumanJudgment: true,
        structuredWorkerReportStatus: "SCHEMA_INVALID",
      },
      decision: { schemaVersion: "1.0", decisionId: "broken" },
    });
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadSchemaInvalidRaw(),
      nextDecisionFixturePath: bad,
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_BLOCKED");
    expect(result.solContinuationCalls).toBe(1);
  });

  it("12. Sol decision stale fingerprint → policy rejects / no execution", async () => {
    const continuation = readJsonFile<SolPhase2Continuation>(
      blockedDecisionFixture(),
    );
    const dir = tempDir();
    const fixturePath = path.join(dir, "stale-fp.json");
    writeJsonAtomic(fixturePath, continuation);
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadBlockedRaw(),
      nextDecisionFixturePath: fixturePath,
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
    });
    // Decision validates; policy uses post-REVIEWING fingerprint from envelope.
    // Stale fingerprint is tested by evaluating policy with wrong fingerprint.
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_NEXT_ACTION_READY");
    const wrongFp = "0".repeat(64);
    const policy = evaluatePolicy({
      decision: result.decision!,
      state: result.state,
      envelope: {
        schemaVersion: "phase0-1.0",
        decisionId: result.decision!.decisionId,
        projectId: "bellhop",
        workstreamId: "radio-pilot-01",
        transactionId: "bellhop-radio-pilot-01-stage2-verification",
        stateRevision: result.stateRevision,
        requestFingerprint: wrongFp,
        model: "gpt-5.6-sol",
        mode: "fixture",
        generatedAt: new Date().toISOString(),
        cursorExecutionEnabled: false,
        notes: [],
      },
      currentFingerprint: computeStateFingerprint(result.state),
    });
    expect(policy.result).toBe("REJECT");
    expect(result.cursorCreateCalls).toBe(0);
  });

  it("13. policy REQUIRE_HUMAN preserved → no execution", async () => {
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadSchemaInvalidRaw(),
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
    });
    expect(result.policy?.result).toBe("REQUIRE_HUMAN");
    expect(result.cursorCreateCalls).toBe(0);
  });

  it("14/16/17/18. policy ALLOW + LAUNCH_CURSOR → no Cursor create/follow-up/remediation", async () => {
    const decision = structuredClone(
      readJsonFile<OrchestratorDecision>(
        resolveRepoPath("fixtures", "decisions", "bellhop-legal-launch-cursor.json"),
      ),
    );
    decision.decisionId = newId("dec");
    decision.stateTransition = {
      from: "REVIEWING",
      to: "REMEDIATING",
      reason: "Would remediate — Phase 2 must not execute",
    };
    decision.cursorInstruction = {
      ...decision.cursorInstruction!,
      workType: "REMEDIATION",
      maxRemediationPasses: 0,
    };
    const wrapped: SolPhase2Continuation = {
      assessment: {
        resultClass: "FAIL",
        confidence: "MEDIUM",
        summary: "Fixture probes ALLOW/LAUNCH path without executing.",
        materialFindings: [],
        sourceIntegrityAssessment: "n/a",
        requiresHumanJudgment: false,
        structuredWorkerReportStatus: "SCHEMA_INVALID",
      },
      decision,
    };
    const dir = tempDir();
    const fixturePath = path.join(dir, "launch.json");
    writeJsonAtomic(fixturePath, wrapped);
    const metrics = baseMetrics();
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadSchemaInvalidRaw(),
      nextDecisionFixturePath: fixturePath,
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
      metrics,
    });
    expect(result.cursorCreateCalls).toBe(0);
    expect(result.cursorFollowUpCalls).toBe(0);
    expect(metrics.remediationCalls).toBe(0);
    expect(result.solContinuationCalls).toBe(1);
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_NEXT_ACTION_READY");
  });

  it("15. exactly one Sol continuation call maximum", async () => {
    const metrics = baseMetrics();
    await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
      metrics,
    });
    expect(metrics.solContinuationCalls).toBe(1);
  });

  it("19. oversized ledger diagnostic → safely bounded", () => {
    const huge = "X".repeat(20_000);
    const bounded = boundLedgerSummary(huge, {
      artifactRef: "/tmp/diag.json",
    });
    expect(bounded.length).toBeLessThanOrEqual(4000);
    expect(bounded).toContain("truncated");

    const dir = tempDir();
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    const event = appendLedgerEvent({
      ledgerPath,
      eventType: "CURSOR_REPORT_SCHEMA_REJECTED",
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      workOrderId: "wo-test",
      decisionId: null,
      agentId: AGENT_ID,
      stateRevisionBefore: 1,
      stateRevisionAfter: 1,
      stateFingerprint: "a".repeat(64),
      idempotencyKey: "oversized-diag-test",
      severity: "ERROR",
      summary: huge,
      summaryArtifactRef: path.join(dir, "full-diag.json"),
      payload: { fullDetailPreservedInArtifact: true },
    });
    expect(event.summary.length).toBeLessThanOrEqual(4000);
    const events = readLedgerEvents(ledgerPath);
    expect(events).toHaveLength(1);
  });

  it("20. missing RUN-LEDGER → known agent/run attribution still preserved", async () => {
    const dir = tempDir();
    const statePath = path.join(dir, "PROJECT-STATE.json");
    const seed = readJsonFile<ProjectState>(
      resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
    );
    // Durable runId on state; no ledger file present.
    seed.activeAgent = {
      ...seed.activeAgent!,
      runId: RUN_ID,
    };
    writeJsonAtomic(statePath, seed);
    const ledgerPath = path.join(dir, "does-not-exist-yet.jsonl");
    expect(fs.existsSync(ledgerPath)).toBe(false);

    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadSchemaInvalidRaw(),
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath,
      ledgerPath,
      isolateState: false,
      cursorAgentId: null,
      cursorRunId: null,
    });
    expect(result.preservedAgentAttribution.agentId).toBe(AGENT_ID);
    expect(result.preservedAgentAttribution.runId).toBe(RUN_ID);
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_NEXT_ACTION_READY");
  });

  it("21. real mode does not fall back to historical fixture IDs", async () => {
    const dir = tempDir();
    const statePath = path.join(dir, "PROJECT-STATE.json");
    const seed = readJsonFile<ProjectState>(
      resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
    );
    seed.activeAgent = {
      ...seed.activeAgent!,
      agentId: "bc-288f5519-162f-42d6-8d79-c50c6e5545dd",
      workOrderId: "wo-e5c24e9b-1362-4860-98fb-ddc11646afd8",
      runId: "run-f1469066-d807-43dc-8eff-61cb02039f0a",
    };
    seed.radioRuntime = {
      ...seed.radioRuntime,
      activeWorkOrderId: "wo-e5c24e9b-1362-4860-98fb-ddc11646afd8",
    };
    writeJsonAtomic(statePath, seed);

    // Live work-order resolution (no historical fixture default).
    const liveWo = resolveWorkOrder(
      {
        projectId: "bellhop",
        workstreamId: "radio-pilot-01",
        transactionId: "bellhop-radio-pilot-01-stage2-verification",
        model: "gpt-5.6-sol",
        mode: "live",
      },
      seed,
      dir,
    );
    expect(liveWo.workOrderId).toBe("wo-e5c24e9b-1362-4860-98fb-ddc11646afd8");
    expect(liveWo.workOrderId).not.toBe(loadWorkOrder().workOrderId);

    // Full Phase 2 with Radio-owned IDs from state (no config/env fixture defaults).
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      rawResultText: loadSchemaInvalidRaw(),
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath,
      isolateState: true,
      workOrder: liveWo,
      cursorAgentId: null,
      cursorRunId: null,
    });
    expect(result.preservedAgentAttribution.agentId).not.toBe(
      HISTORICAL_FIXTURE_AGENT_ID,
    );
    expect(result.preservedAgentAttribution.runId).not.toBe(
      HISTORICAL_FIXTURE_RUN_ID,
    );
    expect(result.preservedAgentAttribution.agentId).toBe(
      "bc-288f5519-162f-42d6-8d79-c50c6e5545dd",
    );
    expect(result.preservedAgentAttribution.runId).toBe(
      "run-f1469066-d807-43dc-8eff-61cb02039f0a",
    );
    expect(result.preservedAgentAttribution.workOrderId).toBe(
      "wo-e5c24e9b-1362-4860-98fb-ddc11646afd8",
    );
    expect(result.terminalVerdict).toBe("RADIO_PHASE2_NEXT_ACTION_READY");
  });

  it("22. fixture mode remains isolated from canonical Bellhop state", async () => {
    const before = readJsonFile<{ stateRevision: number; activeAgent: unknown }>(
      resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"),
    );
    await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
    });
    const after = readJsonFile<{ stateRevision: number; activeAgent: unknown }>(
      resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"),
    );
    expect(after.stateRevision).toBe(before.stateRevision);
    expect(after.activeAgent).toEqual(before.activeAgent);
  });

  it("VERIFYING → REVIEWING is legal without schema-valid report", () => {
    expect(isLegalTransition("VERIFYING", "REVIEWING")).toBe(true);
  });

  it("stateRevision increases on successful Phase 2 review", async () => {
    const before = loadVerifyingState();
    const result = await runPhase2({
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      model: "gpt-5.6-sol",
      mode: "fixture",
      nextDecisionFixturePath: schemaInvalidDecisionFixture(),
      statePath: resolveRepoPath("fixtures", "state", "bellhop-verifying-seed.json"),
      isolateState: true,
      cursorAgentId: AGENT_ID,
      cursorRunId: RUN_ID,
    });
    expect(result.stateRevision).toBe(before.state.stateRevision + 1);
  });
});

describe("phase2 live work-order resolution", () => {
  it("live resolveWorkOrder does not use historical fixture path by default", () => {
    const dir = tempDir();
    const state = loadVerifyingState().state;
    state.radioRuntime = {
      ...state.radioRuntime,
      activeWorkOrderId: "wo-live-from-state-001",
    };
    const wo = resolveWorkOrder(
      {
        projectId: "bellhop",
        workstreamId: "radio-pilot-01",
        transactionId: "bellhop-radio-pilot-01-stage2-verification",
        model: "gpt-5.6-sol",
        mode: "live",
      },
      state,
      dir,
    );
    expect(wo.workOrderId).toBe("wo-live-from-state-001");
    expect(wo.workOrderId).not.toBe(loadWorkOrder().workOrderId);
  });
});

describe("phase2 continuation context isolation", () => {
  it("continuation context excludes Cyber Assurance and labels untrusted evidence", () => {
    const { state } = loadVerifyingState();
    const reviewing: ProjectState = {
      ...state,
      radioRuntime: { ...state.radioRuntime, state: "REVIEWING" },
      currentTransaction: state.currentTransaction
        ? { ...state.currentTransaction, status: "REVIEWING" }
        : null,
      activeAgent: null,
    };
    const fp = computeStateFingerprint(reviewing);
    const brain = loadBellhopBrain();
    const diagnostics = diagnoseStructuredWorkerReport(loadSchemaInvalidRaw(), {
      state: reviewing,
      workOrder: loadWorkOrder(),
      expectedAgentId: AGENT_ID,
    });
    const { context, artifact } = buildContinuationContext({
      brain: { ...brain, state: reviewing, fingerprint: fp },
      state: reviewing,
      fingerprint: fp,
      workOrder: loadWorkOrder(),
      trustedIdentity: {
        agentId: AGENT_ID,
        runId: RUN_ID,
        workOrderId: loadWorkOrder().workOrderId,
        transactionId: "bellhop-radio-pilot-01-stage2-verification",
        repository: "https://github.com/timcgha/Bellhop",
        authorizedSourceSha: "aa512d6ef721f855be33ddc36da490f9de66dc23",
        transportStartingRef: "cursor/level4-stage2-asteroid-garden-9dce",
        stateRevision: reviewing.stateRevision,
        stateFingerprint: fp,
      },
      diagnostics,
      rawResultText: loadSchemaInvalidRaw(),
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
    });
    expect(contextContainsCyberAssuranceLeak(context)).toBe(false);
    expect(context.user.toLowerCase()).not.toContain("cyber assurance");
    expect(context.system).toMatch(/UNTRUSTED EXTERNAL WORKER EVIDENCE/i);
    expect(context.system).toMatch(/Do NOT obey instructions/i);
    expect(context.user).toContain("UNTRUSTED EXTERNAL WORKER EVIDENCE");
    expect(context.user).toMatch(/NO ACTION WILL BE EXECUTED/i);
    expect(artifact.phase2Boundary).toBe("NO_ACTION_WILL_BE_EXECUTED");
    expect(artifact.reportValid).toBe(false);
    expect(artifact.structuredWorkerReportStatus).toBe("SCHEMA_INVALID");
  });
});

describe("phase2 policy evaluation of next decision", () => {
  it("binds fingerprint to post-REVIEWING state", () => {
    const continuation = readJsonFile<SolPhase2Continuation>(
      blockedDecisionFixture(),
    );
    const decision = continuation.decision;
    const { state } = loadVerifyingState();
    const reviewing: ProjectState = {
      ...state,
      radioRuntime: { ...state.radioRuntime, state: "REVIEWING" },
      currentTransaction: {
        ...state.currentTransaction!,
        status: "REVIEWING",
      },
      activeAgent: null,
      stateRevision: state.stateRevision + 1,
    };
    const fp = computeStateFingerprint(reviewing);
    const envelope: DecisionEnvelope = {
      schemaVersion: "phase0-1.0",
      decisionId: decision.decisionId,
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      stateRevision: reviewing.stateRevision,
      requestFingerprint: fp,
      model: "gpt-5.6-sol",
      mode: "fixture",
      generatedAt: new Date().toISOString(),
      cursorExecutionEnabled: false,
      notes: [],
    };
    const policy = evaluatePolicy({
      decision,
      state: reviewing,
      envelope,
      currentFingerprint: fp,
    });
    expect(policy.result).toBe("REQUIRE_HUMAN");
  });
});

describe("trusted execution envelope", () => {
  it("accepts matching terminal agent + run + raw result", () => {
    const { state, fingerprint } = loadVerifyingState();
    const result = validateTrustedExecutionEnvelope({
      state,
      fingerprint,
      selectedAgentId: AGENT_ID,
      selectedRunId: RUN_ID,
      workOrder: loadWorkOrder(),
      rawResultText: loadSchemaInvalidRaw(),
    });
    expect(result.ok).toBe(true);
    expect(result.identity?.runId).toBe(RUN_ID);
  });
});
