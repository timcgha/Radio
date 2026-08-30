/**
 * Deterministic scope-text parsing shared by policy and objective authority.
 *
 * Strips prohibition / boundary language so phrases listed as forbidden do not
 * false-positive as affirmative activation.
 */

/** Normalize markdown/plain list prefixes before prohibition matching. */
export function stripLeadingListMarker(line: string): string {
  return line
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

/**
 * Parse a colon-terminated section heading.
 * Returns heading label + optional same-line body, or null when not header-shaped.
 */
export function parseColonSectionHeader(
  line: string,
): { heading: string; rest: string } | null {
  const stripped = stripLeadingListMarker(line);
  const match = stripped.match(/^([^:\n]{1,100}):\s*(.*)$/);
  if (!match) return null;
  const heading = match[1]!.trim();
  if (!heading) return null;
  // Reject sentence-like left sides (not section labels).
  if (/[.!?]/.test(heading)) return null;
  return { heading, rest: (match[2] ?? "").trim() };
}

/**
 * Normalize a heading label for semantic prohibition classification.
 */
export function normalizeHeadingLabel(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a colon-terminated heading's meaning is clearly prohibitive /
 * non-actionable (guardrail section), not a request for work.
 *
 * Matches composite labels such as "PROHIBITED SCOPE AND ACTIONS" without
 * requiring exact full-string equality. Does not treat bare "scope" /
 * "actions" / "requirements" / "constraints" as prohibitive on their own.
 */
export function isProhibitiveHeadingMeaning(heading: string): boolean {
  const n = normalizeHeadingLabel(heading);
  if (!n) return false;

  if (/\bout of scope\b/.test(n)) return true;
  if (/\bnot permitted\b/.test(n)) return true;
  if (/\bnot allowed\b/.test(n)) return true;
  if (/\bdo not\b/.test(n) || /\bdon t\b/.test(n) || /\bdont\b/.test(n)) {
    return true;
  }
  if (/\bmust not\b/.test(n)) return true;
  if (/\bshall not\b/.test(n)) return true;
  if (/\bhard prohibitions?\b/.test(n)) return true;

  if (/\bprohibited\b/.test(n)) return true;
  if (/\bforbidden\b/.test(n)) return true;
  if (/\bexcluded\b/.test(n)) return true;
  if (/\bdeferred\b/.test(n)) return true;
  if (/\bnever\b/.test(n)) return true;

  return false;
}

/** Headers whose following lines describe forbidden / deferred scope, not work to do. */
export function isNonActionableSectionHeader(line: string): boolean {
  const parsed = parseColonSectionHeader(line);
  if (!parsed) return false;
  return isProhibitiveHeadingMeaning(parsed.heading);
}

/** Headers that end an out-of-scope / prohibition block. */
export function isActionableSectionHeader(line: string): boolean {
  const parsed = parseColonSectionHeader(line);
  const label = parsed?.heading ?? stripLeadingListMarker(line);
  return /^(in scope|in-scope|requirements|objective|tasks?|steps?|acceptance|budgets?|protected semantics|authorized work|implementation)\b/i.test(
    label,
  );
}

/**
 * Imperative / bypass-shaped lines that must exit a prohibitive section so
 * later affirmative work is not swallowed by an earlier guardrail header.
 *
 * Short noun-phrase listings under a prohibitive heading ("merge PR",
 * "Stage 4", "production deploy") remain non-actionable section body.
 */
export function looksLikeActionableInstruction(line: string): boolean {
  const text = stripLeadingListMarker(line).replace(/[.]+$/, "").trim();
  if (!text) return false;
  if (isActionableSectionHeader(text)) return true;
  if (
    /^(ignore|disregard|override|bypass|nevertheless|however|instead)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  const words = text.split(/\s+/).filter(Boolean);
  // Bare guardrail phrases stay inside the prohibitive section.
  if (
    words.length <= 3 &&
    !/\b(anyway|now|immediately|please|must|should|this|resulting)\b/i.test(
      text,
    )
  ) {
    return false;
  }

  if (
    /^(deploy|merge|merging|migrate|implement|start|perform|execute|run|create|push|ship|release|publish|delete|drop|alter|modify|change|update|upgrade|downgrade|install|remove|add|begin|launch|authorize|approve|build|proceed|after|then)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

/** Split multi-clause lines so mid-sentence guardrails can be filtered independently. */
export function splitScopeClauses(line: string): string[] {
  return line.split(/\s*[;.](?:\s+|$)/).filter((part) => part.trim().length > 0);
}

const INLINE_NEGATION =
  /\b(do not|don't|dont|must not|shall not|may not|cannot|can't|never|not permitted)\b/gi;

/**
 * Remove inline negated deferred-scope spans from mixed clauses, e.g.
 * "verify stage 2 and do not start stage 3".
 */
export function stripInlineNegatedDeferredMentions(clause: string): string {
  return clause
    .replace(
      /\b(do not|don't|must not|shall not|never)\b[^.!?\n;]{0,120}?\bstage\s*3\b/gi,
      " ",
    )
    .replace(
      /\b(do not|don't|must not|shall not|never)\b[^.!?\n;]{0,120}?\b(star\s*beam|flight\s+retune|retune\s+flight)\b/gi,
      " ",
    )
    .replace(/\bwithout\b[^.!?\n;]{0,80}?\bstage\s*3\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Remove inline negated spans for a generic prohibited phrase inside mixed clauses.
 */
export function stripInlineNegatedPhraseMentions(
  clause: string,
  phrase: string,
): string {
  const tokens = phrase
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => escapeRegExp(token));
  if (tokens.length === 0) return clause.trim();

  const phrasePattern =
    tokens.length === 1 ? tokens[0]! : tokens.join("\\s+");
  const negatedSpan = new RegExp(
    `${INLINE_NEGATION.source}[^.!?\\n;]{0,120}?${phrasePattern}`,
    "gi",
  );
  return clause.replace(negatedSpan, " ").replace(/\s+/g, " ").trim();
}

/**
 * True when a clause is a prohibition or a non-activating boundary description
 * of deferred work (not an instruction to begin that work).
 */
export function isProhibitionOrBoundaryClause(clause: string): boolean {
  if (
    /^(do not|don't|must not|shall not|may not|cannot|can't|never|forbid|forbidden|prohibited|strictly forbidden|not permitted|out of scope|hard prohibition|without|excluded|deferred)\b/i.test(
      clause,
    )
  ) {
    return true;
  }
  if (/\b(without|forbids?|prohibiting|is forbidden|are forbidden)\b/i.test(clause)) {
    return true;
  }
  if (
    /\b(out of scope|remains deferred|is deferred|not (?:currently )?in scope|forbidden|prohibited|not (?:authorized|permitted|allowed)|requires (?:future )?human approval|pending human approval)\b/i.test(
      clause,
    )
  ) {
    return true;
  }
  if (/^no\s+stage\s*3\b/i.test(clause)) return true;
  if (isHumanReviewGuardrailClause(clause)) return true;
  return false;
}

/** Guardrails that mention merge/deploy only as pre-human-review boundaries. */
export function isHumanReviewGuardrailClause(clause: string): boolean {
  return (
    /\bstop for human review\b/i.test(clause) ||
    /\bhalt for human review\b/i.test(clause) ||
    /\bawait human review\b/i.test(clause) ||
    /\bpending human review\b/i.test(clause) ||
    /\bbefore (?:merge|deployment|deploy|production deploy|automatic merge|automatic deployment)\b/i.test(
      clause,
    ) ||
    /\bbefore merge or (?:deployment|deploy|production deploy)\b/i.test(clause)
  );
}

/**
 * Strip prohibition / boundary language so phrases like
 * "do not retune flight" or "without merge" do not false-positive
 * as activation of deferred/human-gated work.
 *
 * Shared by objective-authority prohibited-scope matching and P4 human-gated
 * action matching — both reason over this same actionable-text view.
 */
export function actionableScopeText(scopeText: string): string {
  const kept: string[] = [];
  let inNonActionableSection = false;

  for (const rawLine of scopeText.split(/\n+/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const header = stripLeadingListMarker(trimmed);
    if (isNonActionableSectionHeader(header)) {
      // Entire line (heading + optional same-line guardrail body) is non-actionable.
      inNonActionableSection = true;
      continue;
    }
    if (inNonActionableSection) {
      if (isActionableSectionHeader(header)) {
        inNonActionableSection = false;
      } else if (isNonActionableSectionHeader(header)) {
        continue;
      } else if (/^[-*•]/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
        // List body under a prohibitive heading remains non-actionable.
        continue;
      } else if (looksLikeActionableInstruction(trimmed)) {
        // Affirmative / bypass instructions exit the guardrail section.
        inNonActionableSection = false;
      } else {
        // Non-bulleted guardrail body (e.g. semicolon lists) stays non-actionable
        // until an actionable header or imperative line.
        continue;
      }
    }
    if (inNonActionableSection) continue;

    const line = stripLeadingListMarker(trimmed);
    if (!line) continue;

    for (const clause of splitScopeClauses(line)) {
      const clauseText = clause.trim();
      if (!clauseText) continue;
      if (isProhibitionOrBoundaryClause(clauseText)) continue;
      const cleaned = stripInlineNegatedDeferredMentions(clauseText);
      if (!cleaned) continue;
      kept.push(cleaned);
    }
  }

  return kept.join("\n");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ACTION_VERB =
  /^(deploy|merge|migrate|implement|start|perform|execute|run|create|push|ship|release|publish|delete|drop|alter|modify|change|update|upgrade|downgrade|install|remove|add|begin|launch|authorize|approve)$/i;

/**
 * Generic prohibited-phrase presence in a clause, including flexible token order
 * for action phrases (e.g. "production deploy" vs "deploy ... to production").
 */
export function clauseMatchesProhibitedPhrase(
  clause: string,
  phrase: string,
): boolean {
  const c = clause.toLowerCase();
  const needle = phrase.toLowerCase().trim();
  if (!needle) return false;
  if (c.includes(needle)) return true;

  const tokens = needle.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length < 2) return false;

  const escaped = tokens.map((token) => escapeRegExp(token));
  const forward = new RegExp(`\\b${escaped.join("\\b[\\s\\S]{0,80}?\\b")}\\b`, "i");
  if (forward.test(c)) return true;

  const endsWithActionVerb =
    ACTION_VERB.test(tokens[0]!) || ACTION_VERB.test(tokens[tokens.length - 1]!);
  if (!endsWithActionVerb) return false;

  const reverse = new RegExp(
    `\\b${[...escaped].reverse().join("\\b[\\s\\S]{0,80}?\\b")}\\b`,
    "i",
  );
  return reverse.test(c);
}

/**
 * True when actionable decision text affirmatively activates a prohibited scope phrase.
 * Fail-closed: a prohibited phrase in actionable non-prohibited text counts as activation.
 */
export function detectProhibitedScopeActivation(
  scopeText: string,
  prohibitedPhrase: string,
): boolean {
  const actionable = actionableScopeText(scopeText);
  if (!actionable.trim()) return false;

  for (const line of actionable.split(/\n+/)) {
    for (const clause of splitScopeClauses(line)) {
      let clauseText = clause.trim();
      if (!clauseText) continue;
      clauseText = stripInlineNegatedPhraseMentions(clauseText, prohibitedPhrase);
      if (!clauseText) continue;
      if (!clauseMatchesProhibitedPhrase(clauseText, prohibitedPhrase)) continue;
      if (isProhibitionOrBoundaryClause(clauseText)) continue;
      return true;
    }
  }

  return false;
}
