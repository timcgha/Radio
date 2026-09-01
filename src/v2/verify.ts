/**
 * V2 deterministic Git fact verification.
 *
 * startingSha and implementationTipSha are distinct identities.
 * Never compare them for equality after implementation.
 */

import {
  commitShasMatch,
  type ResolveRemoteBranchTip,
} from "../cursor/source-ref.js";
import {
  verifyCommitAncestryViaGitFetch,
  verifyRemoteBranchTipExact,
  verifyRemoteCommitExists,
  type VerifyCommitAncestry,
} from "../cursor/remote-publication-verify.js";
import type { V2VerifiedFacts } from "./types.js";
import { nowIso } from "../util/io.js";

export interface V2GitVerificationInput {
  repository: string;
  baseBranch: string;
  startingSha: string;
  implementationBranch: string;
  implementationTipSha: string;
  expectedRepository: string;
  resolveRemoteBranchTip: ResolveRemoteBranchTip;
  verifyCommitAncestry?: VerifyCommitAncestry;
  listChangedFiles?: (input: {
    repositoryUrl: string;
    baseSha: string;
    tipSha: string;
  }) => Promise<string[]>;
}

export async function deriveVerifiedGitFacts(
  input: V2GitVerificationInput,
): Promise<V2VerifiedFacts> {
  const startingSha = input.startingSha.trim().toLowerCase();
  const implementationTipSha = input.implementationTipSha.trim().toLowerCase();
  const implementationBranch = input.implementationBranch.trim();
  const contradictions: string[] = [];

  const repositoryBindingOk =
    input.repository.trim() === input.expectedRepository.trim();
  if (!repositoryBindingOk) {
    contradictions.push(
      `repository mismatch: worker target ${input.repository} != authorized ${input.expectedRepository}`,
    );
  }

  let remoteBranchExists = false;
  let implementationTipRemoteExists = false;
  let resolvedRemoteTip: string | null = null;

  if (repositoryBindingOk && implementationBranch) {
    try {
      const branchResult = await verifyRemoteBranchTipExact({
        repositoryUrl: input.repository,
        branch: implementationBranch,
        expectedTipSha: implementationTipSha,
        resolveRemoteBranchTip: input.resolveRemoteBranchTip,
      });
      remoteBranchExists = branchResult.ok;
      if (branchResult.ok) {
        resolvedRemoteTip = branchResult.remoteBranchTip ?? implementationTipSha;
        implementationTipRemoteExists = true;
      } else {
        contradictions.push(branchResult.summary);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      contradictions.push(`remote branch verification failed: ${message}`);
    }
  }

  if (
    repositoryBindingOk &&
    !implementationTipRemoteExists &&
    implementationTipSha
  ) {
    const exists = await verifyRemoteCommitExists({
      repositoryUrl: input.repository,
      commitSha: implementationTipSha,
    });
    implementationTipRemoteExists = exists;
    if (!exists) {
      contradictions.push(
        `implementation tip ${implementationTipSha} not found on remote`,
      );
    }
  }

  const startingShaEqualsImplementationTip = commitShasMatch(
    startingSha,
    implementationTipSha,
  );

  let isAncestorStartingToImplementation = false;
  if (startingShaEqualsImplementationTip) {
    isAncestorStartingToImplementation = true;
  } else if (repositoryBindingOk) {
    const verifyAncestry =
      input.verifyCommitAncestry ?? verifyCommitAncestryViaGitFetch;
    isAncestorStartingToImplementation = await verifyAncestry({
      repositoryUrl: input.repository,
      ancestorSha: startingSha,
      descendantSha: implementationTipSha,
    });
    if (!isAncestorStartingToImplementation) {
      contradictions.push(
        `startingSha ${startingSha} is not an ancestor of implementationTipSha ${implementationTipSha}`,
      );
    }
  }

  const freshCommit = !startingShaEqualsImplementationTip;
  if (!freshCommit) {
    contradictions.push(
      "implementation tip equals starting SHA — no fresh commit",
    );
  }

  let changedFiles: string[] = [];
  if (
    repositoryBindingOk &&
    input.listChangedFiles &&
    !startingShaEqualsImplementationTip &&
    isAncestorStartingToImplementation
  ) {
    try {
      changedFiles = await input.listChangedFiles({
        repositoryUrl: input.repository,
        baseSha: startingSha,
        tipSha: implementationTipSha,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      contradictions.push(`changed-files derivation failed: ${message}`);
    }
  }

  const publicationAvailable =
    remoteBranchExists &&
    implementationTipRemoteExists &&
    freshCommit &&
    isAncestorStartingToImplementation;

  return {
    repository: input.repository,
    baseBranch: input.baseBranch,
    startingSha,
    resolvedBaseSha: startingSha,
    implementationBranch: implementationBranch || null,
    implementationTipSha: implementationTipSha || null,
    remoteBranchExists,
    implementationTipRemoteExists,
    freshCommit,
    startingShaEqualsImplementationTip,
    isAncestorStartingToImplementation,
    changedFiles,
    publicationAvailable,
    repositoryBindingOk,
    contradictions,
    verifiedAt: nowIso(),
  };
}

export function evaluateHardGate(input: {
  verifiedFacts: V2VerifiedFacts;
  publicationRequired: boolean;
  solRecommendsAccept: boolean;
}): { pass: boolean; failures: string[] } {
  const failures: string[] = [];

  if (!input.verifiedFacts.repositoryBindingOk) {
    failures.push("repository binding failed");
  }

  if (input.publicationRequired) {
    if (!input.verifiedFacts.remoteBranchExists) {
      failures.push("remote implementation branch missing");
    }
    if (!input.verifiedFacts.implementationTipRemoteExists) {
      failures.push("implementation tip not on remote");
    }
    if (!input.verifiedFacts.freshCommit) {
      failures.push("no fresh commit beyond starting SHA");
    }
    if (!input.verifiedFacts.isAncestorStartingToImplementation) {
      failures.push("starting SHA is not ancestor of implementation tip");
    }
    if (!input.verifiedFacts.publicationAvailable) {
      failures.push("publication not available");
    }
  }

  if (input.verifiedFacts.contradictions.length > 0) {
    failures.push(...input.verifiedFacts.contradictions);
  }

  if (!input.solRecommendsAccept) {
    failures.push("Sol has not recommended ACCEPT");
  }

  return { pass: failures.length === 0, failures };
}

/** Regression case: Bellhop starting vs implementation tip — valid descendant. */
export const BELLHOP_REGRESSION_STARTING_SHA =
  "38ba91802817cc63d8fccdcab71ef0a400b7483b";
export const BELLHOP_REGRESSION_IMPLEMENTATION_TIP_SHA =
  "b5480ae90117d676d349a1da97b06ccb75e66dfd";
