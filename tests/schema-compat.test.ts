import { describe, expect, it } from "vitest";
import {
  deriveModelFacingDecisionSchema,
  deriveOpenAiCompatibleDecisionSchema,
} from "../src/orchestrator/schema-compat.js";
import {
  isValidDecision,
  validateDecision,
} from "../src/orchestrator/decision-validator.js";
import type { RuntimeState } from "../src/types.js";
import { loadSchema, readJsonFile, resolveRepoPath } from "../src/util/io.js";

function enumOf(
  schema: Record<string, unknown>,
  field: "from" | "to",
): string[] {
  const properties = schema.properties as Record<string, unknown>;
  const st = properties.stateTransition as Record<string, unknown>;
  const stProps = st.properties as Record<string, unknown>;
  const node = stProps[field] as { enum?: string[] };
  if (!node.enum) {
    throw new Error(`Expected inline enum on stateTransition.${field}`);
  }
  return node.enum;
}

describe("model schema transition narrowing", () => {
  const canonical = loadSchema("decision.schema.json") as Record<
    string,
    unknown
  >;

  it("given PLANNING, constrains from and allows IMPLEMENTING but not WAITING_FOR_AGENT", () => {
    const { schema } = deriveModelFacingDecisionSchema(canonical, {
      currentRuntimeState: "PLANNING",
    });
    expect(enumOf(schema, "from")).toEqual(["PLANNING"]);
    expect(enumOf(schema, "to")).toContain("IMPLEMENTING");
    expect(enumOf(schema, "to")).toContain("READY_FOR_HUMAN");
    expect(enumOf(schema, "to")).toContain("BLOCKED");
    expect(enumOf(schema, "to")).not.toContain("WAITING_FOR_AGENT");
  });

  it("narrows IMPLEMENTING generically (not Bellhop-specific)", () => {
    const { schema } = deriveModelFacingDecisionSchema(canonical, {
      currentRuntimeState: "IMPLEMENTING",
    });
    expect(enumOf(schema, "from")).toEqual(["IMPLEMENTING"]);
    expect(enumOf(schema, "to")).toContain("WAITING_FOR_AGENT");
    expect(enumOf(schema, "to")).not.toContain("PLANNING");
    expect(enumOf(schema, "to")).not.toContain("VERIFYING");
  });

  it("narrows WAITING_FOR_AGENT generically", () => {
    const { schema } = deriveModelFacingDecisionSchema(canonical, {
      currentRuntimeState: "WAITING_FOR_AGENT",
    });
    expect(enumOf(schema, "from")).toEqual(["WAITING_FOR_AGENT"]);
    expect(enumOf(schema, "to")).toEqual(
      expect.arrayContaining(["VERIFYING", "BLOCKED", "WAITING_FOR_AGENT"]),
    );
    expect(enumOf(schema, "to")).not.toContain("IMPLEMENTING");
  });

  it("OpenAI-compat-only derive does not narrow transitions", () => {
    const { schema } = deriveOpenAiCompatibleDecisionSchema(canonical);
    const properties = schema.properties as Record<string, unknown>;
    const st = properties.stateTransition as Record<string, unknown>;
    const stProps = st.properties as Record<string, unknown>;
    expect(stProps.from).toEqual({ $ref: "#/$defs/runtimeState" });
    expect(stProps.to).toEqual({ $ref: "#/$defs/runtimeState" });
  });

  it("does not mutate the loaded canonical schema object", () => {
    const before = JSON.stringify(canonical);
    deriveModelFacingDecisionSchema(canonical, {
      currentRuntimeState: "PLANNING",
    });
    expect(JSON.stringify(canonical)).toBe(before);
  });

  it("canonical validation still accepts PLANNING → IMPLEMENTING", () => {
    const fixture = readJsonFile(
      resolveRepoPath(
        "fixtures",
        "decisions",
        "bellhop-legal-launch-cursor.json",
      ),
    ) as { stateTransition: { from: RuntimeState; to: RuntimeState } };
    expect(fixture.stateTransition).toEqual(
      expect.objectContaining({
        from: "PLANNING",
        to: "IMPLEMENTING",
      }),
    );
    expect(isValidDecision(fixture)).toBe(true);
    expect(validateDecision(fixture).stateTransition.to).toBe("IMPLEMENTING");
  });
});
