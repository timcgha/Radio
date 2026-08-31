import { isFullGitCommitSha } from "../cursor/source-ref.js";
import type { V2Objective, V2WorkType } from "./types.js";
import { V2_SCHEMA_VERSION } from "./types.js";

export const DEFAULT_MAX_WORKER_RUNS = 2;

const VALID_WORK_TYPES: ReadonlySet<V2WorkType> = new Set([
  "IMPLEMENTATION",
  "VERIFICATION",
  "DESIGN",
  "REVIEW",
]);

export class V2ObjectiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2ObjectiveValidationError";
  }
}

export function resolveMaxWorkerRuns(objective: V2Objective): number {
  const raw = objective.maxWorkerRuns;
  if (raw == null) return DEFAULT_MAX_WORKER_RUNS;
  if (!Number.isInteger(raw) || raw < 1) {
    throw new V2ObjectiveValidationError(
      `maxWorkerRuns must be a positive integer; got ${String(raw)}`,
    );
  }
  return raw;
}

export function validateV2Objective(raw: unknown): V2Objective {
  if (!raw || typeof raw !== "object") {
    throw new V2ObjectiveValidationError("objective must be an object");
  }
  const o = raw as Record<string, unknown>;

  if (o.schemaVersion !== V2_SCHEMA_VERSION) {
    throw new V2ObjectiveValidationError(
      `schemaVersion must be ${V2_SCHEMA_VERSION}`,
    );
  }

  const requiredStrings = [
    "objectiveId",
    "projectId",
    "repository",
    "baseBranch",
    "expectedStartingSha",
    "humanInstruction",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof o[key] !== "string" || !(o[key] as string).trim()) {
      throw new V2ObjectiveValidationError(`${key} is required`);
    }
  }

  if (!isFullGitCommitSha(o.expectedStartingSha as string)) {
    throw new V2ObjectiveValidationError(
      "expectedStartingSha must be a full 40-character Git SHA",
    );
  }

  if (!Array.isArray(o.authorizedWorkTypes) || o.authorizedWorkTypes.length === 0) {
    throw new V2ObjectiveValidationError(
      "authorizedWorkTypes must be a non-empty array",
    );
  }
  for (const wt of o.authorizedWorkTypes) {
    if (!VALID_WORK_TYPES.has(wt as V2WorkType)) {
      throw new V2ObjectiveValidationError(`invalid authorizedWorkType: ${String(wt)}`);
    }
  }

  if (typeof o.publicationRequired !== "boolean") {
    throw new V2ObjectiveValidationError("publicationRequired must be boolean");
  }

  if (!Array.isArray(o.humanApprovalBoundaries)) {
    throw new V2ObjectiveValidationError(
      "humanApprovalBoundaries must be an array",
    );
  }

  const objective: V2Objective = {
    schemaVersion: V2_SCHEMA_VERSION,
    objectiveId: (o.objectiveId as string).trim(),
    projectId: (o.projectId as string).trim(),
    repository: (o.repository as string).trim(),
    baseBranch: (o.baseBranch as string).trim(),
    expectedStartingSha: (o.expectedStartingSha as string).trim().toLowerCase(),
    humanInstruction: (o.humanInstruction as string).trim(),
    authorizedWorkTypes: o.authorizedWorkTypes as V2WorkType[],
    publicationRequired: o.publicationRequired,
    humanApprovalBoundaries: (o.humanApprovalBoundaries as string[]).map((s) =>
      String(s).trim(),
    ),
  };

  if (o.maxWorkerRuns != null) {
    objective.maxWorkerRuns = resolveMaxWorkerRuns({
      ...objective,
      maxWorkerRuns: o.maxWorkerRuns as number,
    });
  }
  if (o.testOnlyScope === true) {
    objective.testOnlyScope = true;
    objective.testPathPrefixes = Array.isArray(o.testPathPrefixes)
      ? (o.testPathPrefixes as string[]).map((p) => String(p).trim())
      : ["tests/"];
  }

  return objective;
}

export function loadV2ObjectiveFromFile(
  readJson: (path: string) => unknown,
  path: string,
): V2Objective {
  return validateV2Objective(readJson(path));
}
