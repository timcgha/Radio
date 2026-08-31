/**
 * Radio-managed project registry.
 *
 * Maps registry keys (folder names under projects/) to authoritative
 * project-state identities and project-specific Sol context adapters.
 */

export interface WorkOrderVerificationConfig {
  /** Commands rendered in work-order verification.requiredCommands. */
  requiredCommands: string[];
  /** Default terminal verdicts when Sol does not supply expectedTerminalVerdicts. */
  defaultTerminalVerdicts: string[];
  /**
   * Fallback branch/sha when no ObjectiveAuthority is attached (Bellhop Stage-2
   * pilot only). Other projects must supply trusted ObjectiveAuthority pins.
   */
  sourceFallback?: { branch: string; sha: string };
  /** Radio guardrail lines when no objective authority is attached. */
  pilotGuardrailsWithoutObjective: string[];
}

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
  /** Project-specific work-order verification and pilot defaults. */
  workOrder: WorkOrderVerificationConfig;
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
  workOrder: {
    requiredCommands: ["node tests/run.js", "node build.js", "git status --short"],
    defaultTerminalVerdicts: [
      "BELLHOP_RADIO_PILOT_VERIFIED_FOR_HUMAN_PLAYTEST",
      "BELLHOP_RADIO_PILOT_BLOCKED",
    ],
    sourceFallback: {
      branch: "cursor/level4-stage2-asteroid-garden-9dce",
      sha: "aa512d6ef721f855be33ddc36da490f9de66dc23",
    },
    pilotGuardrailsWithoutObjective: [
      "Do NOT start Stage 3 or later.",
      "Do NOT retune flight / change the frozen flight model.",
      "Do NOT make gameplay or product code edits unless the requested work explicitly authorizes them.",
    ],
  },
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
  workOrder: {
    requiredCommands: [
      "npm test",
      "npm run typecheck",
      "npm run lint",
      "npm run build",
      "npm run test:ux-wave1",
      "git status --short",
    ],
    defaultTerminalVerdicts: [
      "UX_WAVE1_VERIFICATION_READY_FOR_REVIEW",
      "UX_WAVE1_VERIFICATION_BLOCKED",
    ],
    pilotGuardrailsWithoutObjective: [
      "Do NOT start Wave 2.",
      "Do NOT modify Failure Controller.",
      "Do NOT make product code edits unless the requested work explicitly authorizes them.",
    ],
  },
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
