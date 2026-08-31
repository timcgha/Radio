/**
 * Parse unstructured worker narrative into reported facts.
 * Worker prose is evidence — not authoritative Radio state.
 */

import type { V2WorkerReportedFacts } from "./types.js";

export function parseWorkerNarrative(narrative: string): V2WorkerReportedFacts {
  const text = narrative.trim();
  const lower = text.toLowerCase();

  const testsPassed =
    /\btests?\s+passed\b/i.test(text) ||
    /\b\d+\s+tests?\s+passed\b/i.test(text)
      ? true
      : /\btests?\s+failed\b/i.test(text)
        ? false
        : null;

  const buildPassed =
    /\bbuild\s+passed\b/i.test(text) || /\bbuild\s+ok\b/i.test(text)
      ? true
      : /\bbuild\s+failed\b/i.test(text)
        ? false
        : null;

  let productBehaviorChanged: boolean | null = null;
  if (
    /\bno\s+product\s+behavior\s+change/i.test(text) ||
    /\btest[- ]only\b/i.test(text)
  ) {
    productBehaviorChanged = false;
  } else if (/\bproduct\s+behavior\s+changed\b/i.test(text)) {
    productBehaviorChanged = true;
  }

  const branchMatch =
    text.match(/\bbranch\s+([^\s]+)/i) ??
    text.match(/\bpushed\s+branch\s+([^\s]+)/i);
  const claimedBranch = branchMatch?.[1]?.replace(/[.,;]+$/, "") ?? null;

  const shaMatch =
    text.match(/\bat\s+([0-9a-f]{40})\b/i) ??
    text.match(/\bcommit\s+([0-9a-f]{40})\b/i) ??
    text.match(/\b([0-9a-f]{40})\b/i);
  const claimedCommit = shaMatch?.[1]?.toLowerCase() ?? null;

  return {
    narrative: text,
    testsPassed,
    buildPassed,
    productBehaviorChanged,
    claimedBranch,
    claimedCommit,
  };
}
