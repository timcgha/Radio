/**
 * Radio-managed project registry.
 *
 * Maps registry keys (folder names under projects/) to authoritative
 * project-state identities and project-specific Sol context adapters.
 */

export interface RadioProjectConfig {
  /** Registry key and projects/ folder name. */
  key: string;
  /** project.id stored in PROJECT-STATE.json. */
  stateProjectId: string;
  /** Human-readable product label for Sol context sections. */
  displayName: string;
  /** Lowercase markers that identify this project's content in Sol context. */
  identityMarkers: string[];
  /** Extra Phase 2 Sol constraint lines for this product. */
  phase2Constraints: string[];
  /** Optional relative paths under projects/<key>/ for brain loading. */
  optionalArtifacts: {
    pilotPlan?: string;
    pilotAcceptance?: string;
    programContext?: string;
  };
  /** Include bounded PROJECT-CONTEXT.md in Phase 3 initial Sol context. */
  includeProjectContextInPhase3Initial: boolean;
}

const BELLHOP: RadioProjectConfig = {
  key: "bellhop",
  stateProjectId: "bellhop",
  displayName: "Bellhop",
  identityMarkers: [
    "bellhop",
    "projects/bellhop",
    "level 4 stage",
    "asteroid garden",
    "cheese moon",
    "flight retune",
  ],
  phase2Constraints: [
    "- Do NOT start Stage 3, merge, deploy, or retune flight.",
    "- Stay within Bellhop Pilot 01 scope only.",
  ],
  optionalArtifacts: {
    pilotPlan: "PILOT-PLAN.md",
    pilotAcceptance: "PILOT-ACCEPTANCE.md",
  },
  includeProjectContextInPhase3Initial: false,
};

const CYBER_ASSURANCE: RadioProjectConfig = {
  key: "cyber-assurance",
  stateProjectId: "cyber-assurance",
  displayName: "Cyber Assurance",
  identityMarkers: [
    "cyber assurance",
    "cyber-assurance",
    "projects/cyber-assurance",
  ],
  phase2Constraints: [
    "- Do NOT start Wave 2 until Wave 1 verification-integrity blockers are resolved.",
    "- Do NOT modify Failure Controller.",
    "- Stay within the authorized Cyber Assurance recovery scope only.",
  ],
  optionalArtifacts: {
    programContext: "PROJECT-CONTEXT.md",
  },
  includeProjectContextInPhase3Initial: true,
};

const REGISTRY: Record<string, RadioProjectConfig> = {
  [BELLHOP.key]: BELLHOP,
  [CYBER_ASSURANCE.key]: CYBER_ASSURANCE,
};

export function resolveProjectConfig(projectKey: string): RadioProjectConfig {
  const config = REGISTRY[projectKey];
  if (!config) {
    throw new Error(`UNKNOWN_RADIO_PROJECT: ${projectKey}`);
  }
  return config;
}

export function listRegisteredProjectKeys(): string[] {
  return Object.keys(REGISTRY);
}

export function resolveProjectKeyFromStateId(stateProjectId: string): string {
  for (const config of Object.values(REGISTRY)) {
    if (config.stateProjectId === stateProjectId) {
      return config.key;
    }
  }
  throw new Error(`UNKNOWN_RADIO_PROJECT_STATE_ID: ${stateProjectId}`);
}
