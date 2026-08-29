import { describe, expect, it } from "vitest";
import {
  buildSolContext,
  contextContainsCyberAssuranceLeak,
} from "../src/orchestrator/context-builder.js";
import { loadBellhopBrain } from "../src/state/store.js";

describe("context", () => {
  const brain = loadBellhopBrain();
  const context = buildSolContext({
    brain,
    projectId: "bellhop",
    workstreamId: "radio-pilot-01",
    transactionId: "bellhop-radio-pilot-01-stage2-verification",
  });

  it("includes Bellhop identity", () => {
    expect(context.user).toContain("bellhop");
    expect(context.user).toContain("Bellhop");
    expect(context.user).toContain("https://github.com/timcgha/Bellhop");
  });

  it("includes current transaction", () => {
    expect(context.user).toContain(
      "bellhop-radio-pilot-01-stage2-verification",
    );
    expect(context.user).toContain("radio-pilot-01");
  });

  it("includes Stage 2 human playtest gate", () => {
    const blob = `${context.system}\n${context.user}`.toLowerCase();
    expect(blob).toMatch(/playtest/);
    expect(blob).toMatch(/merge/);
  });

  it("includes frozen flight semantics", () => {
    const blob = `${context.system}\n${context.user}`.toLowerCase();
    expect(blob).toMatch(/flight/);
    expect(blob).toMatch(/frozen|retune/);
  });

  it("includes Bellhop repo URL", () => {
    expect(context.user).toContain("https://github.com/timcgha/Bellhop");
  });

  it("excludes unrelated Cyber Assurance product details", () => {
    expect(contextContainsCyberAssuranceLeak(context)).toBe(false);
    expect(context.user.toLowerCase()).not.toContain("cyber assurance");
    expect(context.system.toLowerCase()).not.toContain("cyber-assurance");
  });

  it("marks dry-run / Cursor execution disabled", () => {
    expect(context.system).toMatch(/DRY-RUN/i);
    expect(context.system).toMatch(/Cursor execution is DISABLED/i);
  });

  it("explains LAUNCH_CURSOR proposes PLANNING → IMPLEMENTING not WAITING_FOR_AGENT", () => {
    expect(context.user).toContain(
      "For LAUNCH_CURSOR from PLANNING: propose PLANNING → IMPLEMENTING.",
    );
    expect(context.user).toContain(
      "Radio runtime later performs IMPLEMENTING → WAITING_FOR_AGENT after Cursor dispatch is actually initiated.",
    );
    expect(context.user).toContain(
      "Do NOT propose PLANNING → WAITING_FOR_AGENT",
    );
    expect(context.user).toMatch(
      /legal direct outgoing states: IMPLEMENTING \| READY_FOR_HUMAN \| BLOCKED/,
    );
  });
});
