/**
 * Structural objective completion requirements — human-authorized, persisted,
 * and propagated into work orders and post-Sol acceptance gates.
 */

import type { ObjectiveAuthority, ObjectiveCompletionRequirements } from "../types.js";
import { formatAjvErrors, getSchemaValidator } from "../util/io.js";

export const DEFAULT_OBJECTIVE_COMPLETION_REQUIREMENTS: Required<ObjectiveCompletionRequirements> =
  {
    structuredWorkerReportRequired: false,
    commitRequired: false,
    remotePublicationRequired: false,
    freshExecutableShaRequired: false,
    evidenceTipRequired: false,
  };

/** Resolve optional authority completion requirements to explicit booleans. */
export function resolveObjectiveCompletionRequirements(
  authority: ObjectiveAuthority,
): Required<ObjectiveCompletionRequirements> {
  const req = authority.completionRequirements ?? {};
  return {
    structuredWorkerReportRequired: req.structuredWorkerReportRequired === true,
    commitRequired: req.commitRequired === true,
    remotePublicationRequired: req.remotePublicationRequired === true,
    freshExecutableShaRequired: req.freshExecutableShaRequired === true,
    evidenceTipRequired: req.evidenceTipRequired === true,
  };
}

export function hasActiveCompletionRequirements(
  requirements: Required<ObjectiveCompletionRequirements>,
): boolean {
  return Object.values(requirements).some(Boolean);
}

export function validateObjectiveAuthorityDocument(
  authority: unknown,
): ObjectiveAuthority {
  const validate = getSchemaValidator("objective-authority.schema.json");
  if (!validate(authority)) {
    throw new Error(
      `Objective authority schema validation failed: ${formatAjvErrors(validate.errors)}`,
    );
  }
  return authority as ObjectiveAuthority;
}
