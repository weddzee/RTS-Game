// Army veterancy (Prompt 3.7): Recruit -> Regular -> Veteran -> Elite.
//
// Pure integer math over a single experience number, mirroring
// game/Veterancy.ts (which does the same for warships) so the simulation and
// the panel derive identical tiers without sharing state.
//
// Two rules keep it from snowballing:
//  - Bonuses are modest percentage points on the 100 = neutral scale, so an
//    Elite army is ~15% better than a Recruit army of the same size, not
//    unbeatable.
//  - Experience is proportional to the surviving fraction of the force
//    whenever the army shrinks, because replacements arrive as Recruits.

import {
  ARMY_CASUALTY_SCALE,
  ARMY_VETERANCY_BONUS,
  ARMY_VETERANCY_DILUTION_ENABLED,
  ARMY_VETERANCY_THRESHOLDS,
  ARMY_VETERANCY_TIERS,
  ARMY_XP_PER_1K_CASUALTIES,
  ARMY_XP_PER_TILE_CAPTURED,
  type ArmyVeterancyTier,
} from "../configuration/ArmyBalance";

export { ARMY_VETERANCY_TIERS };
export type { ArmyVeterancyTier };

/** The 100 = neutral reference point on the derived-stat scale. */
export const ARMY_COMPOSITION_NEUTRAL = 100;

/** Experience required to *reach* a tier (0 for Recruit). */
export function xpForTier(tier: ArmyVeterancyTier): number {
  return ARMY_VETERANCY_THRESHOLDS[tierIndex(tier)];
}

export function tierIndex(tier: ArmyVeterancyTier): number {
  const i = ARMY_VETERANCY_TIERS.indexOf(tier);
  return i === -1 ? 0 : i;
}

export function tierForIndex(index: number): ArmyVeterancyTier {
  if (index < 0) return ARMY_VETERANCY_TIERS[0];
  if (index >= ARMY_VETERANCY_TIERS.length) {
    return ARMY_VETERANCY_TIERS[ARMY_VETERANCY_TIERS.length - 1];
  }
  return ARMY_VETERANCY_TIERS[index];
}

/** Highest tier the given experience has reached. */
export function tierForXp(xp: number): ArmyVeterancyTier {
  let tier = 0;
  for (let i = 0; i < ARMY_VETERANCY_THRESHOLDS.length; i++) {
    if (xp >= ARMY_VETERANCY_THRESHOLDS[i]) tier = i;
  }
  return tierForIndex(tier);
}

/**
 * Experience within the current tier, and the span of that tier. Used by the
 * army panel's experience bar.
 */
export function xpProgress(xp: number): {
  tier: ArmyVeterancyTier;
  intoTier: number;
  tierSpan: number;
  atMaxTier: boolean;
} {
  const tier = tierForXp(xp);
  const index = tierIndex(tier);
  const floor = ARMY_VETERANCY_THRESHOLDS[index];
  const next = ARMY_VETERANCY_THRESHOLDS[index + 1];
  if (next === undefined) {
    return { tier, intoTier: 0, tierSpan: 1, atMaxTier: true };
  }
  return {
    tier,
    intoTier: xp - floor,
    tierSpan: next - floor,
    atMaxTier: false,
  };
}

/**
 * Experience awarded for a slice of fighting. Whole numbers only, and floored
 * on the total so a hundred tiny ticks cannot be farmed into a tier.
 */
export function xpForCasualtiesInflicted(casualties: number): number {
  if (casualties <= 0) return 0;
  return Math.floor(
    (casualties * ARMY_XP_PER_1K_CASUALTIES) / ARMY_CASUALTY_SCALE,
  );
}

/** Experience awarded for ground taken. */
export function xpForTilesCaptured(tiles: number): number {
  if (tiles <= 0) return 0;
  return tiles * ARMY_XP_PER_TILE_CAPTURED;
}

/** Adds experience, never past the ladder's maximum. */
export function addXp(xp: number, gained: number): number {
  if (gained <= 0) return xp;
  const max = ARMY_VETERANCY_THRESHOLDS[ARMY_VETERANCY_THRESHOLDS.length - 1];
  return Math.min(max, xp + gained);
}

/**
 * Experience after a loss of troops.
 *
 * Proportional steps compose: applying this once per tick with
 * s_1/s_0, s_2/s_1, ... gives exactly the same result as applying
 * s_final/s_0 once, so it cannot compound away the whole ladder while
 * casualties trickle in, and a single decisive loss still bites.
 *
 * A no-op when the army did not shrink, when it is empty (nothing survives to
 * carry the experience), or when dilution is disabled.
 */
export function diluteXp(
  xp: number,
  strengthBefore: number,
  strengthAfter: number,
): number {
  if (!ARMY_VETERANCY_DILUTION_ENABLED) return xp;
  if (strengthAfter >= strengthBefore) return xp;
  if (strengthAfter <= 0) return 0;
  if (strengthBefore <= 0) return xp;
  return Math.floor((xp * strengthAfter) / strengthBefore);
}

/** The tier's bonus on the 100 = neutral scale. */
export function veterancyBonus(tier: ArmyVeterancyTier): number {
  return ARMY_VETERANCY_BONUS[tier];
}

/**
 * Everything combat reads off an army's experience, resolved once per tick:
 *
 *  - `lossDivisor`: >100 means the army bleeds less per tile taken.
 *  - `conquestCostMultiplier`: >100 means it takes tiles faster.
 *  - `attackerLossPercent`: extra losses as a percentage of the incoming
 *    loss, applied by the caller on top of the divisor.
 *
 * Both effects come from the same single bonus number so they can never drift
 * apart, and both are the same modest figure the spec asks for.
 */
export interface VeterancyCombatBonus {
  tier: ArmyVeterancyTier;
  bonus: number;
  lossDivisor: number;
  conquestCostMultiplier: number;
}

export function combatBonusFor(xp: number): VeterancyCombatBonus {
  const tier = tierForXp(xp);
  const bonus = veterancyBonus(tier);
  return {
    tier,
    bonus,
    lossDivisor: ARMY_COMPOSITION_NEUTRAL + bonus,
    conquestCostMultiplier: ARMY_COMPOSITION_NEUTRAL + bonus,
  };
}
