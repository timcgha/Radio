import { describe, expect, it } from "vitest";
import {
  resolveCursorEnvironmentName,
  resolveV2ProjectBinding,
  V2ProjectBindingError,
} from "../../src/v2/project-binding.js";
import { bellhopObjective } from "../../src/v2/test-fixtures.js";

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
});
