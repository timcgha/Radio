/**
 * Deterministic ledger summary bounding.
 * Full diagnostic detail belongs in run artifacts; ledger summaries must remain
 * schema-valid (maxLength 4000) and must never crash the error path.
 */

export const LEDGER_SUMMARY_MAX_LENGTH = 4000;

/**
 * Bound a ledger summary to the canonical schema maxLength.
 * Preserves a stable suffix reference when truncation occurs.
 */
export function boundLedgerSummary(
  summary: string,
  options?: { artifactRef?: string | null },
): string {
  const raw = typeof summary === "string" ? summary : String(summary ?? "");
  if (raw.length <= LEDGER_SUMMARY_MAX_LENGTH) {
    return raw.length > 0 ? raw : "ledger summary empty";
  }

  const ref =
    typeof options?.artifactRef === "string" && options.artifactRef.trim()
      ? options.artifactRef.trim()
      : null;
  const marker = ref
    ? `…[truncated; full detail in artifact: ${ref}]`
    : `…[truncated; originalLength=${raw.length}]`;

  const budget = LEDGER_SUMMARY_MAX_LENGTH - marker.length;
  if (budget <= 0) {
    return marker.slice(0, LEDGER_SUMMARY_MAX_LENGTH);
  }
  return `${raw.slice(0, budget)}${marker}`;
}
