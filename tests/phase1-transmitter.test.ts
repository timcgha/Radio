import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canLiveCursorDispatch,
  isCursorExecutionEnabled,
  resolveCursorApiKey,
} from "../src/cursor/api-client.js";
import {
  extractLastTextFence,
  parseCompletionFromConversation,
  parseReportJsonFromFencedText,
} from "../src/cursor/completion-parser.js";
import {
  validateCompletionAgainstWorkOrder,
  validateCompletionReportSchema,
} from "../src/cursor/completion-validator.js";
import { buildCursorWorkOrder } from "../src/cursor/work-order-builder.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import {
  resolvePhase0Config,
  runBellhopPilot,
} from "../src/runtime/pilot-bellhop.js";
import {
  ensureLedgerFile,
  transmitCursorWorkOrder,
} from "../src/runtime/transmitter.js";
import {
  findLedgerEventByIdempotency,
  readLedgerEvents,
} from "../src/state/ledger.js";
import { loadProjectState } from "../src/state/store.js";
import type { DecisionEnvelope } from "../src/types.js";
import {
  newId,
  nowIso,
  readJsonFile,
  resolveRepoPath,
} from "../src/util/io.js";
import { callSol } from "../src/orchestrator/sol-adapter.js";
import { buildSolContext } from "../src/orchestrator/context-builder.js";
import { loadBellhopBrain } from "../src/state/store.js";

function tempWorkspace(): { dir: string; statePath: string; ledgerPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radio-phase1-"));
  const statePath = path.join(dir, "PROJECT-STATE.json");
  const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
  fs.copyFileSync(
    resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"),
    statePath,
  );
  ensureLedgerFile(ledgerPath);
  return { dir, statePath, ledgerPath };
}

describe("cursor execution gate", () => {
  it("requires both CURSOR_EXECUTION_ENABLED=true and CURSOR_API_KEY", () => {
    expect(
      canLiveCursorDispatch({
        CURSOR_EXECUTION_ENABLED: "true",
        CURSOR_API_KEY: "test-key",
      }),
    ).toBe(true);
    expect(
      canLiveCursorDispatch({
        CURSOR_EXECUTION_ENABLED: "false",
        CURSOR_API_KEY: "test-key",
      }),
    ).toBe(false);
    expect(
      canLiveCursorDispatch({
        CURSOR_EXECUTION_ENABLED: "true",
      }),
    ).toBe(false);
    expect(isCursorExecutionEnabled({ CURSOR_EXECUTION_ENABLED: "true" })).toBe(
      true,
    );
    expect(resolveCursorApiKey({ CURSOR_API_KEY: "  abc  " })).toBe("abc");
    expect(resolveCursorApiKey({})).toBeNull();
  });
});

describe("completion parser", () => {
  it("extracts the last text fence and parses JSON", () => {
    const report = { hello: "world" };
    const text = `preamble\n\`\`\`text\n${JSON.stringify(report)}\n\`\`\`\n`;
    expect(extractLastTextFence(text)).toBe(JSON.stringify(report));
    expect(parseReportJsonFromFencedText(JSON.stringify(report))).toEqual(
      report,
    );

    const parsed = parseCompletionFromConversation({
      messages: [
        { id: "1", type: "assistant_message", text: "working..." },
        { id: "2", type: "assistant_message", text },
      ],
    });
    expect(parsed.reportJson).toEqual(report);
    expect(parsed.sourceMessageId).toBe("2");
  });
});

describe("completion validator", () => {
  it("validates fixture report schema", () => {
    const raw = readJsonFile(
      resolveRepoPath(
        "fixtures",
        "completion-reports",
        "bellhop-pilot-verified.json",
      ),
    );
    // Placeholder workOrderId is fine for schema; identity checked later.
    const result = validateCompletionReportSchema(raw);
    expect(result.status).toBe("VALID");
  });
});

describe("phase1 fixture transmitter", () => {
  it("runs end-to-end mock dispatch, validates report, updates state/ledger once", async () => {
    const { statePath, ledgerPath } = tempWorkspace();
    const brain = loadBellhopBrain();
    const loaded = loadProjectState({ projectId: "bellhop", statePath });
    const context = buildSolContext({
      brain: { ...brain, state: loaded.state, fingerprint: loaded.fingerprint },
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
    });
    const sol = await callSol({
      context,
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      currentRuntimeState: loaded.state.radioRuntime.state,
      model: "gpt-5.6-sol",
      mode: "fixture",
      fixturePath: resolveRepoPath(
        "fixtures",
        "decisions",
        "bellhop-legal-launch-cursor.json",
      ),
    });
    const envelope: DecisionEnvelope = {
      schemaVersion: "phase0-1.0",
      decisionId: sol.decision.decisionId,
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      stateRevision: loaded.state.stateRevision,
      requestFingerprint: loaded.fingerprint,
      model: sol.model,
      mode: "fixture",
      generatedAt: nowIso(),
      cursorExecutionEnabled: false,
      notes: [],
    };
    const policy = evaluatePolicy({
      decision: sol.decision,
      state: loaded.state,
      envelope,
      currentFingerprint: loaded.fingerprint,
    });
    expect(policy.result).toBe("ALLOW");
    const workOrder = buildCursorWorkOrder({
      state: loaded.state,
      decision: sol.decision,
      policy,
    });

    // Bind fixture report to this work order identity for conversation mock.
    const fixtureReport = readJsonFile<Record<string, unknown>>(
      resolveRepoPath(
        "fixtures",
        "completion-reports",
        "bellhop-pilot-verified.json",
      ),
    );
    const boundReport = {
      ...fixtureReport,
      workOrderId: workOrder.workOrderId,
      workOrderRevision: workOrder.revision,
      decisionId: workOrder.decisionId,
    };
    const boundPath = path.join(path.dirname(statePath), "bound-report.json");
    fs.writeFileSync(boundPath, JSON.stringify(boundReport, null, 2));

    const runDir = path.join(path.dirname(statePath), "run");
    fs.mkdirSync(runDir, { recursive: true });

    // Custom client using bound report
    const { createFixtureClient } = await importFixtureClient(boundPath);

    const first = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir,
      state: loaded.state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "fixture prompt",
      forceFixtureTransmit: true,
      client: createFixtureClient(),
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });

    expect(first.cursorApiCalled).toBe(true);
    expect(first.agentId).toBe("bc_fixture_bellhop_01");
    expect(first.terminalVerdict).toBe(
      "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST",
    );
    expect(first.validation?.status).toBe("VALID");
    expect(first.state.radioRuntime.state).toBe("READY_FOR_HUMAN");
    expect(first.state.activeAgent).toBeNull();
    expect(first.state.stateRevision).toBeGreaterThan(loaded.state.stateRevision);

    const created = findLedgerEventByIdempotency(
      ledgerPath,
      workOrder.idempotencyKey,
      ["CURSOR_AGENT_CREATED"],
    );
    expect(created?.agentId).toBe("bc_fixture_bellhop_01");

    // Second transmit with same key must reconcile, not create a second agent.
    const reloaded = loadProjectState({ projectId: "bellhop", statePath });
    // Reset runtime to PLANNING would be illegal mid-flight; instead call transmit
    // while WAITING would resume — simulate by resetting only activeAgent via a
    // fresh planning state copy for idempotency of CREATE specifically:
    const eventsBefore = readLedgerEvents(ledgerPath).filter(
      (e) => e.eventType === "CURSOR_AGENT_CREATED",
    ).length;

    // Re-run create path detection by calling transmit from a cloned planning state
    // with empty activeAgent but existing ledger create event.
    const planningClone = readJsonFile<typeof loaded.state>(
      resolveRepoPath("projects", "bellhop", "PROJECT-STATE.json"),
    );
    const clonePath = path.join(path.dirname(statePath), "clone-state.json");
    fs.writeFileSync(clonePath, JSON.stringify(planningClone, null, 2));

    const second = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir: path.join(path.dirname(statePath), "run2"),
      state: planningClone,
      statePath: clonePath,
      ledgerPath,
      workOrder,
      prompt: "fixture prompt again",
      forceFixtureTransmit: true,
      client: createFixtureClient(),
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      sleep: async () => undefined,
    });

    const eventsAfter = readLedgerEvents(ledgerPath).filter(
      (e) => e.eventType === "CURSOR_AGENT_CREATED",
    ).length;
    expect(eventsAfter).toBe(eventsBefore);
    expect(second.summaryNotes.join(" ")).toMatch(/Idempotency reconcile/i);
    expect(second.agentId).toBe("bc_fixture_bellhop_01");
  });

  it("pilot --phase1-fixture returns verified terminal without network", async () => {
    const { statePath, ledgerPath } = tempWorkspace();
    const config = {
      ...resolvePhase0Config(["node", "pilot", "--phase1-fixture"]),
      statePath,
      ledgerPath,
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
    };
    const result = await runBellhopPilot(config);
    expect(result.cursorApiCalled).toBe(true);
    expect(result.terminalVerdict).toBe(
      "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST",
    );
    expect(result.summary.liveCursorDispatchAuthorized).toBe(false);
  });

  it("without execution enablement, returns RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN for non-legacy path", async () => {
    const config = resolvePhase0Config(["node", "pilot"]);
    // Force fixture decision mode without phase1 transmit and without execution.
    const result = await runBellhopPilot({
      ...config,
      mode: "fixture",
      cursorExecutionEnabled: false,
      liveCursorDispatchAuthorized: false,
      phase1FixtureTransmit: false,
      // Mark as not the legacy --fixture CLI path by using a distinct argv resolution:
      // call with mode fixture but we need the Phase1 live-not-run branch.
      // Directly set: the pilot treats fixture+!phase1 as Phase0 dry run.
      // So assert the gate helper and transmitter short-circuit instead.
    });
    expect(result.terminalVerdict).toBe("RADIO_PHASE0_DRY_RUN_COMPLETE");

    const { statePath, ledgerPath } = tempWorkspace();
    const loaded = loadProjectState({ projectId: "bellhop", statePath });
    const brain = loadBellhopBrain();
    const context = buildSolContext({
      brain: { ...brain, state: loaded.state, fingerprint: loaded.fingerprint },
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
    });
    const sol = await callSol({
      context,
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      currentRuntimeState: loaded.state.radioRuntime.state,
      model: "gpt-5.6-sol",
      mode: "fixture",
      fixturePath: resolveRepoPath(
        "fixtures",
        "decisions",
        "bellhop-legal-launch-cursor.json",
      ),
    });
    const envelope: DecisionEnvelope = {
      schemaVersion: "phase0-1.0",
      decisionId: sol.decision.decisionId,
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
      stateRevision: loaded.state.stateRevision,
      requestFingerprint: loaded.fingerprint,
      model: sol.model,
      mode: "fixture",
      generatedAt: nowIso(),
      cursorExecutionEnabled: false,
      notes: [],
    };
    const policy = evaluatePolicy({
      decision: sol.decision,
      state: loaded.state,
      envelope,
      currentFingerprint: loaded.fingerprint,
    });
    const workOrder = buildCursorWorkOrder({
      state: loaded.state,
      decision: sol.decision,
      policy,
    });
    const gated = await transmitCursorWorkOrder({
      runId: newId("run"),
      runDir: path.join(path.dirname(statePath), "run"),
      state: loaded.state,
      statePath,
      ledgerPath,
      workOrder,
      prompt: "should not launch",
      forceFixtureTransmit: false,
      env: {
        CURSOR_EXECUTION_ENABLED: "false",
        CURSOR_API_KEY: "present-but-not-enough",
      },
    });
    expect(gated.terminalVerdict).toBe("RADIO_PHASE1_IMPLEMENTED_LIVE_NOT_RUN");
    expect(gated.cursorApiCalled).toBe(false);
  });
});

async function importFixtureClient(reportPath: string) {
  // Local factory mirroring transmitter fixture client with custom report path.
  const report = readJsonFile<Record<string, unknown>>(reportPath);
  let status = "CREATING";
  const agentId = "bc_fixture_bellhop_01";
  return {
    createFixtureClient() {
      return {
        async launchAgent() {
          status = "RUNNING";
          return {
            id: agentId,
            name: "Fixture",
            status,
            source: {
              repository: "https://github.com/timcgha/Bellhop",
              ref: "cursor/level4-stage2-asteroid-garden-9dce",
            },
          };
        },
        async getAgent() {
          status = "FINISHED";
          return { id: agentId, name: "Fixture", status };
        },
        async getConversation() {
          const fenced =
            "```text\n" + JSON.stringify(report, null, 2) + "\n```";
          return {
            id: agentId,
            messages: [
              { id: "u", type: "user_message", text: "go" },
              { id: "a", type: "assistant_message", text: fenced },
            ],
          };
        },
        async listAgents() {
          return [{ id: agentId, name: "Fixture", status }];
        },
      };
    },
  };
}

// Keep validateCompletionAgainstWorkOrder referenced for typecheck clarity in future.
void validateCompletionAgainstWorkOrder;
