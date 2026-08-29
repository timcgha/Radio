import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolvePhase0Config,
  runBellhopPilot,
} from "../src/runtime/pilot-bellhop.js";
import { resolveRepoPath } from "../src/util/io.js";

describe("dry run", () => {
  it("fixture mode runs full pipeline without OpenAI and without Cursor adapter", async () => {
    const config = resolvePhase0Config(["node", "pilot", "--fixture"]);
    expect(config.mode).toBe("fixture");

    const result = await runBellhopPilot(config);

    expect(result.decision.decision).toBe("LAUNCH_CURSOR");
    expect(result.policy.result).toBe("ALLOW");
    expect(result.workOrder).not.toBeNull();
    expect(result.cursorPrompt).toBeTruthy();
    expect(result.terminalVerdict).toBe("RADIO_PHASE0_DRY_RUN_COMPLETE");

    expect(fs.existsSync(result.artifacts.paths.decision)).toBe(true);
    expect(fs.existsSync(result.artifacts.paths.policyEvaluation)).toBe(true);
    expect(result.artifacts.paths.workOrder).toBeTruthy();
    expect(result.artifacts.paths.cursorPrompt).toBeTruthy();

    // No Cursor adapter capable of external execution exists in Phase 0.
    const cursorDir = resolveRepoPath("src", "cursor");
    const cursorFiles = fs.readdirSync(cursorDir);
    expect(cursorFiles.sort()).toEqual([
      "prompt-renderer.ts",
      "work-order-builder.ts",
    ]);
    for (const file of cursorFiles) {
      const src = fs.readFileSync(path.join(cursorDir, file), "utf8");
      expect(src.toLowerCase()).not.toMatch(/cursor\.com\/api/);
      expect(src).not.toMatch(/launchAgent|createAgent|pollAgent/i);
    }

    // Bellhop product repository is not mutated by Radio Phase 0.
    expect(result.workOrder!.git.commitRequired).toBe(false);
    expect(result.workOrder!.pr.mergeAllowed).toBe(false);
  });
});

describe("repository cleanup", () => {
  it("keeps canonical layout and leaves cyber-assurance untouched", () => {
    const required = [
      "docs/CURSOR-COMPLETION-REPORT-CONTRACT.md",
      "docs/CURSOR-WORK-ORDER-CONTRACT.md",
      "docs/ORCHESTRATION-LOOP-CONTRACT.md",
      "docs/ORCHESTRATOR-CONTEXT.md",
      "docs/POLICY-ENGINE-CONTRACT.md",
      "schemas/cursor-completion-report.schema.json",
      "schemas/cursor-work-order.schema.json",
      "schemas/decision.schema.json",
      "schemas/policy-evaluation.schema.json",
      "schemas/project-state.schema.json",
      "schemas/run-ledger-event.schema.json",
      "projects/bellhop/DECISION-LOG.md",
      "projects/bellhop/DEFERRED-BACKLOG.md",
      "projects/bellhop/PILOT-ACCEPTANCE.md",
      "projects/bellhop/PILOT-PLAN.md",
      "projects/bellhop/PILOT-WORK-ORDER.json",
      "projects/bellhop/PROJECT-CONTEXT.md",
      "projects/bellhop/PROJECT-STATE.json",
      "projects/cyber-assurance/DECISION-LOG.md",
      "projects/cyber-assurance/DEFERRED-BACKLOG.md",
      "projects/cyber-assurance/PROJECT-STATE.json",
    ];
    for (const rel of required) {
      expect(fs.existsSync(resolveRepoPath(rel))).toBe(true);
    }

    const rootEntries = fs.readdirSync(resolveRepoPath());
    const forbiddenRoot = [
      "CURSOR-COMPLETION-REPORT-CONTRACT.md",
      "CURSOR-WORK-ORDER-CONTRACT.md",
      "ORCHESTRATION-LOOP-CONTRACT.md",
      "ORCHESTRATOR-CONTEXT.md",
      "POLICY-ENGINE-CONTRACT.md",
      "decision.schema.json",
      "project-state.schema.json",
      "bellhop-radio-pilot.zip",
      "radio-phase0-bootstrap.zip",
    ];
    for (const name of forbiddenRoot) {
      expect(rootEntries).not.toContain(name);
    }

    // Pilot code must not load Cyber Assurance project files.
    const srcRoot = resolveRepoPath("src");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walk(p));
        else if (ent.name.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    for (const file of walk(srcRoot)) {
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toMatch(/resolveRepoPath\(\s*["']projects["']\s*,\s*["']cyber/);
      expect(text).not.toMatch(/loadProjectState\(\{\s*projectId:\s*["']cyber/);
      expect(text).not.toMatch(/projects\/["']\s*\+\s*["']cyber/);
    }
  });
});
