import fs from "node:fs";
import type { ProjectState, RuntimeState } from "../types.js";
import {
  formatAjvErrors,
  getSchemaValidator,
  nowIso,
  writeJsonAtomic,
} from "../util/io.js";
import { computeStateFingerprint } from "./fingerprint.js";
import { isLegalTransition } from "../policy/transitions.js";

export interface PersistStateResult {
  state: ProjectState;
  fingerprint: string;
  path: string;
  previousRevision: number;
}

/**
 * Persist project state with revision increment and schema validation.
 * Does not commit to git — caller controls VCS.
 */
export function persistProjectState(input: {
  state: ProjectState;
  path: string;
  expectedRevision: number;
}): PersistStateResult {
  if (input.state.stateRevision !== input.expectedRevision) {
    throw new Error(
      `Stale write refused: expected revision ${input.expectedRevision}, got ${input.state.stateRevision}`,
    );
  }

  const previousRevision = input.state.stateRevision;
  const next: ProjectState = {
    ...input.state,
    stateRevision: previousRevision + 1,
    stateUpdatedAt: nowIso(),
  };

  const validate = getSchemaValidator("project-state.schema.json");
  if (!validate(next)) {
    throw new Error(
      `PROJECT-STATE schema validation failed before write: ${formatAjvErrors(validate.errors)}`,
    );
  }

  writeJsonAtomic(input.path, next);
  return {
    state: next,
    fingerprint: computeStateFingerprint(next),
    path: input.path,
    previousRevision,
  };
}

export function transitionRuntimeState(
  state: ProjectState,
  to: RuntimeState,
  lastEvent: string,
): ProjectState {
  const from = state.radioRuntime.state;
  if (from !== to && !isLegalTransition(from, to)) {
    throw new Error(`Illegal runtime transition ${from} → ${to}`);
  }
  return {
    ...state,
    radioRuntime: {
      ...state.radioRuntime,
      state: to,
      lastEvent,
      lastError: null,
    },
  };
}

/**
 * Human control-plane runtime override.
 *
 * NOT part of LEGAL_TRANSITIONS / Sol model-facing edges.
 * Used only by explicit human-authorized recovery operations.
 */
export function applyHumanControlPlaneRuntimeState(
  state: ProjectState,
  to: RuntimeState,
  lastEvent: string,
): ProjectState {
  return {
    ...state,
    radioRuntime: {
      ...state.radioRuntime,
      state: to,
      lastEvent,
      lastError: null,
    },
  };
}

export function setRuntimeError(
  state: ProjectState,
  message: string,
): ProjectState {
  return {
    ...state,
    radioRuntime: {
      ...state.radioRuntime,
      lastError: message,
    },
  };
}

export function loadMutableStateCopy(statePath: string): ProjectState {
  const raw = fs.readFileSync(statePath, "utf8");
  return JSON.parse(raw) as ProjectState;
}
