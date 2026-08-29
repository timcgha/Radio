import type { LoadedProjectBrain, ProjectState } from "../types.js";
import {
  formatAjvErrors,
  getSchemaValidator,
  readJsonFile,
  readTextFile,
  resolveRepoPath,
} from "../util/io.js";
import { computeStateFingerprint } from "./fingerprint.js";

export interface LoadStateOptions {
  projectId?: string;
  statePath?: string;
}

/**
 * Read-only Phase 0 state loader. Does not rewrite project state.
 */
export function loadProjectState(options: LoadStateOptions = {}): {
  state: ProjectState;
  fingerprint: string;
  path: string;
} {
  const projectId = options.projectId ?? "bellhop";
  const statePath =
    options.statePath ?? resolveRepoPath("projects", projectId, "PROJECT-STATE.json");

  const state = readJsonFile<ProjectState>(statePath);
  const validate = getSchemaValidator("project-state.schema.json");
  const ok = validate(state);
  if (!ok) {
    throw new Error(
      `PROJECT-STATE schema validation failed for ${statePath}: ${formatAjvErrors(validate.errors)}`,
    );
  }

  if (state.project.id !== projectId) {
    throw new Error(
      `Project ID mismatch: expected ${projectId}, got ${state.project.id}`,
    );
  }

  return {
    state,
    fingerprint: computeStateFingerprint(state),
    path: statePath,
  };
}

export function loadBellhopBrain(): LoadedProjectBrain {
  const { state, fingerprint } = loadProjectState({ projectId: "bellhop" });
  const base = resolveRepoPath("projects", "bellhop");

  return {
    state,
    fingerprint,
    projectContext: readTextFile(`${base}/PROJECT-CONTEXT.md`),
    decisionLog: readTextFile(`${base}/DECISION-LOG.md`),
    deferredBacklog: readTextFile(`${base}/DEFERRED-BACKLOG.md`),
    pilotPlan: readTextFile(`${base}/PILOT-PLAN.md`),
    pilotAcceptance: readTextFile(`${base}/PILOT-ACCEPTANCE.md`),
  };
}
