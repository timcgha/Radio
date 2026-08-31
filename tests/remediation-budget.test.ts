import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectState } from "../src/state/store.js";
import { loadObjectiveAuthority } from "../src/runtime/objective-authority.js";
import { prepareAcceptedBaselineForObjectiveStart } from "../src/runtime/phase3-objective-start.js";
import {
  alignRemediationBudgetWithObjectiveAuthority,
  resolveEffectiveRemediationBudget,
} from "../src/runtime/remediation-budget.js";
import { resolveRepoPath } from "../src/util/io.js";
import type { ObjectiveAuthority } from "../src/types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "radio-remediation-budget-"));
}

function retry12Authority(overrides?: Partial<ObjectiveAuthority>): ObjectiveAuthority {
  return loadObjectiveAuthority(
    resolveRepoPath(
      "artifacts",
      "retry-12",
      "cyber-assurance-wave1-vi-narrow-remediation-12-objective-authority.json",
    ),
  );
}

describe("remediation budget alignment (Retry-12)", () => {
  it("authorizes exactly one remediation when REMEDIATION is permitted", () => {
    const budget = resolveEffectiveRemediationBudget({
      permittedWorkTypes: ["REMEDIATION", "VERIFICATION", "CLOSEOUT"],
      defaultRemediationBudgetPerTransaction: 1,
    });
    expect(budget).toBe(1);
  });

  it("keeps remediation budget zero when REMEDIATION is not permitted", () => {
    const budget = resolveEffectiveRemediationBudget({
      permittedWorkTypes: ["VERIFICATION", "CLOSEOUT"],
      defaultRemediationBudgetPerTransaction: 1,
    });
    expect(budget).toBe(0);
  });

  it("objective start sets remediationBudget=1 for Retry-12 authority", () => {
    const dir = tmpDir();
    const statePath = path.join(dir, "PROJECT-STATE.working.json");
    fs.copyFileSync(
      resolveRepoPath("projects", "cyber-assurance", "PROJECT-STATE.json"),
      statePath,
    );
    const { state } = loadProjectState({
      projectId: "cyber-assurance",
      statePath,
    });
    const authority = retry12Authority();
    const prepared = prepareAcceptedBaselineForObjectiveStart({
      state,
      authority,
      statePath,
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.state.currentTransaction?.remediationBudget).toBe(1);
    expect(prepared.state.currentTransaction?.remediationBudgetExhausted).toBe(
      false,
    );
  });

  it("alignRemediationBudgetWithObjectiveAuthority never expands beyond default", () => {
    const dir = tmpDir();
    const statePath = path.join(dir, "PROJECT-STATE.working.json");
    fs.copyFileSync(
      resolveRepoPath("projects", "cyber-assurance", "PROJECT-STATE.json"),
      statePath,
    );
    let { state } = loadProjectState({
      projectId: "cyber-assurance",
      statePath,
    });
    state = {
      ...state,
      authority: {
        ...state.authority,
        defaultRemediationBudgetPerTransaction: 1,
      },
      currentTransaction: state.currentTransaction
        ? {
            ...state.currentTransaction,
            remediationBudget: 0,
            remediationsUsed: 0,
            remediationBudgetExhausted: true,
          }
        : null,
    };
    const aligned = alignRemediationBudgetWithObjectiveAuthority(
      state,
      retry12Authority(),
    );
    expect(aligned.currentTransaction?.remediationBudget).toBe(1);
    expect(aligned.currentTransaction?.remediationBudgetExhausted).toBe(false);
  });
});
