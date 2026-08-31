import { describe, expect, it } from "vitest";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { evaluateCompletionAcceptanceGate, evaluateAcceptWorkstreamGate } from "../src/runtime/completion-acceptance-gate.js";
import {
  buildObjectiveAuthorityIdentityMaterial,
  computeObjectiveAuthorityIdentity,
  createDefaultFixtureObjectiveAuthority,
  loadObjectiveAuthority,
} from "../src/runtime/objective-authority.js";
import { resolveObjectiveCompletionRequirements } from "../src/runtime/completion-requirements.js";
import { buildCompletionAcceptanceContextArtifact } from "../src/runtime/completion-acceptance-context.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  CursorWorkOrder,
  DecisionEnvelope,
  ObjectiveAuthority,
  OrchestratorDecision,
} from "../src/types.js";
import type { StructuredWorkerReportDiagnostics } from "../src/runtime/worker-report-diagnostics.js";
import { readJsonFile, resolveRepoPath } from "../src/util/io.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STARTING_SHA = "aa512d6ef721f855be33ddc36da490f9de66dc23";
const FRESH_EXECUTABLE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVIDENCE_TIP_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const REMOTE_BRANCH = "cursor/recovery-retry-09";
const REPO = "https://github.com/timcgha/Bellhop";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-accept-gate-"));
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

function invalidDiagnostics(): StructuredWorkerReportDiagnostics {
  return {
    status: "SCHEMA_INVALID",
    extract: {
      ok: false,
      code: "JSON_PARSE_FAILED",
      summary: "invalid",
      fenceBody: null,
      report: null,
    },
    validation: null,
    parsedReport: null,
    reportValid: false,
    diagnosticCodes: ["JSON_PARSE_FAILED"],
    summary: "invalid",
  };
}

function validPublicationReport(input: {
  branchPushed?: boolean;
  remoteBranch?: string;
  branchTipSha?: string;
  finalExecutableSha?: string | null;
  evidenceTipSha?: string | null;
} = {}): Record<string, unknown> {
  const blocked = readJsonFile<Record<string, unknown>>(
    resolveRepoPath("fixtures", "phase2", "bellhop-blocked-source-report.json"),
  );
  const report = structuredClone(blocked);
  report.resultClass = "READY";
  report.terminalVerdict = "RADIO_PHASE3_FIXTURE_VERIFIED";
  (report.execution as Record<string, unknown>).status = "COMPLETED";
  const rs = report.repositoryState as Record<string, unknown>;
  rs.finalExecutableSha =
    input.finalExecutableSha !== undefined
      ? input.finalExecutableSha
      : FRESH_EXECUTABLE_SHA;
  rs.evidenceTipSha =
    input.evidenceTipSha !== undefined ? input.evidenceTipSha : EVIDENCE_TIP_SHA;
  rs.workingBranch = input.remoteBranch ?? REMOTE_BRANCH;
  rs.branchTipSha = input.branchTipSha ?? EVIDENCE_TIP_SHA;
  report.gitPr = {
    branchPushed: input.branchPushed ?? true,
    remoteBranch: input.remoteBranch ?? REMOTE_BRANCH,
    branchTipSha: input.branchTipSha ?? EVIDENCE_TIP_SHA,
    prCreationAllowed: false,
    prCreationRequired: false,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergeState: null,
    mergeAttempted: false,
  };
  return report;
}

function validDiagnostics(
  report: Record<string, unknown>,
): StructuredWorkerReportDiagnostics {
  return {
    status: "VALID",
    extract: {
      ok: true,
      code: "OK",
      summary: "ok",
      fenceBody: JSON.stringify(report),
      report,
    },
    validation: {
      ok: true,
      code: "REPORT_VALID",
      summary: "valid",
      reportValid: true,
      workOutcome: "READY",
      workOutcomeDetail: null,
      sourceIntegrity: "MATCHED",
      errors: [],
      report,
    },
    parsedReport: report,
    reportValid: true,
    diagnosticCodes: ["OK", "REPORT_VALID"],
    summary: "valid",
  };
}

function baselineWorkOrder(): CursorWorkOrder {
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

function workOrderWithAuthority(authority: ObjectiveAuthority): CursorWorkOrder {
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
  return buildCursorWorkOrder({
    state,
    decision,
    policy,
    objectiveAuthority: authority,
  });
}

describe("completion acceptance gate matrix", () => {
  const authority = publicationAuthority();
  const workOrder = workOrderWithAuthority(authority);

  it("A: schema-invalid report + Sol ACCEPT recommendation = NOT ACCEPTED", async () => {
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: invalidDiagnostics(),
    });
    expect(gate.ok).toBe(false);
    expect(gate.failedConditions).toContain("WORKER_REPORT_SCHEMA_INVALID");
  });

  it("B: remotePublicationRequired + branchPushed=false = NOT ACCEPTED", async () => {
    const report = validPublicationReport({ branchPushed: false });
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: validDiagnostics(report),
      resolveRemoteBranchTip: async () => EVIDENCE_TIP_SHA,
    });
    expect(gate.ok).toBe(false);
    expect(gate.failedConditions).toContain("BRANCH_PUSH_REQUIRED_BUT_FALSE");
  });

  it("C: branchPushed=true + remote branch missing = NOT ACCEPTED", async () => {
    const report = validPublicationReport();
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: validDiagnostics(report),
      resolveRemoteBranchTip: async () => {
        throw new Error("remote branch missing");
      },
    });
    expect(gate.ok).toBe(false);
    expect(gate.failedConditions).toContain("REMOTE_BRANCH_MISSING");
  });

  it("D: remote branch exists + tip mismatch = NOT ACCEPTED", async () => {
    const report = validPublicationReport();
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: validDiagnostics(report),
      resolveRemoteBranchTip: async () => "dddddddddddddddddddddddddddddddddddddddd",
    });
    expect(gate.ok).toBe(false);
    expect(gate.failedConditions).toContain("REMOTE_BRANCH_SHA_MISMATCH");
  });

  it("E: remote branch exists + exact tip = publication gate PASS", async () => {
    const report = validPublicationReport();
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: validDiagnostics(report),
      resolveRemoteBranchTip: async () => EVIDENCE_TIP_SHA,
      verifyCommitAncestry: async () => true,
      verifyRemoteCommitExists: async () => true,
    });
    expect(gate.ok).toBe(true);
  });

  it("F: freshExecutableSha == startingSha = NOT ACCEPTED", async () => {
    const report = validPublicationReport({
      finalExecutableSha: STARTING_SHA,
      evidenceTipSha: STARTING_SHA,
    });
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: validDiagnostics(report),
      resolveRemoteBranchTip: async () => STARTING_SHA,
      verifyCommitAncestry: async () => true,
    });
    expect(gate.ok).toBe(false);
    expect(gate.failedConditions).toContain("STARTING_SHA_NOT_FRESH");
  });

  it("G: fresh executable remotely verifiable = gate PASS", async () => {
    const report = validPublicationReport({
      finalExecutableSha: FRESH_EXECUTABLE_SHA,
      evidenceTipSha: EVIDENCE_TIP_SHA,
    });
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: validDiagnostics(report),
      resolveRemoteBranchTip: async () => EVIDENCE_TIP_SHA,
      verifyCommitAncestry: async () => true,
      verifyRemoteCommitExists: async () => true,
    });
    expect(gate.ok).toBe(true);
  });

  it("H: evidenceTipRequired + evidence tip missing = NOT ACCEPTED", async () => {
    const report = validPublicationReport({ evidenceTipSha: null });
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: validDiagnostics(report),
      resolveRemoteBranchTip: async () => EVIDENCE_TIP_SHA,
      verifyRemoteCommitExists: async () => true,
    });
    expect(gate.ok).toBe(false);
    expect(gate.failedConditions).toContain("EVIDENCE_TIP_MISSING");
  });

  it("I: evidence tip exact + executable ancestor verification = gate PASS", async () => {
    const report = validPublicationReport({
      finalExecutableSha: FRESH_EXECUTABLE_SHA,
      evidenceTipSha: EVIDENCE_TIP_SHA,
    });
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: validDiagnostics(report),
      resolveRemoteBranchTip: async () => EVIDENCE_TIP_SHA,
      verifyCommitAncestry: async () => true,
      verifyRemoteCommitExists: async () => true,
    });
    expect(gate.ok).toBe(true);
  });

  it("J: no publication requirements preserves existing ACCEPT behavior", async () => {
    const legacyAuthority = createDefaultFixtureObjectiveAuthority({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      stateRevisionBasis: 1,
    });
    const gate = await evaluateCompletionAcceptanceGate({
      authority: legacyAuthority,
      workOrder: baselineWorkOrder(),
      diagnostics: invalidDiagnostics(),
    });
    expect(gate.ok).toBe(true);
  });

  it("K: Sol cannot override deterministic failure (schema invalid stays blocked)", async () => {
    const gate = await evaluateCompletionAcceptanceGate({
      authority,
      workOrder,
      diagnostics: invalidDiagnostics(),
      resolveRemoteBranchTip: async () => EVIDENCE_TIP_SHA,
    });
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe("WORKER_REPORT_SCHEMA_INVALID");
  });
});

describe("ObjectiveAuthority completion contract persistence", () => {
  it("completion requirements survive identity fingerprint", () => {
    const without = createDefaultFixtureObjectiveAuthority({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      stateRevisionBasis: 1,
    });
    const withReq = publicationAuthority();
    expect(computeObjectiveAuthorityIdentity(without)).not.toBe(
      computeObjectiveAuthorityIdentity(withReq),
    );
    expect(
      buildObjectiveAuthorityIdentityMaterial(withReq).completionRequirements,
    ).toEqual(withReq.completionRequirements);
  });

  it("propagates commit/push/executable/evidence requirements into work order", () => {
    const authority = publicationAuthority();
    const workOrder = workOrderWithAuthority(authority);
    expect(workOrder.git.commitRequired).toBe(true);
    expect(workOrder.git.pushRequired).toBe(true);
    expect(workOrder.source.createWorkingBranch).toBe(true);
    expect(workOrder.verification.executableFreezeRequired).toBe(true);
    expect(workOrder.verification.evidenceTipRequired).toBe(true);
  });

  it("legacy objectives keep non-publication work-order defaults", () => {
    const workOrder = baselineWorkOrder();
    expect(workOrder.git.commitRequired).toBe(false);
    expect(workOrder.git.pushRequired).toBe(false);
    expect(workOrder.source.createWorkingBranch).toBe(false);
    expect(workOrder.verification.executableFreezeRequired).toBe(false);
    expect(workOrder.verification.evidenceTipRequired).toBe(false);
  });

  it("loads fixture objective authority with schema validation", () => {
    const authority = loadObjectiveAuthority(
      resolveRepoPath("fixtures", "phase3", "objective-authority.json"),
    );
    expect(resolveObjectiveCompletionRequirements(authority)).toEqual({
      structuredWorkerReportRequired: false,
      commitRequired: false,
      remotePublicationRequired: false,
      freshExecutableShaRequired: false,
      evidenceTipRequired: false,
    });
  });
});

describe("accept workstream gate wiring", () => {
  it("M: persisted context + schema-invalid report blocks accept for publication objectives", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const workOrder = workOrderWithAuthority(authority);
    const contextPath = path.join(dir, "completion-acceptance-context.json");
    fs.writeFileSync(
      contextPath,
      JSON.stringify(
        buildCompletionAcceptanceContextArtifact({
          workOrder,
          diagnostics: invalidDiagnostics(),
        }),
        null,
        2,
      ),
    );
    const gate = await evaluateAcceptWorkstreamGate({
      authority,
      completionContextPath: contextPath,
    });
    expect(gate.ok).toBe(false);
    expect(gate.failedConditions).toContain("WORKER_REPORT_SCHEMA_INVALID");
  });
});

describe("Phase 3 integration: ACCEPT_WORKSTREAM completion gate", () => {
  it("N: full loop blocks Sol ACCEPT_WORKSTREAM when Retry-09 completion evidence fails", async () => {
    const { runPhase3Loop } = await import("../src/runtime/phase3.js");
    const { createPhase3FixtureCursorClient } = await import(
      "../src/runtime/phase3-fixture-client.js"
    );
    const dir = tmpDir();
    const statePath = path.join(dir, "PROJECT-STATE.working.json");
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    const authorityPath = path.join(dir, "objective-authority.json");
    fs.copyFileSync(
      resolveRepoPath("fixtures", "state", "phase3-planning-seed.json"),
      statePath,
    );
    fs.writeFileSync(ledgerPath, "", "utf8");
    fs.writeFileSync(
      authorityPath,
      JSON.stringify(publicationAuthority(), null, 2),
    );
    const schemaInvalidRaw = fs.readFileSync(
      resolveRepoPath("fixtures", "phase2", "bellhop-schema-invalid-raw-result.txt"),
      "utf8",
    );
    const client = createPhase3FixtureCursorClient([{ rawResult: schemaInvalidRaw }]);
    const result = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: authorityPath,
      statePath,
      ledgerPath,
      runDir: dir,
      skipObjectiveLease: true,
      initialDecisionFixturePath: resolveRepoPath(
        "fixtures",
        "decisions",
        "phase3-initial-launch.json",
      ),
      continuationDecisionFixturePaths: [
        resolveRepoPath("fixtures", "decisions", "phase3-accept-workstream.json"),
      ],
      cursorRawResultSequence: [schemaInvalidRaw],
      cursorClient: client,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_READY_FOR_HUMAN");
    expect(result.runtimeState).toBe("READY_FOR_HUMAN");
    expect(result.stopReason).toMatch(/Completion requirements not satisfied/);
    expect(result.authority.consumed).toBe(false);
    const gateArtifacts = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("completion-acceptance-gate-iter-"));
    expect(gateArtifacts.length).toBeGreaterThan(0);
    const gate = readJsonFile<{ ok: boolean; failedConditions: string[] }>(
      path.join(dir, gateArtifacts[0]!),
    );
    expect(gate.ok).toBe(false);
    expect(gate.failedConditions).toContain("WORKER_REPORT_SCHEMA_INVALID");
  });
});

describe("Phase 3 integration: Bellhop regression", () => {
  it("L: Bellhop loop without publication requirements still reaches human gate", async () => {
    const { runPhase3Loop } = await import("../src/runtime/phase3.js");
    const { createPhase3FixtureCursorClient } = await import(
      "../src/runtime/phase3-fixture-client.js"
    );
    const dir = tmpDir();
    const statePath = path.join(dir, "PROJECT-STATE.working.json");
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    const authorityPath = path.join(dir, "objective-authority.json");
    fs.copyFileSync(
      resolveRepoPath("fixtures", "state", "phase3-planning-seed.json"),
      statePath,
    );
    fs.writeFileSync(ledgerPath, "", "utf8");
    fs.copyFileSync(
      resolveRepoPath("fixtures", "phase3", "objective-authority.json"),
      authorityPath,
    );
    const failRaw = fs.readFileSync(
      resolveRepoPath("fixtures", "phase3", "raw-result-fail.txt"),
      "utf8",
    );
    const passRaw = fs.readFileSync(
      resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
      "utf8",
    );
    const client = createPhase3FixtureCursorClient([
      { rawResult: failRaw },
      { rawResult: passRaw },
    ]);
    const result = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: "radio-phase3-fixture-01",
      transactionId: "radio-phase3-fixture-01-bounded-verify",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: authorityPath,
      statePath,
      ledgerPath,
      runDir: dir,
      initialDecisionFixturePath: resolveRepoPath(
        "fixtures",
        "decisions",
        "phase3-initial-launch.json",
      ),
      continuationDecisionFixturePaths: [
        resolveRepoPath("fixtures", "decisions", "phase3-retry-launch.json"),
        resolveRepoPath("fixtures", "decisions", "phase3-human-gate.json"),
      ],
      cursorRawResultSequence: [failRaw, passRaw],
      cursorClient: client,
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_AUTONOMOUS_LOOP_READY");
    expect(result.runtimeState).toBe("READY_FOR_HUMAN");
  });
});
