// Match phases and normalized progress for the 10-20 minute game (Prompt 2).
//
// A match moves through four conceptual phases measured as normalized
// progress:
//
//   matchProgress = elapsedTicks / expectedTicks
//
// Phases are not UI labels only: progression, unlock and escalation
// systems read matchProgress (and the derived phase) to scale thresholds.
// All math is integer/rational and deterministic — a pure function of the
// tick count, so every client computes identical phases.

import { GameConfig } from "./Schemas";

export const TICKS_PER_SECOND = 10;

/** Standard-pacing match length in ticks (15 min). See MatchPacing. */
export const STANDARD_MATCH_TICKS = 15 * 60 * TICKS_PER_SECOND;

export type MatchPhase = "opening" | "contact" | "midgame" | "endgame";

export const MATCH_PHASES: readonly MatchPhase[] = [
  "opening",
  "contact",
  "midgame",
  "endgame",
];

/** Phase boundaries as progress fractions: opening <0.2, contact <0.4,
// midgame <0.7, endgame otherwise. Centralized here (Balance mirrors them
// for documentation); change in one place only. */
export const PHASE_CONTACT_AT = 0.2;
export const PHASE_MIDGAME_AT = 0.4;
export const PHASE_ENDGAME_AT = 0.7;

export function phaseForProgress(progress: number): MatchPhase {
  if (progress < PHASE_CONTACT_AT) return "opening";
  if (progress < PHASE_MIDGAME_AT) return "contact";
  if (progress < PHASE_ENDGAME_AT) return "midgame";
  return "endgame";
}

/**
 * Normalized match progress. Never negative; intentionally NOT clamped
 * above 1 — overtime play reports >1 and drives escalation.
 */
export function matchProgress(
  elapsedTicks: number,
  expectedTicks: number,
): number {
  if (expectedTicks <= 0) return 0;
  return Math.max(0, elapsedTicks / expectedTicks);
}

/**
 * Expected match length in ticks. Timed matches use the lobby timer
 * (maxTimerValue, minutes — set from the pacing preset at room creation).
 * Untimed (sandbox) matches measure progress against the Standard
 * equivalent so phases, unlocks and diagnostics still advance; escalation
 * stays off without a deadline (see Escalation).
 */
export function expectedMatchTicks(gameConfig: GameConfig): number {
  const minutes = gameConfig.maxTimerValue;
  if (minutes !== undefined && minutes !== null && minutes > 0) {
    return minutes * 60 * TICKS_PER_SECOND;
  }
  return STANDARD_MATCH_TICKS;
}

export function phaseForTick(
  elapsedTicks: number,
  expectedTicks: number,
): MatchPhase {
  return phaseForProgress(matchProgress(elapsedTicks, expectedTicks));
}
