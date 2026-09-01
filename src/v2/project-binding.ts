/**
 * V2 project / environment binding via the Radio project registry.
 */

import { loadProjectState } from "../state/store.js";
import {
  resolveProjectConfig,
  resolveProjectKeyFromStateId,
} from "../projects/registry.js";
import type { V2Objective } from "./types.js";

export class V2ProjectBindingError extends Error {
  readonly code = "V2_PROJECT_BINDING_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "V2ProjectBindingError";
  }
}

export interface V2ProjectBinding {
  projectKey: string;
  displayName: string;
  /** Authoritative product repository from PROJECT-STATE.json. */
  authorizedRepository: string;
  /** Optional Cursor Cloud environment name for worker dispatch. */
  cursorEnvironmentName: string | null;
}

/**
 * Resolve Cursor Cloud environment name for a registered project.
 * Convention: RADIO_CURSOR_ENV_<PROJECT_KEY> e.g. RADIO_CURSOR_ENV_BELLHOP
 */
export function resolveCursorEnvironmentName(
  projectKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const normalized = projectKey.toUpperCase().replace(/-/g, "_");
  const value = env[`RADIO_CURSOR_ENV_${normalized}`]?.trim();
  return value || null;
}

/**
 * Bellhop workers require a Cursor Cloud environment binding before dispatch.
 * Fails closed when RADIO_CURSOR_ENV_BELLHOP is absent.
 */
export function assertBellhopCursorEnvironmentPreflight(
  binding: V2ProjectBinding,
): void {
  if (binding.projectKey !== "bellhop") {
    return;
  }
  if (!binding.cursorEnvironmentName) {
    throw new V2ProjectBindingError(
      "RADIO_CURSOR_ENV_BELLHOP is required for Bellhop v2 workers",
    );
  }
}

export function resolveV2ProjectBinding(
  objective: V2Objective,
  env: NodeJS.ProcessEnv = process.env,
): V2ProjectBinding {
  let projectKey: string;
  try {
    projectKey = resolveProjectKeyFromStateId(objective.projectId);
  } catch {
    throw new V2ProjectBindingError(
      `unknown projectId ${JSON.stringify(objective.projectId)}`,
    );
  }

  const projectConfig = resolveProjectConfig(projectKey);
  const { state } = loadProjectState({ projectId: projectKey });
  const authorizedRepository = state.project.repository.trim();

  if (objective.repository.trim() !== authorizedRepository) {
    throw new V2ProjectBindingError(
      `objective repository ${objective.repository} != authorized ${authorizedRepository} for project ${projectKey}`,
    );
  }

  return {
    projectKey,
    displayName: projectConfig.displayName,
    authorizedRepository,
    cursorEnvironmentName: resolveCursorEnvironmentName(projectKey, env),
  };
}
