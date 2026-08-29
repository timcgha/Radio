import type { AgentAction, CursorWorkOrder } from "../types.js";

const AGENT_ACTION_LABELS: Record<AgentAction, string> = {
  REUSE_CURRENT_AGENT: "REUSE CURRENT AGENT",
  FRESH_ORDINARY_AGENT_REQUIRED: "FRESH ORDINARY AGENT REQUIRED",
  FRESH_API_CREATED_PARENT_AUTO_REQUIRED: "FRESH API CREATED PARENT AUTO REQUIRED",
};

/**
 * Render a human-readable Cursor prompt from a structured work order.
 */
export function renderCursorPrompt(workOrder: CursorWorkOrder): string {
  const agentLabel = AGENT_ACTION_LABELS[workOrder.agentAction];
  const lines: string[] = [];

  lines.push(`AGENT REQUIREMENT: ${agentLabel}`);
  lines.push("");
  lines.push("You are implementing a Radio-controlled verification transaction.");
  lines.push("This is a bounded, read-only technical verification task.");
  lines.push("");

  if (workOrder.rendering.includeStructuredIdentity) {
    lines.push("==================================================");
    lines.push("WORK ORDER IDENTITY");
    lines.push("==================================================");
    lines.push(`workOrderId: ${workOrder.workOrderId}`);
    lines.push(`decisionId: ${workOrder.decisionId}`);
    lines.push(`projectId: ${workOrder.projectId}`);
    lines.push(`workstreamId: ${workOrder.workstreamId}`);
    lines.push(`transactionId: ${workOrder.transactionId}`);
    lines.push(`idempotencyKey: ${workOrder.idempotencyKey}`);
    lines.push(`agentAction: ${workOrder.agentAction}`);
    lines.push(`workType: ${workOrder.workType}`);
    lines.push("");
  }

  lines.push("==================================================");
  lines.push("OBJECTIVE");
  lines.push("==================================================");
  lines.push(workOrder.objective);
  lines.push("");

  if (workOrder.rendering.includeSourcePins) {
    lines.push("==================================================");
    lines.push("REPOSITORY AND SOURCE PINS");
    lines.push("==================================================");
    lines.push(`Repository: ${workOrder.source.repository}`);
    lines.push(
      `Integration branch: ${workOrder.source.canonicalMainBranch}`,
    );
    lines.push(
      `Integration SHA (reported): ${workOrder.source.canonicalMainSha ?? "null"}`,
    );
    lines.push(`Stage 2 / base branch: ${workOrder.source.baseBranch}`);
    lines.push(
      `Stage 2 expected tip (reported): ${workOrder.source.expectedBaseTipSha ?? "null"}`,
    );
    lines.push(
      `Expected executable ancestor SHA: ${workOrder.source.expectedExecutableAncestorSha ?? "null"}`,
    );
    lines.push(
      `Working branch: ${workOrder.source.workingBranch ?? "null"}`,
    );
    lines.push(
      `Create working branch: ${workOrder.source.createWorkingBranch}`,
    );
    lines.push("");
    lines.push("REQUIRED PRECHECK:");
    lines.push(
      "Verify these repository/branch/SHA facts before trusting them. Do not invent repository state. If observed state materially differs, halt with HALT_PRECHECK.",
    );
    lines.push("");
  }

  if (workOrder.rendering.includeScope) {
    lines.push("==================================================");
    lines.push("IN SCOPE");
    lines.push("==================================================");
    for (const item of workOrder.scope.inScope) {
      lines.push(`- ${item}`);
    }
    lines.push("");
    lines.push("==================================================");
    lines.push("OUT OF SCOPE / PROHIBITED");
    lines.push("==================================================");
    for (const item of workOrder.scope.outOfScope) {
      lines.push(`- ${item}`);
    }
    lines.push("");
    lines.push("allowedProductChanges: (empty — no product edits)");
    lines.push("Protected semantics:");
    for (const item of workOrder.scope.protectedSemantics) {
      lines.push(`- ${item}`);
    }
    lines.push("");
    lines.push("Hard prohibitions:");
    lines.push("- Do NOT make gameplay or product code edits.");
    lines.push("- Do NOT merge.");
    lines.push("- Do NOT deploy.");
    lines.push("- Do NOT start Stage 3.");
    lines.push("- Do NOT retune flight.");
    lines.push("- Do NOT create specialists or an API Parent.");
    lines.push("- Do NOT create or merge a PR.");
    lines.push("");
  }

  lines.push("==================================================");
  lines.push("REQUIREMENTS");
  lines.push("==================================================");
  for (const req of workOrder.requirements) {
    lines.push(`[${req.id}] (${req.class}/${req.priority}) ${req.statement}`);
    lines.push(`  Acceptance: ${req.acceptanceMethod}`);
  }
  lines.push("");

  if (workOrder.rendering.includeBudgets) {
    lines.push("==================================================");
    lines.push("BUDGETS");
    lines.push("==================================================");
    lines.push(`maxRemediationPasses: ${workOrder.budgets.maxRemediationPasses}`);
    lines.push(
      `maxSpecialistReviewCycles: ${workOrder.budgets.maxSpecialistReviewCycles}`,
    );
    lines.push(`maxAgents: ${workOrder.budgets.maxAgents}`);
    lines.push(
      `maxEstimatedUsd: ${workOrder.budgets.maxEstimatedUsd ?? "null"}`,
    );
    lines.push("");
  }

  lines.push("==================================================");
  lines.push("VERIFICATION COMMANDS");
  lines.push("==================================================");
  for (const cmd of workOrder.verification.requiredCommands) {
    lines.push(`- ${cmd}`);
  }
  lines.push("");

  lines.push("==================================================");
  lines.push("GIT / PR RESTRICTIONS");
  lines.push("==================================================");
  lines.push(
    `Protected branches: ${workOrder.git.protectedBranches.join(", ")}`,
  );
  lines.push(`pushRequired: ${workOrder.git.pushRequired}`);
  lines.push(`forcePushAllowed: ${workOrder.git.forcePushAllowed}`);
  lines.push(`commitRequired: ${workOrder.git.commitRequired}`);
  lines.push(`PR creationAllowed: ${workOrder.pr.creationAllowed}`);
  lines.push(`PR creationRequired: ${workOrder.pr.creationRequired}`);
  lines.push(`PR mergeAllowed: ${workOrder.pr.mergeAllowed}`);
  lines.push("");

  if (workOrder.rendering.includeStopConditions) {
    lines.push("==================================================");
    lines.push("STOP CONDITIONS");
    lines.push("==================================================");
    for (const stop of workOrder.stopConditions) {
      lines.push(`- [${stop.id}] ${stop.condition} → ${stop.requiredOutcome}`);
    }
    lines.push("");
  }

  lines.push("==================================================");
  lines.push("ALLOWED TERMINAL VERDICTS");
  lines.push("==================================================");
  for (const v of workOrder.completion.allowedTerminalVerdicts) {
    lines.push(`- ${v}`);
  }
  lines.push("");

  if (workOrder.rendering.includeCompletionContract) {
    lines.push("==================================================");
    lines.push("CRITICAL COMPLETION FORMAT");
    lines.push("==================================================");
    lines.push(
      "Return the entire final completion report inside exactly one fenced `text` code block.",
    );
    lines.push("Nothing before it.");
    lines.push("Nothing after it.");
    lines.push("No nested fences.");
    lines.push("One contiguous block.");
    lines.push("");
    lines.push(
      `finalReportFormat: ${workOrder.completion.finalReportFormat}`,
    );
    lines.push("Required report fields:");
    for (const field of workOrder.completion.requiredReportFields) {
      lines.push(`- ${field}`);
    }
    lines.push("");
  }

  lines.push("Begin by verifying repository identity and source pins.");
  return lines.join("\n");
}
