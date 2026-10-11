// Regional air superiority (Prompt 7.7).
//
// The whole air-war model in one file, as five small pure functions and one
// constant table. Nothing here touches game state: callers pass in numbers they
// already have and get numbers back. That is what makes the formula readable
// (7.7) and testable — a test can check every branch of the air war without a
// map, without a player and without a tick.
//
// The five inputs the spec asks for map onto the power term like this:
//
//   fighter count          -> wingPower: one term per aircraft
//   quality / upgrades     -> wingQualityPercent: the wing's tier plus its
//                             owner's Air Power doctrine bonus
//   mission efficiency     -> missionEfficiencyPercent: fighters flying
//                             air superiority patrol rather than chase
//   losses                 -> already inside fighter count, because a lost
//                             aircraft is no longer a fighter
//   doctrine bonuses       -> wingQualityPercent, from the owner's applied
//                             progression perks
//
// Everything is integer arithmetic on the 100 = neutral scale, so two clients
// running the same turn cannot disagree about who owns the sky.

import {
  type AircraftType,
  aircraftDef,
  type AirMission,
  WING_MAX_AIRCRAFT,
  wingEffectiveness,
  wingQualityTier,
  wingTierBonusPercent,
} from "./Aircraft";

// ---------------------------------------------------------------------------
// Superiority share
// ---------------------------------------------------------------------------

/** Exactly even: nobody is winning the sky. */
export const AIR_PARITY_PERCENT = 50;

/** At or above this share, a side is said to hold air superiority outright. */
export const AIR_SUPERIORITY_THRESHOLD_PERCENT = 60;

/**
 * The share of a region's air war one side holds, 0..100.
 *
 *   share = 50            -> parity, nobody holds superiority
 *   share = 100           -> total control; the other side has nothing flying
 *   share = 0             -> airless
 *
 * A simple share of combined power rather than a ratio or a sigmoid, because it
 * is the one form that needs no special cases: an empty sky and a lopsided one
 * both fall out of the same division, and the result is directly readable as
 * "you hold four fifths of this region".
 *
 * With nothing flying anywhere in the region the answer is 50 (parity), not 0
 * or 100 — an empty sky is contested by nobody, and reporting 0 would make a
 * player who has lost every wing look like they were winning their own map.
 */
export function airSuperiorityShare(ownPower: number, enemyPower: number): number {
  const own = Math.max(0, ownPower);
  const enemy = Math.max(0, enemyPower);
  const total = own + enemy;
  if (total === 0) return AIR_PARITY_PERCENT;
  return Math.min(100, Math.max(0, Math.floor((own * 100) / total)));
}

export function holdsAirSuperiority(sharePercent: number): boolean {
  return sharePercent >= AIR_SUPERIORITY_THRESHOLD_PERCENT;
}

// ---------------------------------------------------------------------------
// Wing power
// ---------------------------------------------------------------------------

/**
 * A wing's contribution to its owner's regional power, in the same abstract
 * units for every wing, so they can be added.
 *
 *   power = aircraft x quality% x missionEfficiency% / 10000
 *
 * All three factors are integers and the result is floored, which means a tiny
 * wing of green aircraft in the wrong mission contributes almost nothing —
 * exactly the intended feel.
 *
 * The caller has already scaled by the owner's doctrine bonus; that arrives as
 * `ownerBonusPercent` so this function stays a pure per-wing calculation and a
 * test can exercise it without a player.
 */
export function wingPower(
  aircraftCount: number,
  mission: AirMission,
  experience: number,
  ownerBonusPercent: number,
): number {
  const aircraft = Math.min(WING_MAX_AIRCRAFT, Math.max(0, aircraftCount));
  if (aircraft === 0) return 0;
  const quality = wingQualityPercent(experience, ownerBonusPercent);
  const efficiency = missionEfficiencyPercent(mission);
  return Math.floor((aircraft * quality * efficiency) / 10000);
}

/**
 * Quality as an integer percent on the 100 = baseline scale: the wing's career
 * tier plus its owner's Air Power doctrine bonus.
 */
export function wingQualityPercent(
  experience: number,
  ownerBonusPercent: number,
): number {
  return 100 + wingTierBonusPercent(wingQualityTier(experience)) + ownerBonusPercent;
}

/**
 * How much of a wing's potential its current mission actually realises, as an
 * integer percent.
 *
 * Fighters flying air superiority patrol their assigned region: they are the
 * ones being found, and they answer with their presence rather than a kill
 * rate, so they are at full effectiveness. Fighters on intercept have given up
 * holding ground to chase bombers — better at killing bombers, worse at
 * everything else. Bombers only have one job and do it at full rate.
 *
 * The numbers are percentages of a wing's raw power, not of its quality, so a
 * veteran wing intercepting is still a veteran.
 */
export function missionEfficiencyPercent(mission: AirMission): number {
  switch (mission.type) {
    case "airSuperiority":
      return 100;
    case "intercept":
      return 90;
    case "strike":
      return 100;
  }
}

/** How hard a mission fights enemy aircraft, relative to a 100 baseline. */
export const INTERCEPT_VS_FIGHTER_EFFECTIVENESS = 100;
export const INTERCEPT_VS_BOMBER_EFFECTIVENESS = 160;
/**
 * Patrol aircraft contest bombers less well than an intercept does — that is
 * what the player trades away by choosing to hold the region — but they are
 * better against other fighters, because they are already there.
 */
export const PATROL_VS_FIGHTER_EFFECTIVENESS = 110;
export const PATROL_VS_BOMBER_EFFECTIVENESS = 120;

/**
 * What a fighter wing shoots at, and how hard. Split by target type because
 * that is the whole point of choosing between the two fighter missions:
 * intercept is the bomber-killer, air superiority is the everything-wing.
 */
export function fighterDamageVs(
  mission: AirMission,
  targetType: AircraftType,
): number {
  if (mission.type === "intercept") {
    return targetType === "Bomber"
      ? INTERCEPT_VS_BOMBER_EFFECTIVENESS
      : INTERCEPT_VS_FIGHTER_EFFECTIVENESS;
  }
  return targetType === "Bomber"
    ? PATROL_VS_BOMBER_EFFECTIVENESS
    : PATROL_VS_FIGHTER_EFFECTIVENESS;
}

// ---------------------------------------------------------------------------
// Strike damage
// ---------------------------------------------------------------------------

/**
 * How hard a bomber wing hits the ground, as an integer percent.
 *
 * Three factors, in this order:
 *
 *   1. the target category's own weight (industry is worth more than a port)
 *   2. the defender's regional air superiority — this is 7.5's "reduce bomber
 *      effectiveness", and it is a divisor so a defender at 100% control
 *      blunts a strike rather than negating it outright
 *   3. reconnaissance: a wing whose owner holds the sky in the target region
 *      finds its targets, and finds them better (7.5's recon bonus)
 */
export function bomberStrikePercent(
  targetCategory: string,
  defenderSharePercent: number,
  reconBonusPercent: number,
): number {
  const base = STRIKE_TARGET_WEIGHT[targetCategory] ?? STRIKE_TARGET_DEFAULT_WEIGHT;
  const share = Math.min(100, Math.max(0, defenderSharePercent));
  const blunted = Math.floor((base * (200 - share)) / 100);
  // Recon can only sharpen a strike, never dull it: a malformed bonus from a
  // caller must not be able to make a bomber harmless.
  const recon = Math.max(0, Math.min(RECON_BONUS_MAX_PERCENT, reconBonusPercent));
  return Math.max(0, Math.floor((blunted * (100 + recon)) / 100));
}

export const STRIKE_TARGET_WEIGHT: Record<string, number> = {
  militaryIndustry: 100,
  airIndustry: 100,
  groundArmy: 70,
  infrastructure: 60,
};

export const STRIKE_TARGET_DEFAULT_WEIGHT = 50;

/** Recon a wing flying air superiority grants its owner, in percent. */
export const RECON_BONUS_PER_SUPERIORITY_WING = 10;
export const RECON_BONUS_MAX_PERCENT = 30;

// ---------------------------------------------------------------------------
// Losses
// ---------------------------------------------------------------------------

/**
 * How much damage a fighter wing puts into an enemy wing in one engagement
 * wave.
 *
 *   damage = aircraft x quality% x vs-that-type% / 1000
 *
 * A baseline 8-aircraft wing shooting at another fighter deals 80. All three
 * factors are integers and the result is floored, so a two-aircraft wing in the
 * wrong mission contributes almost nothing — which is the intended feel.
 *
 * `ownerBonusPercent` is the owner's Air Power doctrine bonus; it arrives as an
 * argument so this stays a pure per-wing calculation that a test can exercise
 * without a player.
 */
export function airWaveDamage(
  attackAircraft: number,
  mission: AirMission,
  experience: number,
  ownerBonusPercent: number,
  defenderType: AircraftType,
): number {
  const aircraft = Math.max(0, attackAircraft);
  if (aircraft === 0) return 0;
  const quality = wingQualityPercent(experience, ownerBonusPercent);
  const vs = fighterDamageVs(mission, defenderType);
  return Math.floor((aircraft * quality * vs) / AIR_WAVE_DAMAGE_DIVISOR);
}

/** Divisor in airWaveDamage: a baseline 8-aircraft wing deals 80. */
export const AIR_WAVE_DAMAGE_DIVISOR = 1000;

/** Damage points that cost one aircraft. See airWaveDamage for the scale. */
export const AIR_DAMAGE_PER_AIRCRAFT_LOST = 40;

/** Enemy aircraft a wing shoots out in one engagement wave. */
export function aircraftDestroyedInWave(
  defenderAircraft: number,
  damagePoints: number,
): number {
  if (defenderAircraft <= 0 || damagePoints <= 0) return 0;
  return Math.min(
    defenderAircraft,
    Math.floor(damagePoints / AIR_DAMAGE_PER_AIRCRAFT_LOST),
  );
}

/**
 * Aircraft a wing loses in one engagement wave, given the damage points an
 * opposing wing put into it.
 *
 * The type's own `attrition` and `survivability` then decide how badly it
 * fares: fighters trade roughly evenly (attrition 90 against survivability 100),
 * while a bomber caught by fighters takes twice as many losses as aircraft it
 * shot down, because attrition 140 divides survivability 70. That ratio is the
 * whole reason a bomber wing has to be protected.
 */
export function aircraftLostInWave(
  type: AircraftType,
  aircraftCount: number,
  damagePoints: number,
): number {
  const def = aircraftDef(type);
  if (aircraftCount <= 0 || damagePoints <= 0) return 0;
  const kills = Math.floor(damagePoints / AIR_DAMAGE_PER_AIRCRAFT_LOST);
  const raw = Math.floor((kills * def.attrition) / def.survivability);
  return Math.min(aircraftCount, Math.max(0, raw));
}

/** Factory efficiency damage one strike inflicts, given a strike percent. */
export function strikeFactoryDamage(strikePercent: number): number {
  return Math.min(
    100,
    Math.floor((strikePercent * STRIKE_FACTORY_DAMAGE_PER_PERCENT) / 100),
  );
}

export const STRIKE_FACTORY_DAMAGE_PER_PERCENT = 2;

/** Ticks a landed strike knocks a factory's production out for. */
export const STRIKE_FACTORY_DISABLE_TICKS = 50;

/** Troops one strike takes off a ground army, given a strike percent. */
export function strikeArmyLosses(strikePercent: number): number {
  return Math.floor((strikePercent * STRIKE_ARMY_LOSS_PER_PERCENT) / 100);
}

export const STRIKE_ARMY_LOSS_PER_PERCENT = 4;

// ---------------------------------------------------------------------------
// Ground-combat modifier (7.5, "potentially give small ground-combat modifier")
// ---------------------------------------------------------------------------

/**
 * The share of a defender's losses that air superiority removes, in percent.
 *
 * Deliberately small and deliberately zero below the superiority threshold: a
 * sky full of fighters should tilt a ground fight, not decide it. Territory
 * still wins fights.
 */
export const AIR_GROUND_DEFENSE_BONUS_MAX_PERCENT = 12;

export function airGroundDefenseBonusPercent(
  defenderSharePercent: number,
): number {
  if (!holdsAirSuperiority(defenderSharePercent)) return 0;
  const share = Math.min(100, defenderSharePercent);
  // Scales linearly from 0 at the threshold to the max at total control.
  const span = 100 - AIR_SUPERIORITY_THRESHOLD_PERCENT;
  const over = Math.min(span, share - AIR_SUPERIORITY_THRESHOLD_PERCENT);
  return Math.floor((AIR_GROUND_DEFENSE_BONUS_MAX_PERCENT * over) / span);
}

// ---------------------------------------------------------------------------
// Recon accumulation
// ---------------------------------------------------------------------------

/** Recon bonus for a region, from the number of friendly patrol wings there. */
export function reconBonusPercent(patrolWingCount: number): number {
  if (patrolWingCount <= 0) return 0;
  return Math.min(
    RECON_BONUS_MAX_PERCENT,
    patrolWingCount * RECON_BONUS_PER_SUPERIORITY_WING,
  );
}

/**
 * Convenience for the panel and the overlay: the whole picture of a region for
 * one player, from numbers already in hand. Mirrors what the resolution pass
 * computes, so the client can render the same shape the sim decided on.
 */
export interface RegionalAirPicture {
  /** This player's power in the region. */
  ownPower: number;
  /** Everyone else's power in the region. */
  enemyPower: number;
  /** share of the air war, 0..100, 50 = parity. */
  sharePercent: number;
  /** Whether the share clears the outright-superiority threshold. */
  holdsSuperiority: boolean;
  /** Ground-combat defense bonus this share grants, in percent. */
  groundDefenseBonusPercent: number;
  /** Recon bonus the player's patrol wings grant in this region. */
  reconBonusPercent: number;
}

export function regionalAirPicture(
  ownPower: number,
  enemyPower: number,
  patrolWingCount: number,
): RegionalAirPicture {
  const sharePercent = airSuperiorityShare(ownPower, enemyPower);
  return {
    ownPower,
    enemyPower,
    sharePercent,
    holdsSuperiority: holdsAirSuperiority(sharePercent),
    groundDefenseBonusPercent: airGroundDefenseBonusPercent(sharePercent),
    reconBonusPercent: reconBonusPercent(patrolWingCount),
  };
}

/** A wing's own effectiveness, re-exported so callers need one import. */
export { wingEffectiveness };