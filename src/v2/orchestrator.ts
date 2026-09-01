/**
 * Radio v2 thin orchestrator — PLAN → WORK → VERIFY → DECIDE loop.
 *
 * Worker output is evidence, not Radio state.
 */

import type { CursorApiClient } from "../cursor/api-client.js";
import type { ResolveRemoteBranchTip } from "../cursor/source-ref.js";
import type { VerifyCommitAncestry } from "../cursor/remote-publication-verify.js";
import {
  createArtifactWriter,
  defaultRunDir,
  loadRunState,
  type V2ArtifactWriter,
} from "./artifacts.js";
import {
  launchV2Worker,
  V2RepositoryBindingError,
} from "./cursor-worker.js";
import { resolveMaxWorkerRuns, validateV2Objective } from "./objective.js";
import { evaluateProductScopeGate } from "./scope.js";
import { buildDecisionPacket, type V2SolClient } from "./sol-client.js";
import { verifyStartingSource, type V2SourcePinError } from "./source.js";
import {
  deriveVerifiedGitFacts,
  evaluateHardGate,
} from "./verify.js";
import { parseWorkerNarrative } from "./worker-narrative.js";
import type {
  V2Objective,
  V2Plan,
  V2RunResult,
  V2RunState,
  V2RunSummary,
  V2SolDecision,
  V2Stage,
  V2TerminalOutcome,
  V2VerifiedFacts,
  V2WorkerIdentity,
} from "./types.js";
import { V2_SCHEMA_VERSION } from "./types.js";
import { nowIso } from "../util/io.js";

export interface V2WorkerOutcome {
  narrative: string;
  implementationBranch: string;
  implementationTipSha: string;
}

export interface V2OrchestratorDeps {
  objective: V2Objective;
  solClient: V2SolClient;
  cursorClient: CursorApiClient;
  resolveRemoteBranchTip: ResolveRemoteBranchTip;
  verifyCommitAncestry?: VerifyCommitAncestry;
  listChangedFiles?: (input: {
    repositoryUrl: string;
    baseSha: string;
    tipSha: string;
  }) => Promise<string[]>;
  /** Called after worker launch to obtain outcome (fixture or poll). */
  obtainWorkerOutcome: (ctx: {
    agentId: string;
    runId: string;
    iteration: number;
  }) => Promise<V2WorkerOutcome>;
  projectBinding?: import("./project-binding.js").V2ProjectBinding;
  runDir?: string;
  artifactWriter?: V2ArtifactWriter;
  resumeState?: V2RunState | null;
}

export interface V2OrchestratorMetrics {
  humanMessagesAfterLaunch: number;
  implementationWorkersCreated: number;
  reportRepairAttempts: number;
}

function initialRunState(objective: V2Objective): V2RunState {
  return {
    schemaVersion: V2_SCHEMA_VERSION,
    objective,
    stage: "PLAN",
    iteration: 0,
    workerRunsUsed: 0,
    startingSha: objective.expectedStartingSha,
    lastImplementationTipSha: null,
    lastImplementationBranch: null,
    lastVerifiedFacts: null,
    lastSolDecision: null,
    activeWorker: null,
    terminalOutcome: null,
    terminalReason: null,
    updatedAt: nowIso(),
  };
}

function persistState(
  writer: V2ArtifactWriter,
  state: V2RunState,
): void {
  state.updatedAt = nowIso();
  writer.writeRunState(state);
}

function terminal(
  state: V2RunState,
  outcome: V2TerminalOutcome,
  reason: string,
): V2RunState {
  return {
    ...state,
    stage: outcome,
    terminalOutcome: outcome,
    terminalReason: reason,
    activeWorker: null,
    updatedAt: nowIso(),
  };
}

function buildSummary(
  state: V2RunState,
  metrics: V2OrchestratorMetrics,
): V2RunSummary {
  const facts = state.lastVerifiedFacts;
  return {
    objectiveId: state.objective.objectiveId,
    finalStage: state.stage,
    terminalOutcome: state.terminalOutcome,
    iterations: state.iteration,
    workerRunsUsed: state.workerRunsUsed,
    humanMessagesAfterLaunch: metrics.humanMessagesAfterLaunch,
    implementationWorkersCreated: metrics.implementationWorkersCreated,
    structuredWorkerReportRequired: false,
    reportRepairAttempts: metrics.reportRepairAttempts,
    startingShaEqualsImplementationTip:
      facts?.startingShaEqualsImplementationTip ?? false,
    startingShaAncestorOfImplementationTip:
      facts?.isAncestorStartingToImplementation ?? false,
    completedAt: state.terminalOutcome ? nowIso() : null,
  };
}

export async function runV2Loop(deps: V2OrchestratorDeps): Promise<V2RunResult> {
  const objective = validateV2Objective(deps.objective);
  const maxWorkerRuns = resolveMaxWorkerRuns(objective);
  const runDir = deps.runDir ?? defaultRunDir(objective.objectiveId);
  const writer = deps.artifactWriter ?? createArtifactWriter(runDir);
  const metrics: V2OrchestratorMetrics = {
    humanMessagesAfterLaunch: 0,
    implementationWorkersCreated: 0,
    reportRepairAttempts: 0,
  };

  let state = deps.resumeState ?? initialRunState(objective);
  writer.writeObjective(objective);

  // ── PLAN ──────────────────────────────────────────────────────────────
  if (state.stage === "PLAN" || state.iteration === 0) {
    let sourceResolution;
    try {
      sourceResolution = await verifyStartingSource({
        objective,
        resolveRemoteBranchTip: deps.resolveRemoteBranchTip,
      });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : String(err);
      state = terminal(state, "FAILED_POLICY", reason);
      persistState(writer, state);
      const summary = buildSummary(state, metrics);
      writer.writeSummary(summary);
      return { state, summary, runDir };
    }

    const plan: V2Plan = {
      objectiveId: objective.objectiveId,
      startingSha: sourceResolution.startingSha,
      repository: sourceResolution.repository,
      baseBranch: sourceResolution.baseBranch,
      authorizedWorkTypes: objective.authorizedWorkTypes,
      publicationRequired: objective.publicationRequired,
      maxWorkerRuns,
      plannedAt: nowIso(),
    };
    writer.writePlan(plan);
    state = {
      ...state,
      stage: "WORK",
      startingSha: sourceResolution.startingSha,
      iteration: state.iteration || 1,
    };
    persistState(writer, state);
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  while (
    state.stage !== "DONE" &&
    state.stage !== "HUMAN" &&
    state.stage !== "FAILED_MACHINE" &&
    state.stage !== "FAILED_POLICY"
  ) {
    if (state.stage === "WORK") {
      // Resume: worker result already persisted for this iteration.
      const persistedNarrative = await readWorkerNarrativeForIteration(
        writer,
        state.iteration,
      );
      if (
        persistedNarrative &&
        state.lastImplementationTipSha &&
        state.lastImplementationBranch
      ) {
        state = {
          ...state,
          stage: "VERIFY",
          activeWorker: null,
        };
        persistState(writer, state);
        continue;
      }

      // Resume: observe active worker without creating a duplicate.
      if (state.activeWorker) {
        let outcome: V2WorkerOutcome;
        try {
          outcome = await deps.obtainWorkerOutcome({
            agentId: state.activeWorker.agentId,
            runId: state.activeWorker.runId,
            iteration: state.iteration,
          });
        } catch (err) {
          state = terminal(
            state,
            "FAILED_MACHINE",
            err instanceof Error ? err.message : String(err),
          );
          persistState(writer, state);
          break;
        }

        writer.writeWorkerResult(state.iteration, outcome.narrative);
        state = {
          ...state,
          stage: "VERIFY",
          lastImplementationTipSha: outcome.implementationTipSha,
          lastImplementationBranch: outcome.implementationBranch,
          activeWorker: null,
        };
        persistState(writer, state);
        continue;
      }

      if (state.workerRunsUsed >= maxWorkerRuns) {
        state = terminal(
          state,
          "FAILED_POLICY",
          `maxWorkerRuns (${maxWorkerRuns}) exhausted`,
        );
        persistState(writer, state);
        break;
      }

      let launch;
      try {
        launch = await launchV2Worker({
          objective,
          cursorClient: deps.cursorClient,
        });
      } catch (err) {
        const code =
          (err as V2RepositoryBindingError).code ===
          "V2_REPOSITORY_BINDING_FAILED"
            ? "FAILED_POLICY"
            : "FAILED_MACHINE";
        state = terminal(
          state,
          code,
          err instanceof Error ? err.message : String(err),
        );
        persistState(writer, state);
        break;
      }

      metrics.implementationWorkersCreated += 1;
      state = {
        ...state,
        workerRunsUsed: state.workerRunsUsed + 1,
        activeWorker: { agentId: launch.agentId, runId: launch.runId },
      };
      writer.writeWorkerRequest(state.iteration, launch.requestText);
      persistState(writer, state);

      let outcome: V2WorkerOutcome;
      try {
        outcome = await deps.obtainWorkerOutcome({
          agentId: launch.agentId,
          runId: launch.runId,
          iteration: state.iteration,
        });
      } catch (err) {
        state = terminal(
          state,
          "FAILED_MACHINE",
          err instanceof Error ? err.message : String(err),
        );
        persistState(writer, state);
        break;
      }

      writer.writeWorkerResult(state.iteration, outcome.narrative);
      state = {
        ...state,
        stage: "VERIFY",
        lastImplementationTipSha: outcome.implementationTipSha,
        lastImplementationBranch: outcome.implementationBranch,
        activeWorker: null,
      };
      persistState(writer, state);
      continue;
    }

    if (state.stage === "VERIFY") {
      const verifiedFacts = await deriveVerifiedGitFacts({
        repository: objective.repository,
        baseBranch: objective.baseBranch,
        startingSha: state.startingSha,
        implementationBranch: state.lastImplementationBranch ?? "",
        implementationTipSha: state.lastImplementationTipSha ?? "",
        expectedRepository: objective.repository,
        resolveRemoteBranchTip: deps.resolveRemoteBranchTip,
        verifyCommitAncestry: deps.verifyCommitAncestry,
        listChangedFiles: deps.listChangedFiles,
      });

      state = {
        ...state,
        lastVerifiedFacts: verifiedFacts,
        stage: "DECIDE",
      };
      writer.writeVerifiedFacts(state.iteration, verifiedFacts);
      persistState(writer, state);
      continue;
    }

    if (state.stage === "DECIDE") {
      const verifiedFacts = state.lastVerifiedFacts!;
      const workerReported = parseWorkerNarrative(
        (await readWorkerNarrative(writer, state.iteration)) ?? "",
      );

      const scopeGate = evaluateProductScopeGate({
        objective,
        verifiedFacts,
        workerClaimsProductBehaviorChanged:
          workerReported.productBehaviorChanged,
      });

      const hardFailures: string[] = [];
      if (!verifiedFacts.repositoryBindingOk) {
        hardFailures.push("repository binding");
      }
      if (objective.publicationRequired) {
        if (!verifiedFacts.freshCommit) {
          hardFailures.push("no fresh commit");
        }
        if (!verifiedFacts.isAncestorStartingToImplementation) {
          hardFailures.push("ancestry failed");
        }
      }

      const packet = buildDecisionPacket({
        objective,
        startingSourceIdentity: {
          repository: objective.repository,
          baseBranch: objective.baseBranch,
          startingSha: state.startingSha,
        },
        authorizedScope: {
          workTypes: objective.authorizedWorkTypes,
          publicationRequired: objective.publicationRequired,
          humanApprovalBoundaries: objective.humanApprovalBoundaries,
        },
        verifiedFacts,
        workerNarrative: workerReported.narrative,
        workerReported,
        changedFiles: verifiedFacts.changedFiles,
        contradictions: verifiedFacts.contradictions,
        iteration: state.iteration,
        workerRunsUsed: state.workerRunsUsed,
        maxWorkerRuns,
        hardRuleFailures: hardFailures,
      });

      const solDecision = await deps.solClient.decide(packet);
      writer.writeDecision(state.iteration, solDecision);
      state = { ...state, lastSolDecision: solDecision };

      const outcome = resolveDecideOutcome({
        solDecision,
        verifiedFacts,
        objective,
        scopeGate,
        workerRunsUsed: state.workerRunsUsed,
        maxWorkerRuns,
      });

      if (outcome.nextStage === "DONE") {
        const hardGate = evaluateHardGate({
          verifiedFacts,
          publicationRequired: objective.publicationRequired,
          solRecommendsAccept: solDecision.action === "ACCEPT",
        });
        if (!hardGate.pass) {
          state = terminal(
            state,
            "FAILED_POLICY",
            `hard gate failed: ${hardGate.failures.join("; ")}`,
          );
        } else {
          state = terminal(state, "DONE", "accepted");
        }
        persistState(writer, state);
        break;
      }

      if (outcome.nextStage === "HUMAN") {
        metrics.humanMessagesAfterLaunch += 1;
        state = terminal(state, "HUMAN", outcome.reason ?? "human judgment required");
        persistState(writer, state);
        break;
      }

      if (outcome.nextStage === "FAILED_POLICY") {
        state = terminal(state, "FAILED_POLICY", outcome.reason ?? "policy failure");
        persistState(writer, state);
        break;
      }

      if (outcome.nextStage === "FAILED_MACHINE") {
        state = terminal(state, "FAILED_MACHINE", outcome.reason ?? "machine failure");
        persistState(writer, state);
        break;
      }

      if (outcome.nextStage === "WORK") {
        if (state.workerRunsUsed >= maxWorkerRuns) {
          state = terminal(
            state,
            "FAILED_POLICY",
            `maxWorkerRuns (${maxWorkerRuns}) exhausted before CONTINUE_WORK`,
          );
          persistState(writer, state);
          break;
        }
        state = {
          ...state,
          stage: "WORK",
          iteration: state.iteration + 1,
          lastImplementationTipSha: null,
          lastImplementationBranch: null,
          lastVerifiedFacts: null,
        };
        persistState(writer, state);
        continue;
      }

      // VERIFY_MORE — re-verify without new worker
      state = { ...state, stage: "VERIFY" };
      persistState(writer, state);
      continue;
    }
  }

  const summary = buildSummary(state, metrics);
  writer.writeSummary(summary);
  return { state, summary, runDir };
}

async function readWorkerNarrativeForIteration(
  writer: V2ArtifactWriter,
  iteration: number,
): Promise<string | null> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const iterPath = path.join(
    writer.runDir,
    "iterations",
    String(iteration).padStart(2, "0"),
    "worker-result.txt",
  );
  if (fs.existsSync(iterPath)) {
    return fs.readFileSync(iterPath, "utf8");
  }
  return null;
}

async function readWorkerNarrative(
  writer: V2ArtifactWriter,
  iteration: number,
): Promise<string | null> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const iterPath = path.join(
    writer.runDir,
    "iterations",
    String(iteration).padStart(2, "0"),
    "worker-result.txt",
  );
  const rootPath = path.join(writer.runDir, "worker-result.txt");
  if (fs.existsSync(iterPath)) {
    return fs.readFileSync(iterPath, "utf8");
  }
  if (fs.existsSync(rootPath)) {
    return fs.readFileSync(rootPath, "utf8");
  }
  return null;
}

function resolveDecideOutcome(input: {
  solDecision: V2SolDecision;
  verifiedFacts: V2VerifiedFacts;
  objective: V2Objective;
  scopeGate: { requiresHuman: boolean; reason: string | null };
  workerRunsUsed: number;
  maxWorkerRuns: number;
}): {
  nextStage: V2Stage | V2TerminalOutcome | "WORK";
  reason?: string;
} {
  const { solDecision, verifiedFacts, objective, scopeGate } = input;

  if (scopeGate.requiresHuman) {
    return { nextStage: "HUMAN", reason: scopeGate.reason ?? undefined };
  }

  switch (solDecision.action) {
    case "ACCEPT":
      return { nextStage: "DONE" };
    case "ASK_HUMAN":
      return {
        nextStage: "HUMAN",
        reason: solDecision.rationale,
      };
    case "FAIL":
      return {
        nextStage: "FAILED_POLICY",
        reason: solDecision.rationale,
      };
    case "CONTINUE_WORK":
    case "WORK":
      if (input.workerRunsUsed >= input.maxWorkerRuns) {
        return {
          nextStage: "FAILED_POLICY",
          reason: `maxWorkerRuns (${input.maxWorkerRuns}) exhausted`,
        };
      }
      return { nextStage: "WORK" };
    case "VERIFY_MORE":
      return { nextStage: "VERIFY" };
    default:
      return {
        nextStage: "FAILED_MACHINE",
        reason: `unknown Sol action: ${solDecision.action}`,
      };
  }
}

export async function resumeV2Loop(
  deps: Omit<V2OrchestratorDeps, "resumeState"> & { runDir: string },
): Promise<V2RunResult> {
  const saved = loadRunState(deps.runDir);
  if (!saved) {
    throw new Error(`no run state found in ${deps.runDir}`);
  }
  return runV2Loop({ ...deps, resumeState: saved });
}

export { V2SourcePinError } from "./source.js";
