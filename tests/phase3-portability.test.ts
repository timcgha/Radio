import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPhase3InitialContext } from "../src/orchestrator/phase3-initial-context.js";
import { buildContinuationContext } from "../src/orchestrator/continuation-context.js";
import {
  contextContainsForeignProjectLeak,
  assertProjectContextIsolation,
} from "../src/orchestrator/context-isolation.js";
import {
  buildSolContext,
  contextContainsCyberAssuranceLeak,
} from "../src/orchestrator/context-builder.js";
import { createPhase3FixtureCursorClient } from "../src/runtime/phase3-fixture-client.js";
import {
  cyberAssurancePhase3ObjectivePath,
  cyberAssurancePhase3PlanningSeedPath,
  runCyberAssurancePhase3Fixture,
} from "../src/runtime/pilot-cyber-assurance.js";
import { runPhase3Loop } from "../src/runtime/phase3.js";
import {
  loadObjectiveAuthority,
  persistObjectiveAuthority,
} from "../src/runtime/objective-authority.js";
import {
  loadBellhopBrain,
  loadProjectBrain,
  loadProjectState,
} from "../src/state/store.js";
import { resolveRepoPath } from "../src/util/io.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-phase3-portability-"));
}

function passRaw(): string {
  return fs.readFileSync(
    resolveRepoPath("fixtures", "phase3", "raw-result-pass.txt"),
    "utf8",
  );
}

describe("Phase 3 multi-project portability", () => {
  it("validates canonical Bellhop project state", () => {
    const loaded = loadProjectState({ projectId: "bellhop" });
    expect(loaded.state.project.id).toBe("bellhop");
    expect(loaded.state.stateRevision).toBeGreaterThan(0);
  });

  it("validates canonical Cyber Assurance project state", () => {
    const loaded = loadProjectState({ projectId: "cyber-assurance" });
    expect(loaded.state.project.id).toBe("cyber-assurance");
    expect(loaded.state.stateRevision).toBeGreaterThan(0);
    expect(loaded.state.budgets.maxCursorAgentsPerTransaction).toBeGreaterThan(0);
  });

  it("rejects malformed generic core state (missing stateRevision)", () => {
    const dir = tmpDir();
    const badPath = path.join(dir, "bad-state.json");
    const good = loadProjectState({ projectId: "bellhop" }).state;
    const malformed = { ...good };
    delete (malformed as { stateRevision?: number }).stateRevision;
    fs.writeFileSync(badPath, JSON.stringify(malformed), "utf8");
    expect(() =>
      loadProjectState({ projectId: "bellhop", statePath: badPath }),
    ).toThrow(/schema validation failed/i);
  });

  it("allows Cyber Assurance state without Bellhop-only historicalAcceptance fields", () => {
    const loaded = loadProjectState({
      projectId: "cyber-assurance",
      statePath: cyberAssurancePhase3PlanningSeedPath(),
    });
    expect(loaded.state.historicalAcceptance).not.toHaveProperty("level4Stage2Baseline");
    expect(loaded.state.project.id).toBe("cyber-assurance");
  });

  it("allows Bellhop state without Cyber-Assurance-only deferred backlog items", () => {
    const loaded = loadProjectState({ projectId: "bellhop" });
    const deferredIds = loaded.state.deferredItems.map((d) => d.id);
    expect(deferredIds.some((id) => id.startsWith("DEF-00"))).toBe(false);
    expect(deferredIds.some((id) => id.startsWith("DEF-B-"))).toBe(true);
  });

  it("isolates Bellhop Phase 3 initial context from Cyber Assurance", () => {
    const bellhop = loadProjectBrain("bellhop");
    const authority = loadObjectiveAuthority(
      resolveRepoPath("fixtures", "phase3", "stage3-objective-authority.json"),
    );
    const context = buildPhase3InitialContext({
      brain: bellhop,
      authority,
      projectId: "bellhop",
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
    });
    expect(context.user.toLowerCase()).toContain("bellhop");
    expect(contextContainsForeignProjectLeak(context, "bellhop")).toBe(false);
    expect(contextContainsCyberAssuranceLeak(context)).toBe(false);
  });

  it("isolates Cyber Assurance Phase 3 initial context from Bellhop", () => {
    const ca = loadProjectBrain("cyber-assurance");
    const authority = loadObjectiveAuthority(cyberAssurancePhase3ObjectivePath());
    const context = buildPhase3InitialContext({
      brain: {
        ...ca,
        state: loadProjectState({
          projectId: "cyber-assurance",
          statePath: cyberAssurancePhase3PlanningSeedPath(),
        }).state,
        fingerprint: loadProjectState({
          projectId: "cyber-assurance",
          statePath: cyberAssurancePhase3PlanningSeedPath(),
        }).fingerprint,
      },
      authority,
      projectId: "cyber-assurance",
      workstreamId: authority.workstreamId,
      transactionId: authority.transactionId,
    });
    expect(context.user.toLowerCase()).toContain("cyber assurance");
    expect(context.user).toContain("9767444943737695ba2379802a77254c8bdc0f4f");
    expect(contextContainsForeignProjectLeak(context, "cyber-assurance")).toBe(
      false,
    );
    expect(context.user.toLowerCase()).not.toContain("bellhop");
    expect(context.user.toLowerCase()).not.toContain("asteroid garden");
  });

  it("runs Cyber Assurance through the standard Phase 3 loop to READY_FOR_HUMAN", async () => {
    const dir = tmpDir();
    const statePath = path.join(dir, "PROJECT-STATE.working.json");
    const ledgerPath = path.join(dir, "RUN-LEDGER.jsonl");
    const authorityPath = path.join(dir, "objective-authority.json");
    fs.copyFileSync(cyberAssurancePhase3PlanningSeedPath(), statePath);
    fs.writeFileSync(ledgerPath, "", "utf8");
    persistObjectiveAuthority(
      authorityPath,
      loadObjectiveAuthority(cyberAssurancePhase3ObjectivePath()),
    );

    const client = createPhase3FixtureCursorClient([{ rawResult: passRaw() }]);
    const result = await runPhase3Loop({
      projectId: "cyber-assurance",
      workstreamId: "ca-phase3-fixture-01",
      transactionId: "ca-phase3-fixture-01-program-recovery",
      model: "gpt-5.6-sol",
      mode: "fixture",
      objectiveAuthorityPath: authorityPath,
      statePath,
      ledgerPath,
      runDir: dir,
      initialDecisionFixturePath: resolveRepoPath(
        "fixtures",
        "decisions",
        "cyber-assurance-phase3-initial-launch.json",
      ),
      continuationDecisionFixturePaths: [
        resolveRepoPath(
          "fixtures",
          "decisions",
          "cyber-assurance-phase3-human-gate.json",
        ),
      ],
      cursorRawResultSequence: [passRaw()],
      cursorClient: client,
    });

    expect(result.runtimeState).toBe("READY_FOR_HUMAN");
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_READY_FOR_HUMAN");
    expect(result.cursorExecutionCount).toBe(1);
    expect(result.solDecisionCount).toBe(2);
    expect(result.state.project.id).toBe("cyber-assurance");
    expect(client.logicalLaunchCount).toBe(1);
    const workOrder = JSON.parse(
      fs.readFileSync(path.join(dir, "work-order-iter-1.json"), "utf8"),
    );
    expect(workOrder.projectId).toBe("cyber-assurance");
    expect(workOrder.source.repository).toBe(
      "https://github.com/timcgha/Cyber-assurance-demo",
    );
  });

  it("pilot Cyber Assurance Phase 3 fixture script reaches READY_FOR_HUMAN", async () => {
    const result = await runCyberAssurancePhase3Fixture();
    expect(result.runtimeState).toBe("READY_FOR_HUMAN");
    expect(result.terminalVerdict).toBe("RADIO_PHASE3_READY_FOR_HUMAN");
  });

  it("keeps Bellhop Phase 0 context isolated from Cyber Assurance", () => {
    const brain = loadBellhopBrain();
    const context = buildSolContext({
      brain,
      projectId: "bellhop",
      workstreamId: "radio-pilot-01",
      transactionId: "bellhop-radio-pilot-01-stage2-verification",
    });
    expect(contextContainsCyberAssuranceLeak(context)).toBe(false);
  });
});
