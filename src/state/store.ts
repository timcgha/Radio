import type { LoadedProjectBrain, ProjectState } from "../types.js";
import { resolveProjectConfig } from "../projects/registry.js";
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
 * Read-only project state loader. Does not rewrite project state.
 */
export function loadProjectState(options: LoadStateOptions = {}): {
  state: ProjectState;
  fingerprint: string;
  path: string;
} {
  const projectKey = options.projectId ?? "bellhop";
  const project = resolveProjectConfig(projectKey);
  const statePath =
    options.statePath ??
    resolveRepoPath("projects", project.key, "PROJECT-STATE.json");

  const state = readJsonFile<ProjectState>(statePath);
  const validate = getSchemaValidator("project-state.schema.json");
  const ok = validate(state);
  if (!ok) {
    throw new Error(
      `PROJECT-STATE schema validation failed for ${statePath}: ${formatAjvErrors(validate.errors)}`,
    );
  }

  if (state.project.id !== project.stateProjectId) {
    throw new Error(
      `Project ID mismatch: expected ${project.stateProjectId}, got ${state.project.id}`,
    );
  }

  return {
    state,
    fingerprint: computeStateFingerprint(state),
    path: statePath,
  };
}

function readOptionalArtifact(base: string, relative?: string): string {
  if (!relative) return "";
  try {
    return readTextFile(`${base}/${relative}`);
  } catch {
    return "";
  }
}

export function loadProjectBrain(projectKey: string): LoadedProjectBrain {
  const project = resolveProjectConfig(projectKey);
  const { state, fingerprint } = loadProjectState({ projectId: projectKey });
  const base = resolveRepoPath("projects", project.key);

  return {
    state,
    fingerprint,
    projectContext: readOptionalArtifact(
      base,
      project.optionalArtifacts.programContext ?? "PROJECT-CONTEXT.md",
    ),
    decisionLog: readTextFile(`${base}/DECISION-LOG.md`),
    deferredBacklog: readTextFile(`${base}/DEFERRED-BACKLOG.md`),
    pilotPlan: readOptionalArtifact(base, project.optionalArtifacts.pilotPlan),
    pilotAcceptance: readOptionalArtifact(
      base,
      project.optionalArtifacts.pilotAcceptance,
    ),
  };
}

/** @deprecated Use loadProjectBrain("bellhop") for new code. */
export function loadBellhopBrain(): LoadedProjectBrain {
  return loadProjectBrain("bellhop");
}
