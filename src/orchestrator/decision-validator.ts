import type { OrchestratorDecision } from "../types.js";
import { formatAjvErrors, getSchemaValidator } from "../util/io.js";

export function validateDecision(decision: unknown): OrchestratorDecision {
  const validate = getSchemaValidator("decision.schema.json");
  const ok = validate(decision);
  if (!ok) {
    throw new Error(
      `Decision schema validation failed: ${formatAjvErrors(validate.errors)}`,
    );
  }
  return decision as OrchestratorDecision;
}

export function isValidDecision(decision: unknown): boolean {
  const validate = getSchemaValidator("decision.schema.json");
  return Boolean(validate(decision));
}
