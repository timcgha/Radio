import { describe, expect, it } from "vitest";
import {
  assertBellhopCursorEnvironmentPreflight,
  resolveCursorEnvironmentName,
  resolveV2ProjectBinding,
  V2ProjectBindingError,
} from "../../src/v2/project-binding.js";
import { createV2ProductionDeps, V2PreflightError } from "../../src/v2/deps.js";
import { bellhopObjective } from "../../src/v2/test-fixtures.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("v2 project binding", () => {
  it("resolves Bellhop authorized repository from registry", () => {
    const binding = resolveV2ProjectBinding(bellhopObjective());
    expect(binding.projectKey).toBe("bellhop");
    expect(binding.authorizedRepository).toBe(
      "https://github.com/timcgha/Bellhop",
    );
  });

  it("rejects wrong repository for projectId", () => {
    expect(() =>
      resolveV2ProjectBinding(
        bellhopObjective({
          repository: "https://github.com/evil/wrong",
        }),
      ),
    ).toThrow(V2ProjectBindingError);
  });

  it("reads Cursor environment name from RADIO_CURSOR_ENV_BELLHOP", () => {
    expect(
      resolveCursorEnvironmentName("bellhop", {
        RADIO_CURSOR_ENV_BELLHOP: "bellhop-prod",
      }),
    ).toBe("bellhop-prod");
  });

  it("fails preflight when Bellhop Cursor environment is missing", () => {
    const binding = resolveV2ProjectBinding(bellhopObjective());
    expect(() => assertBellhopCursorEnvironmentPreflight(binding)).toThrow(
      V2ProjectBindingError,
    );
  });

  it("production deps fail before worker creation when Bellhop env is absent", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "radio-v2-preflight-"));
    await expect(
      createV2ProductionDeps({
        objective: bellhopObjective(),
        runDir,
        overrides: {
          env: {
            OPENAI_API_KEY: "test-key",
            CURSOR_API_KEY: "test-key",
            CURSOR_EXECUTION_ENABLED: "true",
          },
        },
      }),
    ).rejects.toThrow(V2PreflightError);
  });
});
