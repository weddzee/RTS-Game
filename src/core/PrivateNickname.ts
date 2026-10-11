// Nickname rules for the private-lobby build (Prompt 1).
//
// Requirements: 1-20 visible characters, surrounding whitespace trimmed,
// HTML-safe, ordinary Unicode, server authoritative over the accepted value.
//
// This validator is deliberately separate from validateUsername()
// (src/core/validations/username.ts), which enforces the upstream minimum
// of 3 characters for the account flow. That flow is untouched; this one
// serves the no-account private-lobby path.
//
// HTML safety comes from the charset, not from escaping at validation
// time: only RENDERABLE_NAME_CHARS (letters incl. Latin-1 Supplement,
// digits, space, underscore, hyphen, period) are accepted, so <>&"'/ and
// control characters can never enter a nickname. Rendering layers must
// still use safe interpolation (Lit ${} auto-escapes) and never inject
// nicknames via innerHTML.
//
// Error values are stable codes, not translated strings, so this module
// stays free of client i18n imports. The menu maps codes to
// private_menu.nickname_error_* strings.

import { RENDERABLE_NAME_CHARS, RENDERABLE_NAME_HAS_ALNUM_RE } from "./Schemas";

export const PRIVATE_NICKNAME_MAX = 20;

export type PrivateNicknameError =
  | "blank"
  | "too_long"
  | "invalid_chars"
  | "no_alnum";

const PRIVATE_NICKNAME_PATTERN = new RegExp(
  `^[${RENDERABLE_NAME_CHARS}]+$`,
  "u",
);

export interface PrivateNicknameResult {
  isValid: boolean;
  /** Trimmed, accepted nickname. Present only when isValid. */
  value?: string;
  error?: PrivateNicknameError;
}

/** Counted in Unicode code points so emoji-free astral chars count once. */
export function privateNicknameLength(value: string): number {
  return [...value].length;
}

export function validatePrivateNickname(raw: unknown): PrivateNicknameResult {
  if (typeof raw !== "string") return { isValid: false, error: "blank" };
  const value = raw.trim();
  if (value.length === 0) return { isValid: false, error: "blank" };
  if (privateNicknameLength(value) > PRIVATE_NICKNAME_MAX) {
    return { isValid: false, error: "too_long" };
  }
  if (!PRIVATE_NICKNAME_PATTERN.test(value)) {
    return { isValid: false, error: "invalid_chars" };
  }
  if (!RENDERABLE_NAME_HAS_ALNUM_RE.test(value)) {
    return { isValid: false, error: "no_alnum" };
  }
  return { isValid: true, value };
}
