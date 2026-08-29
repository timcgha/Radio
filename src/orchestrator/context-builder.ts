import type { LoadedProjectBrain, SolContext } from "../types.js";
import { readTextFile, resolveRepoPath } from "../util/io.js";

const DECISION_VOCABULARY = [
  "NO_ACTION",
  "WAIT",
  "LAUNCH_CURSOR",
  "REUSE_CURSOR",
  "REQUEST_HUMAN_APPROVAL",
  "ACCEPT_WORKSTREAM",
  "BLOCK_WORKSTREAM",
] as const;

const AGENT_ACTIONS = [
  "REUSE_CURRENT_AGENT",
  "FRESH_ORDINARY_AGENT_REQUIRED",
  "FRESH_API_CREATED_PARENT_AUTO_REQUIRED",
] as const;

const WORK_TYPES = [
  "PRECHECK",
  "DESIGN",
  "IMPLEMENTATION",
  "VERIFICATION",
  "REVIEW",
  "REMEDIATION",
  "RECOVERY",
  "CLOSEOUT",
  "REPORT_REPAIR",
] as const;

export interface BuildContextInput {
  brain: LoadedProjectBrain;
  projectId: string;
  workstreamId: string;
  transactionId: string;
  decisionIdHint?: string;
}

/**
 * Bounded Sol context for Bellhop Pilot 01. Explicitly excludes Cyber Assurance.
 */
export function buildSolContext(input: BuildContextInput): SolContext {
  const { brain, projectId, workstreamId, transactionId } = input;
  const { state, fingerprint } = brain;

  const doctrineExcerpt = extractDoctrine();
  const relevantDecisions = extractRelevantDecisions(brain.decisionLog);
  const relevantDeferred = extractRelevantDeferred(brain.deferredBacklog);
  const pilotObjective = extractPilotObjective(brain.pilotPlan, brain.pilotAcceptance);

  const system = [
    "You are GPT-5.6 Sol, the orchestration layer for Radio v0.1.",
    "",
    "CORE DOCTRINE:",
    "- Human Product Owner retains consequential judgment.",
    "- GPT-5.6 Sol proposes the next orchestration action.",
    "- Radio deterministic policy enforces legality.",
    "- Cursor reports are evidence, not truth.",
    "- The LLM reasons; Radio enforces.",
    "",
    doctrineExcerpt,
    "",
    "PHASE 0 CONSTRAINTS (MANDATORY):",
    "- This is a DRY-RUN planning decision only.",
    "- Cursor execution is DISABLED in Phase 0.",
    "- Propose the next legal action as if Radio would later transmit a work order.",
    "- Do NOT invent repository facts.",
    "- Do NOT redesign Bellhop.",
    "- Do NOT start Stage 3.",
    "- Do NOT merge.",
    "- Do NOT deploy.",
    "- Do NOT retune flight.",
    "- Do NOT reference any other Radio-managed product.",
    "- Stay within Bellhop Pilot 01 scope only.",
    "",
    "Return a single structured Orchestrator Decision object conforming to the provided schema.",
  ].join("\n");

  const user = [
    `projectId (required): ${projectId}`,
    `workstreamId (required): ${workstreamId}`,
    `transactionId (required): ${transactionId}`,
    `stateRevision: ${state.stateRevision}`,
    `stateFingerprint: ${fingerprint}`,
    `decisionId: generate a unique decisionId string`,
    `generatedAt: use a valid current ISO-8601 timestamp`,
    "",
    "=== BELLHOP DURABLE PROJECT CONTEXT ===",
    sanitizeForeignProductMentions(truncate(brain.projectContext, 12000)),
    "",
    "=== CURRENT BELLHOP PROJECT STATE (JSON) ===",
    JSON.stringify(state, null, 2),
    "",
    "=== RELEVANT BELLHOP DECISIONS ===",
    sanitizeForeignProductMentions(relevantDecisions),
    "",
    "=== RELEVANT DEFERRED / FROZEN WORK ===",
    sanitizeForeignProductMentions(relevantDeferred),
    "",
    "=== PILOT 01 OBJECTIVE AND ACCEPTANCE BOUNDARY ===",
    sanitizeForeignProductMentions(pilotObjective),
    "",
    "=== LEGAL DECISION VOCABULARY ===",
    `decision enum: ${DECISION_VOCABULARY.join(" | ")}`,
    `agentAction enum (when cursorInstruction present): ${AGENT_ACTIONS.join(" | ")}`,
    `workType enum: ${WORK_TYPES.join(" | ")}`,
    "",
    "=== TASK ===",
    "Decide the smallest legal next orchestration action for Bellhop Radio Pilot 01.",
    "Objective: technical verification of existing Level 4 Stage 2 Asteroid Garden for the required human playtest.",
    "Repository: https://github.com/timcgha/Bellhop",
    "Reported integration branch/SHA: level3 / d1e7f10",
    "Reported Stage 2 branch/tip: cursor/level4-stage2-asteroid-garden-9dce / aa512d6",
    "Budgets: max Cursor agents 1; specialists 0; remediation 0; recovery 0.",
    "If proposing LAUNCH_CURSOR, populate cursorInstruction with a complete prompt that:",
    "  - states the agent action near the top;",
    "  - requires the entire final completion report inside exactly one fenced text code block with nothing before or after;",
    "  - forbids product edits, merge, deploy, Stage 3, flight retune, specialists, and PR creation.",
    "stateTransition.from must equal current radioRuntime.state.",
    "Populate required payloads for the chosen decision; set unused payloads to null.",
  ].join("\n");

  // Soft leak guard for construction-time regressions (tests assert harder).
  const combined = `${system}\n${user}`.toLowerCase();
  if (
    combined.includes("cyber assurance") ||
    combined.includes("cyber-assurance")
  ) {
    throw new Error(
      "Context builder leaked Cyber Assurance content into Bellhop Sol context",
    );
  }

  return {
    system,
    user,
    vocabulary: [...DECISION_VOCABULARY],
    fingerprint,
    stateRevision: state.stateRevision,
  };
}

function extractDoctrine(): string {
  try {
    const text = readTextFile(resolveRepoPath("docs", "ORCHESTRATOR-CONTEXT.md"));
    // Keep a bounded doctrine excerpt rather than dumping the whole file.
    const mission = sliceSection(text, "## 1. Mission", "## 2.");
    const philosophy = sliceSection(text, "## 3. Core Philosophy", "## 4.");
    return ["RADIO DOCTRINE EXCERPT:", mission, philosophy]
      .map(sanitizeForeignProductMentions)
      .join("\n\n");
  } catch {
    return "RADIO DOCTRINE: The LLM reasons; Radio enforces.";
  }
}

function extractRelevantDecisions(decisionLog: string): string {
  const keep = [
    "B-010",
    "B-014",
    "B-016",
    "B-017",
    "B-018",
    "B-019",
    "B-001",
  ];
  const blocks = decisionLog.split(/\n---\n/);
  const selected = blocks.filter((b) => keep.some((id) => b.includes(id)));
  return selected.join("\n---\n").slice(0, 8000);
}

function extractRelevantDeferred(deferred: string): string {
  // Pilot-relevant deferred/frozen items only.
  const keepIds = [
    "DEF-B-001",
    "DEF-B-002",
    "DEF-B-003",
    "DEF-B-004",
    "DEF-B-011",
    "DEF-B-012",
  ];
  const blocks = deferred.split(/\n---\n/);
  const selected = blocks.filter((b) => keepIds.some((id) => b.includes(id)));
  return selected.join("\n---\n").slice(0, 6000);
}

function extractPilotObjective(plan: string, acceptance: string): string {
  const phase0 = sliceSection(plan, "## 4. Phase 0", "## 5.");
  const gate = sliceSection(plan, "## 3. Hard Product Gate", "## 4.");
  const limits = sliceSection(plan, "## 8. Resource Limits", "## 9.");
  const dryRunSafety = sliceSection(acceptance, "## E. Dry-Run Safety", "## F.");
  return [gate, phase0, limits, dryRunSafety].join("\n\n").slice(0, 8000);
}

function sliceSection(text: string, start: string, end: string): string {
  const s = text.indexOf(start);
  if (s < 0) return "";
  const e = text.indexOf(end, s + start.length);
  return (e < 0 ? text.slice(s) : text.slice(s, e)).trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated for Phase 0 context bound]`;
}

/** Remove cross-product mentions so Bellhop Sol context stays product-isolated. */
function sanitizeForeignProductMentions(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const lower = line.toLowerCase();
      return (
        !lower.includes("cyber assurance") && !lower.includes("cyber-assurance")
      );
    })
    .join("\n");
}

/** Test helper: assert context excludes Cyber Assurance product details. */
export function contextContainsCyberAssuranceLeak(context: SolContext): boolean {
  const blob = `${context.system}\n${context.user}`.toLowerCase();
  const needles = [
    "cyber assurance",
    "cyber-assurance",
    "projects/cyber-assurance",
  ];
  return needles.some((n) => blob.includes(n));
}
