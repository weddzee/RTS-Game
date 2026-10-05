// One structured balance layer for the pacing model (Prompt 2.3).
//
// Domains: economy, combat, movement, experience, factories, air, supply,
// progression. Each pacing preset carries a multiplier per domain; systems
// under active pacing read their domain multiplier instead of hiding
// constants in random classes.
//
// Two deliberate boundaries:
// - Legacy simulation constants (attack base losses, gold base rates, unit
//   costs, doomsday schedules) stay where they are in Config. They are
//   covered by golden tests and move only opportunistically; every NEW
//   pacing number lands here.
// - The multipliers below are the authoritative tuning table. Phases,
//   escalation and unlocks read Balance, never literals.

import {
  MATCH_PACING_PRESETS,
  MatchPacingPreset,
  matchPacingConfigFor,
} from "./MatchPacing";

export type BalanceDomain =
  | "economy"
  | "combat"
  | "movement"
  | "experience"
  | "factories"
  | "air"
  | "supply"
  | "progression";

export const BALANCE_DOMAINS: readonly BalanceDomain[] = [
  "economy",
  "combat",
  "movement",
  "experience",
  "factories",
  "air",
  "supply",
  "progression",
];

/**
 * Per-domain pacing multipliers. Standard is the 1.0 baseline; rapid
 * accelerates economy-adjacent domains for a 10-minute arc, extended
 * softens them for a 20-minute arc. Air/supply stay 1.0 until those
 * systems land — the columns exist so the first air/supply tuning has a
 * home instead of a magic number.
 */
export const DOMAIN_MULTIPLIERS: Record<
  MatchPacingPreset,
  Record<BalanceDomain, number>
> = {
  rapid: {
    economy: 1.5,
    combat: 1.0,
    movement: 1.0,
    experience: 1.5,
    factories: 1.5,
    air: 1.0,
    supply: 1.0,
    progression: 1.5,
  },
  standard: {
    economy: 1.0,
    combat: 1.0,
    movement: 1.0,
    experience: 1.0,
    factories: 1.0,
    air: 1.0,
    supply: 1.0,
    progression: 1.0,
  },
  extended: {
    economy: 0.85,
    combat: 1.0,
    movement: 1.0,
    experience: 1.0,
    factories: 0.9,
    air: 1.0,
    supply: 1.0,
    progression: 1.0,
  },
  sandbox: {
    economy: 1.0,
    combat: 1.0,
    movement: 1.0,
    experience: 1.0,
    factories: 1.0,
    air: 1.0,
    supply: 1.0,
    progression: 1.0,
  },
};

/** Escalation pressure tuning (see Escalation.ts). */
export const ESCALATION_TUNING = {
  /** Ticks past the deadline per escalation level (90 s). */
  stepTicks: 90 * 10,
  /** Escalation caps here; pressure plateaus instead of diverging. */
  maxLevel: 8,
  /** Attacker troop-loss reduction, percentage points per level. */
  attackerLossReductionPerLevel: 5,
  /** Defender troop-loss increase, percentage points per level. */
  defenderLossBonusPerLevel: 5,
  /** Conquest tick-cost reduction, percentage points per level. */
  conquestCostReductionPerLevel: 3,
  /** Troop/gold production bonus, percentage points per level. */
  productionBonusPerLevel: 8,
  /** Fortification decay: defense-post loss bonus loses 1 per 2 levels. */
  fortificationDecayLevelsPerPoint: 2,
  /** Fortification decay: defense-post speed bonus loses 1 per 3 levels. */
  fortificationSpeedDecayLevelsPerPoint: 3,
  /** Train speed +1 per 3 levels, capped. */
  trainSpeedBonusEveryNLevels: 3,
  maxTrainSpeedBonus: 2,
} as const;

/** Phase-gated unlock schedule (progress fractions). Systems that do not
 * exist yet (armies, battle plans, aircraft, supply, advanced units,
 * late-game weapons) register here first; the schedule fires in order and
 * the acceptance sim proves every entry unlocks before match completion.
 * Entries marked `future: true` have no consumer yet — the schedule is
 * their contract. */
export interface UnlockEntry {
  system: string;
  /** Progress fraction at which the system becomes available. */
  atProgress: number;
  future: boolean;
}

export const UNLOCK_SCHEDULE: readonly UnlockEntry[] = [
  { system: "battlePlans", atProgress: 0.2, future: true },
  // Armies are shipped and always available (see execution/army/): the panel
  // and the order buttons are gated by the army cap instead, not by match
  // progress. The entry stays so the schedule keeps its shape for the systems
  // that will actually be phase-gated.
  { system: "armies", atProgress: 0.2, future: false },
  { system: "aircraft", atProgress: 0.4, future: true },
  { system: "supply", atProgress: 0.4, future: true },
  { system: "advancedUnits", atProgress: 0.7, future: true },
  { system: "lateGameWeapons", atProgress: 0.7, future: true },
];

export function isSystemUnlocked(system: string, progress: number): boolean {
  const entry = UNLOCK_SCHEDULE.find((e) => e.system === system);
  if (entry === undefined) return false;
  return progress >= entry.atProgress;
}

export function unlockedSystems(progress: number): string[] {
  return UNLOCK_SCHEDULE.filter((e) => progress >= e.atProgress).map(
    (e) => e.system,
  );
}

export interface PresetBalance {
  preset: MatchPacingPreset;
  domains: Record<BalanceDomain, number>;
  /** Matches MatchPacing resource/construction/troop/XP pacing values. */
  economy: number;
  progression: number;
}

/** The full tuning view for one preset: domain table + pacing config. */
export function balanceFor(preset: unknown): PresetBalance {
  const pacing = matchPacingConfigFor(preset);
  const key = (MATCH_PACING_PRESETS as readonly string[]).includes(
    pacing.preset,
  )
    ? pacing.preset
    : "standard";
  return {
    preset: key,
    domains: DOMAIN_MULTIPLIERS[key],
    economy: pacing.resourceMultiplier,
    progression: pacing.xpGainMultiplier,
  };
}
