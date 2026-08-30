import type { SolContext } from "../types.js";
import {
  listRegisteredProjectKeys,
  resolveProjectConfig,
} from "../projects/registry.js";

function contextBlob(context: SolContext): string {
  return `${context.system}\n${context.user}`.toLowerCase();
}

/** Test helper: detect foreign-project content in a Sol context. */
export function contextContainsForeignProjectLeak(
  context: SolContext,
  projectKey: string,
): boolean {
  const active = resolveProjectConfig(projectKey);
  const blob = contextBlob(context);
  for (const otherKey of listRegisteredProjectKeys()) {
    if (otherKey === active.key) continue;
    const other = resolveProjectConfig(otherKey);
    if (other.identityMarkers.some((marker) => blob.includes(marker))) {
      return true;
    }
  }
  return false;
}

export function assertProjectContextIsolation(
  context: SolContext,
  projectKey: string,
): void {
  if (contextContainsForeignProjectLeak(context, projectKey)) {
    throw new Error(
      `Sol context for ${projectKey} leaked foreign project content`,
    );
  }
}

/** @deprecated Use contextContainsForeignProjectLeak for project-aware checks. */
export function contextContainsCyberAssuranceLeak(
  context: SolContext,
): boolean {
  return contextContainsForeignProjectLeak(context, "bellhop");
}
