/**
 * Phase 2 strict completion-report extraction.
 *
 * Normative contract (CURSOR-COMPLETION-REPORT-CONTRACT.md §20 + work-order
 * finalReportFormat EXACTLY_ONE_FENCED_TEXT_BLOCK_NOTHING_BEFORE_OR_AFTER):
 * the entire final completion report must be inside exactly one fenced `text`
 * code block, with nothing before or after. Outer whitespace trim is permitted
 * so CRLF/trailing newline from API transport does not invalidate.
 *
 * Fence body is parsed as JSON matching cursor-completion-report.schema.json.
 * No repair, no inference, no prose salvage.
 */

export type CompletionExtractCode =
  | "OK"
  | "EMPTY_RAW"
  | "PROSE_OUTSIDE_FENCE"
  | "ZERO_TEXT_FENCES"
  | "MULTIPLE_TEXT_FENCES"
  | "MALFORMED_FENCE"
  | "NESTED_FENCE"
  | "JSON_PARSE_FAILED"
  | "JSON_NOT_OBJECT";

export interface CompletionExtractResult {
  ok: boolean;
  code: CompletionExtractCode;
  summary: string;
  report: Record<string, unknown> | null;
  fenceBody: string | null;
}

/**
 * Extract and JSON-parse exactly one completion report from raw Cursor result text.
 */
export function extractCompletionReport(raw: string): CompletionExtractResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return fail("EMPTY_RAW", "Raw Cursor result is empty");
  }

  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return fail("EMPTY_RAW", "Raw Cursor result is whitespace-only");
  }

  const fenceOpens = countTextFenceOpens(trimmed);
  if (fenceOpens === 0) {
    return fail("ZERO_TEXT_FENCES", "No fenced text completion report found");
  }
  if (fenceOpens > 1) {
    return fail(
      "MULTIPLE_TEXT_FENCES",
      `Expected exactly one text fence; found ${fenceOpens}`,
    );
  }

  const fullMatch = trimmed.match(
    /^```text[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/,
  );
  if (!fullMatch) {
    if (!trimmed.startsWith("```text")) {
      return fail(
        "PROSE_OUTSIDE_FENCE",
        "Content before the required text fence is prohibited",
      );
    }
    if (!/\r?\n```[ \t]*$/.test(trimmed)) {
      return fail(
        "PROSE_OUTSIDE_FENCE",
        "Content after the required text fence is prohibited, or fence is unclosed",
      );
    }
    return fail("MALFORMED_FENCE", "Malformed text fence structure");
  }

  const fenceBody = fullMatch[1] ?? "";
  if (/```/.test(fenceBody)) {
    return fail(
      "NESTED_FENCE",
      "Nested fences inside the completion report are prohibited",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceBody);
  } catch (err) {
    return fail(
      "JSON_PARSE_FAILED",
      `Completion report fence body is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("JSON_NOT_OBJECT", "Completion report JSON must be an object");
  }

  return {
    ok: true,
    code: "OK",
    summary: "Extracted exactly one fenced text completion report as JSON",
    report: parsed as Record<string, unknown>,
    fenceBody,
  };
}

function countTextFenceOpens(text: string): number {
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (/^```text[ \t]*$/.test(line)) {
      count += 1;
    }
  }
  return count;
}

function fail(
  code: CompletionExtractCode,
  summary: string,
): CompletionExtractResult {
  return {
    ok: false,
    code,
    summary,
    report: null,
    fenceBody: null,
  };
}
