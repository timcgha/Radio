import { describe, expect, it } from "vitest";
import { assertV2LivePreflight, V2PreflightError } from "../../src/v2/deps.js";

describe("v2 v1 isolation", () => {
  it("does not import v1 phase3 loop or report repair", async () => {
    const depsSource = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/v2/deps.ts", "utf8"),
    );
    const orchestratorSource = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/v2/orchestrator.ts", "utf8"),
    );
    const combined = depsSource + orchestratorSource;
    expect(combined).not.toMatch(/runPhase3Loop/);
    expect(combined).not.toMatch(/CompletionReportRepairContract/);
    expect(combined).not.toMatch(/report-repair/);
    expect(combined).not.toMatch(/remediationBudget/);
    expect(combined).not.toMatch(/completion-validator/);
    expect(combined).not.toMatch(/evidence reconciliation/i);
  });
});

describe("v2 live preflight", () => {
  it("fails clearly when OPENAI_API_KEY is missing", () => {
    expect(() =>
      assertV2LivePreflight({
        ...process.env,
        OPENAI_API_KEY: "",
        CURSOR_API_KEY: "key",
        CURSOR_EXECUTION_ENABLED: "true",
      }),
    ).toThrow(V2PreflightError);
  });

  it("fails clearly when Cursor execution is not authorized", () => {
    expect(() =>
      assertV2LivePreflight({
        ...process.env,
        OPENAI_API_KEY: "key",
        CURSOR_API_KEY: "key",
        CURSOR_EXECUTION_ENABLED: "false",
      }),
    ).toThrow(/CURSOR_EXECUTION_ENABLED/);
  });
});
