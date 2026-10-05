// Army naming (Prompt 3.2). Custom names are a headline feature — "1st Army",
// "Northern Army", "Class 11B Destroyers", whatever dumb names friends choose —
// so this file is deliberately permissive about *content* and strict about
// *safety*.
//
// Two separate jobs:
//
//  1. Validation/sanitizing. Names are player-supplied free text rendered as an
//     HTML text node, so markup can never execute (see the "no HTML" note in
//     `sanitizeArmyName`), but control characters, zero-width joiners and
//     bidi overrides are still rejected: they are invisible, they break
//     truncation on surrogate pairs, and bidi overrides are how a name gets to
//     render as something it is not.
//
//  2. Default names. When a player does not name an army the game picks one,
//     deterministically from the player's own army count so every client
//     generates the same string for the same game state.

export const ARMY_NAME_MIN_LENGTH = 1;
export const ARMY_NAME_MAX_LENGTH = 32;

/** Length is counted in code points, not UTF-16 units, so "⚔️⚔️" is 2. */
function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * Characters that are dropped wherever they appear in a name.
 *
 *  - C0/C1 controls and DEL: control the terminal/line layout, and a newline
 *    in a name breaks single-line HUD layout.
 *  - U+200B..U+200F, U+202A..U+202E, U+2060..U+2064, U+2066..U+206F, U+FEFF:
 *    zero-width and bidi formatting characters. Invisible in the panel but
 *    able to reorder how a name reads (trojan-source) or to pad it past the
 *    visible character budget.
 *  - U+FFF9..U+FFFB: interlinear annotation marks.
 */
const STRIPPED_CHARACTERS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f" +
    "\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f" +
    "\\ufeff\\ufff9-\\ufffb]",
  "g",
);

/**
 * Unicode spaces that `\s` does not cover, collapsed to a plain space so a
 * leading or trailing non-breaking space cannot survive as an invisible
 * character. Built from a string rather than a literal: the range spans code
 * points that some regex parsers treat as line terminators inside a class.
 */
const UNICODE_SPACES = new RegExp(
  "[\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]+",
  "g",
);

export type ArmyNameRejection =
  | "empty"
  | "tooLong"
  | "notAString"
  | "onlyStrippedCharacters";

export type ArmyNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: ArmyNameRejection };

/**
 * Reduce arbitrary input to a safe, renderable army name.
 *
 * Normalizes to NFC so visually identical names compare equal, drops the
 * stripped characters above, collapses runs of whitespace to single spaces,
 * trims, and truncates to ARMY_NAME_MAX_LENGTH code points on a code-point
 * boundary (so an emoji or a combining sequence is never cut in half).
 *
 * This is a sanitizer, not an escaper, and does not need to be one: every
 * consumer renders the name through Lit's `{{ }}`/text interpolation or a
 * canvas `fillText`, both of which write text and never parse markup. HTML
 * tags in a name therefore display as the literal characters the player typed
 * and cannot execute. Escaping here would show players `<b>` instead of `<b>`.
 */
export function sanitizeArmyName(raw: string): string {
  // NFC first: it composes sequences the length cap then measures.
  const normalized = raw.normalize("NFC");
  const stripped = normalized.replace(STRIPPED_CHARACTERS, "");
  // Unicode spaces (including non-breaking ones) collapse to a single plain
  // space first, so a name cannot start or end in an invisible character.
  const collapsed = stripped
    .replace(UNICODE_SPACES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateArmyName(collapsed);
}

/** Truncate to the cap on a code-point boundary. */
export function truncateArmyName(value: string): string {
  if (codePointLength(value) <= ARMY_NAME_MAX_LENGTH) return value;
  let out = "";
  let count = 0;
  for (const ch of value) {
    if (count >= ARMY_NAME_MAX_LENGTH) break;
    out += ch;
    count++;
  }
  // A trailing combining mark or a zero-width joiner left behind by the cut
  // renders as nothing; drop anything that is not a base character so the
  // truncated name does not look clipped.
  return out.trimEnd();
}

/**
 * Validate a rename. `sanitizeArmyName` first, then require that something is
 * left: a name made entirely of stripped characters is a rejection, not an
 * empty army name. Callers that need to know whether the player's exact input
 * survived can compare the result with the sanitized input.
 */
export function validateArmyName(raw: unknown): ArmyNameResult {
  if (typeof raw !== "string") return { ok: false, reason: "notAString" };
  const sanitized = sanitizeArmyName(raw);
  if (codePointLength(sanitized) < ARMY_NAME_MIN_LENGTH) {
    // Distinguish "typed nothing" from "typed only invisible characters" so
    // the UI can say which, but both are rejections.
    return {
      ok: false,
      reason:
        sanitized.length === 0 && raw.trim().length > 0
          ? "onlyStrippedCharacters"
          : "empty",
    };
  }
  return { ok: true, name: sanitized };
}

const ORDINAL_SUFFIXES = ["th", "st", "nd", "rd"] as const;

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th", 21 -> "21st". */
export function ordinal(n: number): string {
  if (!Number.isInteger(n) || n <= 0) return `${Math.max(0, Math.floor(n))}th`;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const suffix = ORDINAL_SUFFIXES[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * The generated name for an army the player did not name: "1st Army", "2nd
 * Army", ... A player can always rename afterwards, so the generated form only
 * has to be unambiguous, short and deterministic.
 *
 * `existing` is how many of the player's armies already exist; the new one is
 * the (existing + 1)th. Falls back to a plain count when a player's armies
 * have already passed the ordinal range, so a hundred armies still get unique
 * names.
 */
export function defaultArmyName(existing: number): string {
  const n = Math.max(1, Math.floor(existing) + 1);
  return n <= 99 ? `${ordinal(n)} Army` : `Army ${n}`;
}
