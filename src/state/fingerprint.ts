import type { ProjectState } from "../types.js";
import { canonicalize, sha256Hex } from "../util/io.js";

/**
 * Orchestration-critical subset used for Phase 0 state fingerprinting.
 * Same material state → same fingerprint; material changes → different fingerprint.
 */
export function buildFingerprintMaterial(state: ProjectState): Record<string, unknown> {
  return {
    projectId: state.project.id,
    canonicalBranch: state.canonicalState.mainBranch,
    canonicalSha: state.canonicalState.mainSha,
    activeWorkstreamId: state.activeWorkstream?.id ?? null,
    activeWorkstreamStatus: state.activeWorkstream?.status ?? null,
    transactionId: state.currentTransaction?.id ?? null,
    transactionStatus: state.currentTransaction?.status ?? null,
    branch: state.currentTransaction?.branch ?? null,
    branchTipSha: state.currentTransaction?.branchTipSha ?? null,
    finalExecutableSha: state.currentTransaction?.finalExecutableSha ?? null,
    evidenceTipSha: state.currentTransaction?.evidenceTipSha ?? null,
    remediationBudget: state.currentTransaction?.remediationBudget ?? null,
    remediationsUsed: state.currentTransaction?.remediationsUsed ?? null,
    activeAgent: state.activeAgent,
    pendingHumanDecision: state.pendingHumanDecision,
    currentBlockers: state.currentBlockers,
    runtimeState: state.radioRuntime.state,
    stateRevision: state.stateRevision,
    budgets: state.budgets,
  };
}

export function computeStateFingerprint(state: ProjectState): string {
  const material = buildFingerprintMaterial(state);
  return sha256Hex(canonicalize(material));
}
