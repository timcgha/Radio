/**
 * V2 source identity — trusted starting pin before worker creation.
 */

import {
  commitShasMatch,
  type ResolveRemoteBranchTip,
  verifyRemoteSourceRef,
  type SourceRefVerification,
} from "../cursor/source-ref.js";
import type { V2Objective } from "./types.js";

export class V2SourcePinError extends Error {
  readonly code = "V2_SOURCE_PIN_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "V2SourcePinError";
  }
}

export interface V2SourceResolution {
  repository: string;
  baseBranch: string;
  startingSha: string;
  resolvedBaseSha: string;
  verifiedAt: string;
}

export async function verifyStartingSource(input: {
  objective: V2Objective;
  resolveRemoteBranchTip: ResolveRemoteBranchTip;
  nowIso?: () => string;
}): Promise<V2SourceResolution> {
  const { objective } = input;
  const startingSha = objective.expectedStartingSha.trim().toLowerCase();

  let verification: SourceRefVerification;
  try {
    verification = await verifyRemoteSourceRef({
      intent: {
        repository: objective.repository,
        expectedCommitSha: startingSha,
        transportStartingRef: objective.baseBranch,
      },
      resolveRemoteBranchTip: input.resolveRemoteBranchTip,
      nowIso: input.nowIso,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new V2SourcePinError(
      `Starting source pin failed: ${message}`,
    );
  }

  if (!commitShasMatch(verification.remoteResolvedSha, startingSha)) {
    throw new V2SourcePinError(
      `resolvedBaseSha ${verification.remoteResolvedSha} != expectedStartingSha ${startingSha}`,
    );
  }

  return {
    repository: objective.repository,
    baseBranch: objective.baseBranch,
    startingSha,
    resolvedBaseSha: verification.remoteResolvedSha,
    verifiedAt: verification.sourceRefVerifiedAt,
  };
}
