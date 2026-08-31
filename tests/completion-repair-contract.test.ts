import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMinimalValidReportSkeleton,
  buildMachineReadableCompletionContract,
} from "../src/cursor/completion-contract.js";
import {
  buildCompletionReportRepairContract,
  deriveAllowedEnumValuesForInstancePath,
  getCompletionReportSchemaErrors,
  normalizeCompletionReportValidationErrors,
} from "../src/cursor/completion-repair-contract.js";
import { extractCompletionReport } from "../src/cursor/completion-parser.js";
import { validateCompletionReport } from "../src/cursor/completion-validator.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { createDefaultFixtureObjectiveAuthority } from "../src/runtime/objective-authority.js";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import { phase3PlanningSeedPath, runPhase3Loop } from "../src/runtime/phase3.js";
import {
  attemptBoundedReportRepair,
  MAX_REPORT_REPAIR_ATTEMPTS,
} from "../src/runtime/report-repair.js";
import { loadProjectState } from "../src/state/store.js";
import type {
  CursorWorkOrder,
  DecisionEnvelope,
  ObjectiveAuthority,
  OrchestratorDecision,
} from "../src/types.js";
import {
  getSchemaValidator,
  loadSchema,
  readJsonFile,
  resolveRepoPath,
} from "../src/util/io.js";

const STARTING_SHA = "aa512d6ef721f855be33ddc36da490f9de66dc23";
const FRESH_EXECUTABLE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVIDENCE_TIP_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const REMOTE_BRANCH = "cursor/candy-shell-proximity-boundary-regression-3af7";
const RUN1_AGENT_ID = "bc-26d3e0d7-aabd-45ca-ba5c-46aaaa7122bd";

const CANONICAL_TEST_CATEGORY_ENUM = [
  "FOCUSED",
  "DOMAIN",
  "FULL",
  "TYPECHECK",
  "LINT",
  "BUILD",
  "PROVENANCE",
  "POLICY_SELF_CHECK",
  "OTHER",
];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-repair-contract-"));
}

function fenceJson(report: Record<string, unknown>): string {
  return `\`\`\`text\n${JSON.stringify(report, null, 2)}\n\`\`\``;
}

function publicationAuthority(): ObjectiveAuthority {
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

function run1InvalidCategoryReport(
  workOrder: CursorWorkOrder,
  agentId = RUN1_AGENT_ID,
): Record<string, unknown> {
  const blocked = readJsonFile<Record<string, unknown>>(
    resolveRepoPath("fixtures", "phase2", "bellhop-blocked-source-report.json"),
  );
  const report = structuredClone(blocked);
  report.workOrderId = workOrder.workOrderId;
  report.workOrderRevision = workOrder.revision;
  report.projectId = workOrder.projectId;
  report.workstreamId = workOrder.workstreamId;
  report.transactionId = workOrder.transactionId;
  report.decisionId = workOrder.decisionId;
  (report.execution as Record<string, unknown>).agentAction = workOrder.agentAction;
  (report.execution as Record<string, unknown>).workType = workOrder.workType;
  (report.execution as Record<string, unknown>).status = "COMPLETED";
  const ordinary = (report.execution as Record<string, unknown>)
    .ordinaryAgent as Record<string, unknown>;
  ordinary.agentId = agentId;
  ordinary.status = "COMPLETED";
  ordinary.verdict = "RADIO_PHASE3_FIXTURE_VERIFIED";

  const rs = report.repositoryState as Record<string, unknown>;
  rs.repository = workOrder.source.repository;
  rs.canonicalMainBranch = workOrder.source.canonicalMainBranch;
  rs.expectedCanonicalMainSha = workOrder.source.canonicalMainSha;
  rs.baseBranch = workOrder.source.baseBranch;
  rs.expectedBaseTipSha = workOrder.source.expectedBaseTipSha;
  rs.sourcePinsMatched = true;
  rs.observedBaseTipSha = rs.expectedBaseTipSha ?? STARTING_SHA;
  rs.observedCanonicalMainSha = rs.expectedCanonicalMainSha;
  rs.startingWorkingSha = rs.expectedBaseTipSha ?? STARTING_SHA;
  rs.finalExecutableSha = FRESH_EXECUTABLE_SHA;
  rs.evidenceTipSha = EVIDENCE_TIP_SHA;
  rs.workingBranch = REMOTE_BRANCH;
  rs.branchTipSha = rs.expectedBaseTipSha ?? STARTING_SHA;

  report.resultClass = "READY";
  report.terminalVerdict = "RADIO_PHASE3_FIXTURE_VERIFIED";
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
      category: "VERIFICATION",
      command: "node tests/run.js",
      result: "PASS",
      exitCode: 0,
      passed: 1775,
      failed: 0,
      skipped: 0,
      warnings: [],
      evidenceRef: "tests",
    },
    {
      name: "npm run build",
      category: "BUILD",
      command: "npm run build",
      result: "PASS",
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      warnings: [],
      evidenceRef: "build",
    },
    {
      name: "git status",
      category: "REPOSITORY",
      command: "git status --porcelain",
      result: "PASS",
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      warnings: [],
      evidenceRef: null,
    },
  ];
  report.remediation = {
    budget: workOrder.budgets.maxRemediationPasses ?? 0,
    passesUsed: 0,
    exhausted: (workOrder.budgets.maxRemediationPasses ?? 0) === 0,
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
  report.summary =
    "Implementation complete. 1775 tests passed. Build passed. Branch pushed. No product behavior changed.";
  report.recommendedNextAction = {
    kind: "NONE",
    summary: "No further action required.",
    requiresHumanApproval: false,
  };
  return report;
}

function applyRun1CategoryRepair(report: Record<string, unknown>): Record<string, unknown> {
  const fixed = structuredClone(report);
  const tests = fixed.testResults as Array<Record<string, unknown>>;
  tests[0]!.category = "FOCUSED";
  tests[2]!.category = "OTHER";
  return fixed;
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

function extractRepairContractFromPrompt(promptText: string): Record<string, unknown> {
  const marker = "MACHINE-READABLE REPAIR CONTRACT (authoritative):";
  const start = promptText.indexOf(marker);
  const fenceStart = promptText.indexOf("```json", start);
  const jsonStart = promptText.indexOf("\n", fenceStart) + 1;
  const fenceEnd = promptText.indexOf("```", jsonStart);
  return JSON.parse(promptText.slice(jsonStart, fenceEnd).trim()) as Record<string, unknown>;
}

describe("completion repair contract — error normalization", () => {
  it("ENUM_ERROR_NORMALIZED with instancePath, receivedValue, allowedValues", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const report = run1InvalidCategoryReport(workOrder);
    const ajvErrors = getCompletionReportSchemaErrors(report);
    expect(ajvErrors.length).toBeGreaterThanOrEqual(2);

    const contract = buildCompletionReportRepairContract({ report, workOrder });
    expect(contract.validationErrors.length).toBeGreaterThanOrEqual(2);

    const cat0 = contract.validationErrors.find(
      (e) => e.instancePath === "/testResults/0/category",
    );
    const cat2 = contract.validationErrors.find(
      (e) => e.instancePath === "/testResults/2/category",
    );
    expect(cat0).toBeDefined();
    expect(cat2).toBeDefined();
    expect(cat0!.keyword).toBe("enum");
    expect(cat0!.receivedValue).toBe("VERIFICATION");
    expect(cat2!.receivedValue).toBe("REPOSITORY");
    expect(cat0!.allowedValues).toEqual(CANONICAL_TEST_CATEGORY_ENUM);
    expect(cat2!.allowedValues).toEqual(CANONICAL_TEST_CATEGORY_ENUM);
    expect(cat0!.repairInstruction).toContain("FIELD: /testResults/0/category");
    expect(cat0!.repairInstruction).toContain("RECEIVED: VERIFICATION");
    expect(cat0!.repairInstruction).toContain("ALLOWED:");
    expect(cat0!.repairInstruction).toContain("OTHER");
  });

  it("MULTI_ERROR_SINGLE_ATTEMPT includes all enum failures", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const report = run1InvalidCategoryReport(workOrder);
    const contract = buildCompletionReportRepairContract({ report, workOrder });
    const enumErrors = contract.validationErrors.filter((e) => e.keyword === "enum");
    expect(enumErrors.map((e) => e.instancePath).sort()).toEqual([
      "/testResults/0/category",
      "/testResults/2/category",
    ]);
  });

  it("REQUIRED_ERROR_NORMALIZED", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const report = run1InvalidCategoryReport(workOrder);
    delete report.reportId;
    const normalized = normalizeCompletionReportValidationErrors(
      report,
      getCompletionReportSchemaErrors(report),
    );
    const req = normalized.find((e) => e.keyword === "required");
    expect(req).toBeDefined();
    expect(req!.missingProperties).toContain("reportId");
    expect(req!.repairInstruction).toContain("MISSING: reportId");
  });

  it("ADDITIONAL_PROPERTY_ERROR_NORMALIZED", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const report = run1InvalidCategoryReport(workOrder);
    (report as Record<string, unknown>).extraField = true;
    const normalized = normalizeCompletionReportValidationErrors(
      report,
      getCompletionReportSchemaErrors(report),
    );
    const add = normalized.find((e) => e.keyword === "additionalProperties");
    expect(add).toBeDefined();
    expect(add!.additionalProperty).toBe("extraField");
    expect(add!.repairInstruction).toContain("ILLEGAL_PROPERTY: extraField");
  });

  it("TYPE_ERROR_NORMALIZED", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const report = run1InvalidCategoryReport(workOrder);
    report.workOrderRevision = "not-an-integer" as unknown as number;
    const normalized = normalizeCompletionReportValidationErrors(
      report,
      getCompletionReportSchemaErrors(report),
    );
    const typeErr = normalized.find((e) => e.keyword === "type");
    expect(typeErr).toBeDefined();
    expect(typeErr!.expectedType).toBe("integer");
    expect(typeErr!.repairInstruction).toContain("EXPECTED_TYPE: integer");
  });
});

describe("completion repair contract — enum guidance from schema", () => {
  it("ENUM_GUIDANCE_SCHEMA_DRIFT_TEST: allowed values derived from canonical schema", () => {
    const schema = loadSchema("cursor-completion-report.schema.json") as {
      properties: {
        testResults: {
          items: { properties: { category: { enum: string[] } } };
        };
      };
    };
    const schemaEnum =
      schema.properties.testResults.items.properties.category.enum;
    const derived = deriveAllowedEnumValuesForInstancePath("/testResults/0/category");
    expect(derived).toEqual(schemaEnum);
    expect(derived).toEqual(CANONICAL_TEST_CATEGORY_ENUM);
  });

  it("repair contract allowedValues match schema not hand-written constants", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const report = run1InvalidCategoryReport(workOrder);
    const contract = buildCompletionReportRepairContract({ report, workOrder });
    for (const err of contract.validationErrors) {
      if (err.keyword !== "enum") continue;
      const fromSchema = deriveAllowedEnumValuesForInstancePath(err.instancePath);
      expect(err.allowedValues).toEqual(fromSchema);
    }
  });
});

describe("completion repair contract — OTHER fallback scope", () => {
  it("TEST_CATEGORY_OTHER_FALLBACK_SUPPORTED for testResults.category", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const report = run1InvalidCategoryReport(workOrder);
    const contract = buildCompletionReportRepairContract({ report, workOrder });
    const cat0 = contract.validationErrors.find(
      (e) => e.instancePath === "/testResults/0/category",
    );
    expect(cat0!.repairInstruction).toContain(
      "If none of the legal categories accurately matches the existing result, use OTHER.",
    );
  });

  it("OTHER_FALLBACK_SCOPE_LIMITED: browser verdict enum does not suggest OTHER coercion", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const report = run1InvalidCategoryReport(workOrder);
    (report.browserVerification as Record<string, unknown>).verdict =
      "INVALID_VERDICT";
    const contract = buildCompletionReportRepairContract({ report, workOrder });
    const verdictErr = contract.validationErrors.find(
      (e) => e.instancePath === "/browserVerification/verdict",
    );
    expect(verdictErr).toBeDefined();
    expect(verdictErr!.repairInstruction).not.toContain(
      "If none of the legal categories accurately matches the existing result, use OTHER.",
    );
  });
});

describe("Run-1 Bellhop operational acceptance regression fixture", () => {
  it("RUN1_FAILURE_REPRODUCED: invalid categories fail schema validation", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const report = run1InvalidCategoryReport(workOrder);
    const validate = getSchemaValidator("cursor-completion-report.schema.json");
    expect(validate(report)).toBe(false);
    const errors = getCompletionReportSchemaErrors(report);
    expect(errors.some((e) => e.instancePath === "/testResults/0/category")).toBe(true);
    expect(errors.some((e) => e.instancePath === "/testResults/2/category")).toBe(true);
  });

  it("RUN1_VERIFICATION_CATEGORY_REPAIR_TEST and RUN1_REPOSITORY_CATEGORY_REPAIR_TEST", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const invalid = run1InvalidCategoryReport(workOrder);
    const contract = buildCompletionReportRepairContract({
      report: invalid,
      workOrder,
      identity: { plannedAgentId: RUN1_AGENT_ID },
    });

    expect(contract.schemaHash).toBe(
      buildMachineReadableCompletionContract(workOrder, {
        plannedAgentId: RUN1_AGENT_ID,
      }).schemaHash,
    );

    const fixed = applyRun1CategoryRepair(invalid);
    const validate = getSchemaValidator("cursor-completion-report.schema.json");
    expect(validate(fixed)).toBe(true);

    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const binding = validateCompletionReport(fixed, {
      state,
      workOrder,
      expectedAgentId: RUN1_AGENT_ID,
    });
    expect(binding.ok).toBe(true);
  });

  it("fixture file matches Run-1 invalid category shape", () => {
    const fixtureRaw = fs.readFileSync(
      resolveRepoPath(
        "fixtures",
        "operational-mvp",
        "run1-invalid-category-raw-result.txt",
      ),
      "utf8",
    );
    const extracted = extractCompletionReport(fixtureRaw);
    expect(extracted.ok).toBe(true);
    const tests = (extracted.report!.testResults as Array<Record<string, unknown>>);
    expect(tests[0]!.category).toBe("VERIFICATION");
    expect(tests[2]!.category).toBe("REPOSITORY");
  });
});

describe("report repair — enum hardening", () => {
  it("same-agent repair succeeds when worker applies repair contract categories", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const workOrder = baselineWorkOrder(authority);
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const agentId = "bc-op-mvp-repair-001";
    const invalidReport = run1InvalidCategoryReport(workOrder, agentId);
    const invalidRaw = fenceJson(invalidReport);
    const fixedRaw = fenceJson(applyRun1CategoryRepair(invalidReport));

    const client = createPhase3FixtureCursorClient([
      {
        rawResult: invalidRaw,
        agentId,
        followUpResults: [fixedRaw],
      },
    ]);
    await client.createAgent({
      prompt: { text: "implementation" },
      agentId,
      repos: [{ url: "https://github.com/timcgha/Bellhop" }],
    });

    const repair = await attemptBoundedReportRepair({
      agentId,
      runId: "run-a10923fe-9bb1-451a-9685-874b53eefcef",
      workOrder,
      state,
      rawResultText: invalidRaw,
      structuredWorkerReportRequired: true,
      client,
      repairRunDir: path.join(dir, "repair"),
      pollIntervalMs: 1,
      pollMaxAttempts: 3,
    });

    expect(repair.ok).toBe(true);
    expect(repair.code).toBe("REPAIR_SUCCEEDED");
    expect(repair.attempts).toBe(1);
    expect(repair.sameAgentUsed).toBe(true);
    expect(repair.newImplementationAgentCreated).toBe(false);
    expect(repair.remediationBudgetConsumed).toBe(false);

    const promptPath = repair.artifactPaths.reportRepairPrompt1!;
    const promptText = fs.readFileSync(promptPath, "utf8");
    expect(promptText).toContain("MACHINE-READABLE REPAIR CONTRACT");
    expect(promptText).toContain("/testResults/0/category");
    expect(promptText).toContain("/testResults/2/category");
    expect(promptText).toContain("Before returning, compare every enum-valued field");

    const contract = extractRepairContractFromPrompt(promptText);
    const errors = contract.validationErrors as Array<Record<string, unknown>>;
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("ILLEGAL_ENUM_SURVIVES_REPAIR_BLOCKED: repeated illegal enum exhausts repair", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const workOrder = baselineWorkOrder(authority);
    const { state } = loadProjectState({
      projectId: "bellhop",
      statePath: phase3PlanningSeedPath(),
    });
    const invalidRaw = fenceJson(run1InvalidCategoryReport(workOrder));
    const client = createPhase3FixtureCursorClient([
      {
        rawResult: invalidRaw,
        agentId: RUN1_AGENT_ID,
        followUpResults: [invalidRaw, invalidRaw],
      },
    ]);
    await client.createAgent({
      prompt: { text: "implementation" },
      agentId: RUN1_AGENT_ID,
      repos: [{ url: "https://github.com/timcgha/Bellhop" }],
    });

    const repair = await attemptBoundedReportRepair({
      agentId: RUN1_AGENT_ID,
      runId: "run-exhaust",
      workOrder,
      state,
      rawResultText: invalidRaw,
      structuredWorkerReportRequired: true,
      client,
      repairRunDir: path.join(dir, "repair"),
      pollIntervalMs: 1,
      pollMaxAttempts: 3,
    });

    expect(repair.ok).toBe(false);
    expect(repair.code).toBe("WORKER_REPORT_SCHEMA_REPAIR_EXHAUSTED");
    expect(repair.attempts).toBe(MAX_REPORT_REPAIR_ATTEMPTS);
    expect(repair.reportValid).toBe(false);
  });
});

describe("Run-1 full flow regression", () => {
  it("invalid categories only → repair → ACCEPTED with zero human relay", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const workOrder = baselineWorkOrder(authority);
    const invalidReport = run1InvalidCategoryReport(workOrder, "<<FIXTURE_AGENT_ID>>");
    const invalidRaw = fenceJson(invalidReport);

    const statePath = path.join(dir, "PROJECT-STATE.working.json");
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    const authorityPath = path.join(dir, "objective-authority.json");
    fs.copyFileSync(phase3PlanningSeedPath(), statePath);
    fs.writeFileSync(ledgerPath, "", "utf8");
    fs.writeFileSync(authorityPath, JSON.stringify(authority, null, 2));

    const client = createPhase3FixtureCursorClient([
      {
        rawResult: invalidRaw,
        followUpBuilders: [
          ({ agentId, promptText }) => {
            const contract = extractRepairContractFromPrompt(promptText);
            expect(contract.validationErrors).toBeDefined();
            const runtimeWorkOrder = workOrderFromRepairPrompt(promptText);
            return fenceJson(
              applyRun1CategoryRepair(run1InvalidCategoryReport(runtimeWorkOrder, agentId)),
            );
          },
        ],
      },
    ]);

    const result = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
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
    expect(result.operationalTelemetry.IMPLEMENTATION_WORKERS_CREATED).toBe(1);
    expect(result.operationalTelemetry.REPORT_REPAIR_ATTEMPTS).toBe(1);
    expect(result.operationalTelemetry.SAME_WORKER_REPORT_REPAIR_USED).toBe(true);
  });

  it("REPAIR_EXHAUSTION_REGRESSION: illegal enum twice → repair exhausted", async () => {
    const dir = tmpDir();
    const authority = publicationAuthority();
    const invalidRaw = fs.readFileSync(
      resolveRepoPath(
        "fixtures",
        "operational-mvp",
        "run1-invalid-category-raw-result.txt",
      ),
      "utf8",
    );
    const statePath = path.join(dir, "PROJECT-STATE.working.json");
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    const authorityPath = path.join(dir, "objective-authority.json");
    fs.copyFileSync(phase3PlanningSeedPath(), statePath);
    fs.writeFileSync(ledgerPath, "", "utf8");
    fs.writeFileSync(authorityPath, JSON.stringify(authority, null, 2));

    const client = createPhase3FixtureCursorClient([
      {
        rawResult: invalidRaw,
        followUpResults: [invalidRaw, invalidRaw],
      },
    ]);

    const result = await runPhase3Loop({
      projectId: "bellhop",
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
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
      cursorClient: client,
    });

    expect(result.terminalVerdict).toBe("RADIO_PHASE3_WORKER_REPORT_REPAIR_EXHAUSTED");
    expect(result.runtimeState).not.toBe("ACCEPTED");
  });
});

describe("minimal valid template enum canonicality", () => {
  it("MINIMAL_TEMPLATE_VALIDATES and uses canonical enums only", () => {
    const workOrder = baselineWorkOrder(publicationAuthority());
    const skeleton = buildMinimalValidReportSkeleton(workOrder, {
      plannedAgentId: RUN1_AGENT_ID,
    });
    skeleton.testResults = [
      {
        name: "example",
        category: "FOCUSED",
        command: "npm test",
        result: "PASS",
        exitCode: 0,
        passed: 1,
        failed: 0,
        skipped: 0,
        warnings: [],
        evidenceRef: null,
      },
    ];
    skeleton.recommendedNextAction = {
      kind: "NONE",
      summary: "No further action.",
      requiresHumanApproval: false,
    };
    const validate = getSchemaValidator("cursor-completion-report.schema.json");
    expect(validate(skeleton)).toBe(true);

    const bv = skeleton.browserVerification as Record<string, unknown>;
    expect(bv.verdict).toBe("NOT_REQUIRED");
    expect(bv.method).toBeNull();
    const rna = skeleton.recommendedNextAction as Record<string, unknown>;
    expect(rna.kind).toBe("NONE");
  });
});
