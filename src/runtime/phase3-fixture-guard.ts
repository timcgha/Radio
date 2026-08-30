/**
 * Live Phase 3 must never source orchestration semantics from Phase 3 fixture
 * decision files. Fixture paths are deterministic test inputs only.
 */

import path from "node:path";
import { resolveRepoPath } from "../util/io.js";
import { FIXTURE_PHASE3_IDENTITIES } from "./objective-authority.js";

/** Canonical Phase 3 fixture decision paths — forbidden as live decision sources. */
export const PHASE3_FIXTURE_DECISION_BASENAMES = [
  "phase3-initial-launch.json",
  "phase3-retry-launch.json",
  "phase3-human-gate.json",
  "phase3-live-retry-launch.json",
  "phase3-live-human-gate.json",
  "phase3-stage3-human-gate.json",
  "phase3-policy-violation.json",
] as const;

export function resolvePhase3FixtureDecisionPath(basename: string): string {
  return resolveRepoPath("fixtures", "decisions", basename);
}

export function isPhase3FixtureDecisionPath(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  const normalized = path.normalize(filePath);
  for (const basename of PHASE3_FIXTURE_DECISION_BASENAMES) {
    if (normalized.endsWith(path.join("fixtures", "decisions", basename))) {
      return true;
    }
  }
  return false;
}

export function assertLiveModeDoesNotUseFixtureDecisionPath(
  mode: "live" | "fixture",
  filePath: string | undefined | null,
  context: string,
): void {
  if (mode !== "live") return;
  if (isPhase3FixtureDecisionPath(filePath)) {
    throw new Error(
      `LIVE_FIXTURE_DECISION_LEAK: ${context} cannot load Phase 3 fixture decision ${filePath}`,
    );
  }
}

export function containsFixturePhase3Identity(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    return (FIXTURE_PHASE3_IDENTITIES as readonly string[]).includes(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsFixturePhase3Identity(item));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) =>
      containsFixturePhase3Identity(v),
    );
  }
  return false;
}

export function assertLiveDecisionFreeOfFixtureSemantics(input: {
  mode: "live" | "fixture";
  decision: unknown;
  context: string;
}): void {
  if (input.mode !== "live") return;
  if (containsFixturePhase3Identity(input.decision)) {
    throw new Error(
      `LIVE_FIXTURE_SEMANTIC_LEAK: ${input.context} contains fixture Phase 3 identity`,
    );
  }
}
