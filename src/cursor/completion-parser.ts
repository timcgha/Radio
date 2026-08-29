/**
 * Extract Radio completion reports from Cursor agent conversation output.
 *
 * Contract: the entire final completion report must be inside exactly one
 * fenced `text` code block — nothing before/after in the worker's final message.
 * In practice the conversation may contain earlier assistant turns; we take the
 * last assistant message that contains a ```text fence, or the last ```text
 * fence in the conversation.
 */

export interface ParsedCompletionEnvelope {
  fencedText: string;
  reportJson: unknown;
  sourceMessageId: string | null;
}

export class CompletionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionParseError";
  }
}

const TEXT_FENCE_RE = /```text\s*\n([\s\S]*?)\n```/gi;

export function extractLastTextFence(content: string): string | null {
  let last: string | null = null;
  TEXT_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEXT_FENCE_RE.exec(content)) !== null) {
    last = match[1]!;
  }
  return last;
}

/**
 * Parse JSON from fenced text. Accepts either:
 * - a JSON object body; or
 * - a text report that itself contains a ```json fence; or
 * - key=value style is NOT accepted (must be JSON for schema validation).
 */
export function parseReportJsonFromFencedText(fencedText: string): unknown {
  const trimmed = fencedText.trim();
  if (!trimmed) {
    throw new CompletionParseError("Empty fenced text block");
  }

  // Prefer nested json fence if present.
  const jsonFence = /```json\s*\n([\s\S]*?)\n```/i.exec(trimmed);
  const candidate = jsonFence ? jsonFence[1]!.trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch (err) {
    // Some workers wrap JSON in a prose header inside the text fence.
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch {
        // fall through
      }
    }
    throw new CompletionParseError(
      `Fenced completion text is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function parseCompletionFromConversation(input: {
  messages: Array<{ id?: string; type?: string; text?: string }>;
}): ParsedCompletionEnvelope {
  const assistantMessages = input.messages.filter(
    (m) =>
      typeof m.text === "string" &&
      (m.type === "assistant_message" ||
        m.type === "assistant" ||
        !m.type ||
        String(m.type).toLowerCase().includes("assistant")),
  );

  // Prefer last assistant message that contains a text fence.
  for (let i = assistantMessages.length - 1; i >= 0; i -= 1) {
    const msg = assistantMessages[i]!;
    const fence = extractLastTextFence(msg.text!);
    if (fence !== null) {
      return {
        fencedText: fence,
        reportJson: parseReportJsonFromFencedText(fence),
        sourceMessageId: msg.id ?? null,
      };
    }
  }

  // Fallback: scan entire conversation.
  const joined = input.messages
    .map((m) => m.text ?? "")
    .filter(Boolean)
    .join("\n\n");
  const fence = extractLastTextFence(joined);
  if (fence === null) {
    throw new CompletionParseError(
      "No ```text fenced completion report found in Cursor conversation",
    );
  }
  return {
    fencedText: fence,
    reportJson: parseReportJsonFromFencedText(fence),
    sourceMessageId: null,
  };
}
