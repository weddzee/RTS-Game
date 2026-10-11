// Aircraft types, wings and mission definitions (Prompt 7.1, 7.2).
//
// Aircraft are NOT individually simulated aircraft. There is no per-plane
// entity, no per-plane position, and no aircraft pathfinding: a wing is a
// *count* plus a mission, and every battle in this system is arithmetic on
// those counts. That is what keeps a 2-million-tile map cheap and what keeps
// the simulation deterministic — nothing here can drift out of sync because
// nothing here has a position to drift from.
//
// Pure and deterministic: integer math only, no floats, no Math.random. Every
// battle in this system is arithmetic on the values defined here.

import type { Tick } from "./Game";

// ---------------------------------------------------------------------------
// Aircraft types (7.1)
// ---------------------------------------------------------------------------

export enum AircraftType {
  Fighter = "Fighter",
  Bomber = "Bomber",
  Helicopter = "Helicopter",
}

export const AIRCRAFT_TYPES: readonly AircraftType[] = [
  AircraftType.Fighter,
  AircraftType.Bomber,
  AircraftType.Helicopter,
] as const;

export function isAircraftType(value: unknown): value is AircraftType {
  return (
    typeof value === "string" &&
    (AIRCRAFT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Types the architecture already leaves room for but that are not in the first
 * build (7.1: "Leave architecture for Transport, Recon, Helicopter").
 *
 * Declared, not playable. The point is that the places that switch on aircraft
 * type — the wing panel, the mission table, the air-superiority formula — all
 * take the *catalog* rather than a hardcoded pair, so adding one is a table
 * entry and a mission set rather than a refactor. Deliberately typed as plain
 * strings rather than `AircraftType`: `isAircraftType` checks the real catalog,
 * so an intent naming one of these is refused exactly as an unknown one is, and
 * typing them into the enum would quietly make them buildable.
 */
export const FUTURE_AIRCRAFT_TYPES: readonly string[] = [
  "Transport",
  "Recon",
  "Helicopter",
] as const;

export interface AircraftTypeDef {
  /** Missions this type may be assigned. See AirMission. */
  missions: readonly AirMissionType[];
  /** Seconds one aircraft sorties per engagement wave. Lower is tougher. */
  survivability: number;
  /** Aircraft destroyed per enemy aircraft destroyed. Lower survives better. */
  attrition: number;
  /** Damage this type deals to a bomber target, in percent, before modifiers. */
  strikePower: number;
}

/**
 * Per-type toughness, on the ratio that actually matters: how many aircraft a
 * wing loses per enemy aircraft it shoots down is `attrition / survivability`.
 *
 * Fighters sit just under 1 (an even trade, with the attacker slightly ahead);
 * bombers sit at 1.4, so an escortless bomber wing is gone in a handful of
 * waves. That gap is the entire reason a bomber wing wants escorts, and it is
 * deliberately survivable-but-not-robust rather than one-wave-fragile: a wing
 * should be punished for flying unprotected, not deleted.
 */
export const AIRCRAFT_CATALOG: Record<AircraftType, AircraftTypeDef> = {
  [AircraftType.Fighter]: {
    missions: ["airSuperiority", "intercept"],
    survivability: 100,
    // Fighters trade roughly one for one, slightly in their favour.
    attrition: 90,
    strikePower: 0,
  },
  [AircraftType.Bomber]: {
    missions: ["strike"],
    survivability: 100,
    // Bombers are shot down worse than fighters when caught.
    attrition: 140,
    strikePower: 100,
  },
  [AircraftType.Helicopter]: {
    missions: ["groundSupport"],
    survivability: 80,
    // Helicopters are robust but limited in sustained combat.
    attrition: 120,
    strikePower: 0,
  },
};

export function aircraftDef(type: AircraftType): AircraftTypeDef {
  return AIRCRAFT_CATALOG[type];
}

// ---------------------------------------------------------------------------
// Missions (7.5, 7.6)
// ---------------------------------------------------------------------------

export type AirMissionType = "airSuperiority" | "intercept" | "strike";

export const AIR_MISSION_TYPES: readonly AirMissionType[] = [
  "airSuperiority",
  "intercept",
  "strike",
] as const;

export function isAirMissionType(value: unknown): value is AirMissionType {
  return (
    typeof value === "string" &&
    (AIR_MISSION_TYPES as readonly string[]).includes(value)
  );
}

/**
 * What a bomber is sent after (7.6). The player picks the *category* and the
 * region; the simulation picks the actual target inside it. There is
 * deliberately no tile, unit id or damage number anywhere in this union —
 * a client that sent one would be claiming a result instead of a request, and
 * `StrikeAirMissionExecution` ignores anything it does not recognize.
 */
export type BomberTargetCategory =
  | "militaryIndustry"
  | "airIndustry"
  | "groundArmy"
  | "infrastructure";

export const BOMBER_TARGET_CATEGORIES: readonly BomberTargetCategory[] = [
  "militaryIndustry",
  "airIndustry",
  "groundArmy",
  "infrastructure",
] as const;

export function isBomberTargetCategory(
  value: unknown,
): value is BomberTargetCategory {
  return (
    typeof value === "string" &&
    (BOMBER_TARGET_CATEGORIES as readonly string[]).includes(value)
  );
}

/** A fighter wing never needs a target category, and a bomber always does. */
export type AirMission =
  | { type: "airSuperiority" }
  | { type: "intercept" }
  | { type: "strike"; target: BomberTargetCategory };

export function airMissionType(mission: AirMission): AirMissionType {
  return mission.type;
}

/**
 * Validation, and the only way a mission reaches an AirWing.
 *
 * Checks three things: the type is a known mission, the aircraft type may fly
 * it, and a strike carries a target category while the other two do not. The
 * returned mission is a fresh object, so the caller cannot retain a reference
 * into whatever it passed in.
 */
export function validateAirMission(
  mission: unknown,
  aircraftType: AircraftType,
): AirMission | null {
  if (typeof mission !== "object" || mission === null) return null;
  const type = (mission as { type?: unknown }).type;
  if (!isAirMissionType(type)) return null;
  if (!aircraftDef(aircraftType).missions.includes(type)) return null;
  if (type === "strike") {
    const target = (mission as { target?: unknown }).target;
    if (!isBomberTargetCategory(target)) return null;
    return { type, target };
  }
  // A fighter mission with a target category is not a valid fighter mission.
  if ("target" in mission) return null;
  return { type };
}

/** The mission a freshly created wing flies before the player says otherwise. */
export function defaultMissionFor(type: AircraftType): AirMission {
  return type === AircraftType.Fighter
    ? { type: "airSuperiority" }
    : { type: "strike", target: "militaryIndustry" };
}

// ---------------------------------------------------------------------------
// Wing size bounds (7.2, 7.3)
// ---------------------------------------------------------------------------

/** Aircraft a new wing is raised with. */
export const WING_START_AIRCRAFT = 8;
/** Hard ceiling: a wing never grows past this, whatever it is paid for. */
export const WING_MAX_AIRCRAFT = 60;
/**
 * Fraction (percent) of its starting size below which a wing has been gutted
 * and will rebuild rather than fight on. Losses are real and cumulative; this
 * is the floor on rebuilding, not a floor on surviving.
 */
export const WING_MIN_EFFECTIVE_PERCENT = 25;

// ---------------------------------------------------------------------------
// Production (7.3)
// ---------------------------------------------------------------------------

/**
 * Aircraft one wing starts with, and what a new wing costs in banked air
 * production. Equal by design: a wing's opening order is paid for immediately
 * and flies immediately, which keeps "build air factory -> have fighters" a
 * two-minute loop rather than a two-microtask one.
 */
export const WING_CREATION_COST = 4;

/** Banked production points one replacement costs. Loss replacement is slow. */
export const AIRCRAFT_REPLACEMENT_COST = 1;

/**
 * Banked production points per whole aircraft.
 *
 * Prompt 5 made `aircraftPoints` an abstract *rate* — 5 per tick for a level-1
 * Air Factory — not an aircraft count, so the conversion has to happen here
 * rather than by treating points as aircraft. At 250, one level-1 Air Factory at
 * full efficiency produces an aircraft roughly every five seconds, which is
 * about a dozen a minute: enough to raise a wing in twenty seconds and to
 * replace losses slowly, and nowhere near enough to field an air force for free.
 */
export const AIR_POINTS_PER_AIRCRAFT = 250;

/**
 * Ceiling on a player's banked production, in points. A generous stock, not a
 * throttle: it exists so a large factory empire cannot bank an unbounded lead
 * while flying two aircraft, and so the snapshot field stays small.
 */
export const AIR_CAPACITY_MAX = 60_000;

// ---------------------------------------------------------------------------
// Experience (7.2)
// ---------------------------------------------------------------------------

/**
 * Experience needed to reach each wing quality tier. Index = tier, and index 0
 * is unused, so `WING_QUALITY_THRESHOLDS[tier]` reads directly — the same shape
 * as MatchPacing and the army's veterancy table.
 */
export const WING_QUALITY_THRESHOLDS: readonly number[] = [0, 0, 200, 600, 1400];

export const WING_MIN_QUALITY_TIER = 1;
export const WING_MAX_QUALITY_TIER = WING_QUALITY_THRESHOLDS.length - 1;

export function wingQualityTier(experience: number): number {
  let tier = WING_MIN_QUALITY_TIER;
  for (let t = WING_MIN_QUALITY_TIER + 1; t <= WING_MAX_QUALITY_TIER; t++) {
    if (experience >= (WING_QUALITY_THRESHOLDS[t] ?? Number.MAX_SAFE_INTEGER)) {
      tier = t;
    } else {
      break;
    }
  }
  return tier;
}

/**
 * Quality as an integer percent multiplier on the 100 = baseline scale, from the
 * tier alone. Kept separate from `wingQualityPercent` so the tier table stays a
 * pure progression curve with no doctrine or doctrine-perk mixed into it.
 */
export function wingTierBonusPercent(tier: number): number {
  if (tier <= WING_MIN_QUALITY_TIER) return 0;
  // Tier 2: +10, tier 3: +25, tier 4: +45. Bounded so a long match cannot
  // produce a wing that ignores every other air wing on the map.
  return [0, 0, 10, 25, 45][tier] ?? 45;
}

/** Career record, surfaced in the wing panel. */
export interface AirWingStatistics {
  /** Engagement waves this wing has fought. */
  engagements: number;
  /** Enemy aircraft this wing has destroyed. */
  aircraftDestroyed: number;
  /** This wing's aircraft destroyed by the enemy. */
  aircraftLost: number;
  /** Bomber strikes that landed on a real target. */
  strikesLanded: number;
  /** Enemy ground/industry losses this wing has caused. */
  damageDealt: number;
}

export function emptyAirWingStatistics(): AirWingStatistics {
  return {
    engagements: 0,
    aircraftDestroyed: 0,
    aircraftLost: 0,
    strikesLanded: 0,
    damageDealt: 0,
  };
}

// ---------------------------------------------------------------------------
// The mutable state block (7.2)
// ---------------------------------------------------------------------------

/**
 * The complete state of one air wing, matching the fields the spec asks for:
 * id, displayName, owner, aircraftType, aircraftCount, experience,
 * assignedRegion, mission, effectiveness, losses.
 *
 * Plain data with no object references, so the snapshot writes it verbatim and
 * a restore is one assignment — the same discipline ArmyState uses.
 */
export interface AirWingState {
  id: number;
  ownerID: number;
  name: string;
  aircraftType: AircraftType;
  aircraftCount: number;
  /** Cumulative aircraft destroyed, the losses side of the ledger. */
  losses: number;
  experience: number;
  /** Air region this wing is assigned to, or null while unassigned. */
  regionId: number | null;
  mission: AirMission;
  createdAt: Tick;
  statistics: AirWingStatistics;
  isActive: boolean;
}

export function emptyAirWingState(
  id: number,
  ownerID: number,
  type: AircraftType,
): AirWingState {
  return {
    id,
    ownerID,
    name: "",
    aircraftType: type,
    aircraftCount: WING_START_AIRCRAFT,
    losses: 0,
    experience: 0,
    regionId: null,
    mission: defaultMissionFor(type),
    createdAt: 0,
    statistics: emptyAirWingStatistics(),
    isActive: true,
  };
}

// ---------------------------------------------------------------------------
// Effectiveness (7.2)
// ---------------------------------------------------------------------------

export const EFFECTIVENESS_MIN = 0;
export const EFFECTIVENESS_MAX = 100;

/**
 * How hard this wing is actually fighting right now, 0..100.
 *
 * Three integer inputs, and nothing else: how many aircraft it still has
 * relative to its starting size, how experienced it is, and whether it has
 * somewhere to fly. An unassigned wing is not merely ineffective, it is inert
 * — it does not appear in its region's power totals at all (see
 * AirSuperiority.ts), so effectiveness here is for the panel and for the
 * ground-combat modifier, not for deciding who wins the sky.
 */
export function wingEffectiveness(state: {
  aircraftCount: number;
  experience: number;
  regionId: number | null;
}): number {
  if (state.regionId === null) return EFFECTIVENESS_MIN;
  const strength = Math.min(
    100,
    Math.floor((state.aircraftCount * 100) / WING_START_AIRCRAFT),
  );
  const quality = wingTierBonusPercent(wingQualityTier(state.experience));
  const total = strength + quality;
  return Math.min(
    EFFECTIVENESS_MAX,
    Math.max(EFFECTIVENESS_MIN, total),
  );
}