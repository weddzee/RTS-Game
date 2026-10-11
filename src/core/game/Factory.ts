// Factory and production system (Prompt 5).
//
// Industry without turning the game into a spreadsheet: factories are
// strategic targets that give meaningful economic specialization during a
// 10-20 minute match. Production is capacity (abstract points per type),
// not dozens of equipment SKUs.
//
// This module is the single source of truth for factory tuning. It is pure
// and deterministic: integer math only, no floats, no Math.random. Callers
// that need randomness (capture efficiency) use the deterministic hash here.

import type { Game, Player, Unit } from "./Game";
import { perkBonusFor } from "./Progression";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum FactoryType {
  Civilian = "Civilian",
  Military = "Military",
  Air = "Air",
  // Later-compatible types. Defined so saves/snapshots stay stable, but not
  // exposed in the build menu yet (see isFactoryTypeExposed).
  Research = "Research",
  SupplyHub = "SupplyHub",
  MissileFacility = "MissileFacility",
}

export const FACTORY_TYPES_INITIAL: readonly FactoryType[] = [
  FactoryType.Civilian,
  FactoryType.Military,
  FactoryType.Air,
] as const;

export const FACTORY_TYPES_LATER: readonly FactoryType[] = [
  FactoryType.Research,
  FactoryType.SupplyHub,
  FactoryType.MissileFacility,
] as const;

export function isFactoryTypeExposed(t: FactoryType): boolean {
  return (
    t === FactoryType.Civilian ||
    t === FactoryType.Military ||
    t === FactoryType.Air
  );
}

export function isFactoryType(value: unknown): value is FactoryType {
  return (
    typeof value === "string" &&
    (Object.values(FactoryType) as string[]).includes(value)
  );
}

// Levels: limited to 1-3. Avoid infinite upgrade scaling (5.6).
export const FACTORY_MIN_LEVEL = 1;
export const FACTORY_MAX_LEVEL = 3;

// Capture: conqueror never gets full output instantly (5.4). Captured
// factories come out damaged at 30-60% efficiency and repair gradually.
export const FACTORY_CAPTURE_EFFICIENCY_MIN = 30;
export const FACTORY_CAPTURE_EFFICIENCY_MAX = 60;

// Repair: +1% efficiency every REPAIR_TICKS_PER_PERCENT ticks (1s). From 50%
// to full takes ~50s — meaningful but recoverable inside a 10-20 min match.
export const FACTORY_REPAIR_TICKS_PER_PERCENT = 10;
export const FACTORY_EFFICIENCY_FULL = 100;
export const FACTORY_EFFICIENCY_EMPTY = 0;

// Construction: meaningful but short (5.2). Baseline under Standard pacing
// is 20-50s. Values are ticks (10 ticks = 1s). Scaled by the pacing
// construction multiplier — never hard-coded when pacing config exists.
export const FACTORY_CONSTRUCTION_TICKS_STANDARD: Record<FactoryType, number> =
  {
    [FactoryType.Civilian]: 300, // 30s
    [FactoryType.Military]: 400, // 40s
    [FactoryType.Air]: 400, // 40s
    [FactoryType.Research]: 400,
    [FactoryType.SupplyHub]: 350,
    [FactoryType.MissileFacility]: 450, // 45s, still inside 20-50s
  };

// Build limits + cooldown (5.2 server validation).
export const FACTORY_MAX_PER_PLAYER = 12;
export const FACTORY_CONSTRUCTION_COOLDOWN_TICKS = 50; // 5s between factory builds

// ---------------------------------------------------------------------------
// Production abstraction (5.3)
//
// Capacity points, not SKUs. Military output feeds ground reinforcement /
// armor / artillery availability; air output feeds aircraft construction
// points; civilian output feeds income + construction capacity.
// ---------------------------------------------------------------------------

export interface FactoryOutput {
  /** Gold per tick added to the owner (civilian). */
  incomeGoldPerTick: number;
  /** Abstract construction capacity (civilian). Hook for build speed. */
  constructionPoints: number;
  /** Troops per tick added to the owner (military). */
  reinforcementTroopsPerTick: number;
  /** Abstract armor availability points (military). */
  armorPoints: number;
  /** Abstract artillery availability points (military). */
  artilleryPoints: number;
  /** Abstract aircraft construction points (air). */
  aircraftPoints: number;
}

/** Per-player perk multipliers, on the 100 = neutral scale (Prompt 6). */
export interface FactoryPerkPercents {
  /** Scales every output channel: the Industry doctrine's factory output. */
  industryPercent: number;
  /** Scales aircraft capacity only: the Air Power doctrine's air production. */
  airPercent: number;
}

export const NEUTRAL_FACTORY_PERK_PERCENTS: FactoryPerkPercents = {
  industryPercent: 100,
  airPercent: 100,
};

export const EMPTY_FACTORY_OUTPUT: FactoryOutput = {
  incomeGoldPerTick: 0,
  constructionPoints: 0,
  reinforcementTroopsPerTick: 0,
  armorPoints: 0,
  artilleryPoints: 0,
  aircraftPoints: 0,
};

// Base output at 100% efficiency, Standard pacing, by level (index = level).
// L1 must matter in a 10-20 min match; L3 is a strategic prize, not linear
// infinity (output roughly doubles L1->L3, never explodes).
const CIVILIAN_INCOME_BY_LEVEL = [0, 15, 35, 70];
const CIVILIAN_CONSTRUCTION_BY_LEVEL = [0, 10, 25, 50];
const MILITARY_REINFORCEMENT_BY_LEVEL = [0, 3, 7, 12];
const MILITARY_ARMOR_BY_LEVEL = [0, 5, 12, 20];
const MILITARY_ARTILLERY_BY_LEVEL = [0, 5, 12, 20];
const AIR_POINTS_BY_LEVEL = [0, 5, 12, 20];
// Later-compatible types get small placeholder outputs so the model already
// scales; they are not buildable yet.
const RESEARCH_POINTS_BY_LEVEL = [0, 5, 12, 20];
const SUPPLY_POINTS_BY_LEVEL = [0, 5, 12, 20];
const MISSILE_POINTS_BY_LEVEL = [0, 5, 12, 20];

function clampLevel(level: number): number {
  if (level < FACTORY_MIN_LEVEL) return FACTORY_MIN_LEVEL;
  if (level > FACTORY_MAX_LEVEL) return FACTORY_MAX_LEVEL;
  return level;
}

function clampEfficiency(eff: number): number {
  if (eff < FACTORY_EFFICIENCY_EMPTY) return FACTORY_EFFICIENCY_EMPTY;
  if (eff > FACTORY_EFFICIENCY_FULL) return FACTORY_EFFICIENCY_FULL;
  return eff;
}

/**
 * Scale a base output by efficiency (0-100) and a pacing multiplier expressed
 * as an integer percent (100 = Standard). Integer math only:
 *   scaled = floor(base * efficiency * pacingPercent / 10000)
 */
export function scaleFactoryOutput(
  base: number,
  efficiencyPercent: number,
  pacingPercent: number,
): number {
  const eff = clampEfficiency(efficiencyPercent);
  if (base <= 0 || eff <= 0 || pacingPercent <= 0) return 0;
  return Math.floor((base * eff * pacingPercent) / 10000);
}

/**
 * Base (unscaled) output for a factory type + level. No efficiency, no
 * pacing — the raw table entry.
 */
export function baseFactoryOutput(
  factoryType: FactoryType,
  level: number,
): FactoryOutput {
  const lv = clampLevel(level);
  switch (factoryType) {
    case FactoryType.Civilian:
      return {
        incomeGoldPerTick: CIVILIAN_INCOME_BY_LEVEL[lv] ?? 0,
        constructionPoints: CIVILIAN_CONSTRUCTION_BY_LEVEL[lv] ?? 0,
        reinforcementTroopsPerTick: 0,
        armorPoints: 0,
        artilleryPoints: 0,
        aircraftPoints: 0,
      };
    case FactoryType.Military:
      return {
        incomeGoldPerTick: 0,
        constructionPoints: 0,
        reinforcementTroopsPerTick: MILITARY_REINFORCEMENT_BY_LEVEL[lv] ?? 0,
        armorPoints: MILITARY_ARMOR_BY_LEVEL[lv] ?? 0,
        artilleryPoints: MILITARY_ARTILLERY_BY_LEVEL[lv] ?? 0,
        aircraftPoints: 0,
      };
    case FactoryType.Air:
      return {
        incomeGoldPerTick: 0,
        constructionPoints: 0,
        reinforcementTroopsPerTick: 0,
        armorPoints: 0,
        artilleryPoints: 0,
        aircraftPoints: AIR_POINTS_BY_LEVEL[lv] ?? 0,
      };
    case FactoryType.Research:
      return {
        ...EMPTY_FACTORY_OUTPUT,
        constructionPoints: RESEARCH_POINTS_BY_LEVEL[lv] ?? 0,
      };
    case FactoryType.SupplyHub:
      return {
        ...EMPTY_FACTORY_OUTPUT,
        constructionPoints: SUPPLY_POINTS_BY_LEVEL[lv] ?? 0,
      };
    case FactoryType.MissileFacility:
      return {
        ...EMPTY_FACTORY_OUTPUT,
        aircraftPoints: MISSILE_POINTS_BY_LEVEL[lv] ?? 0,
      };
  }
}

/**
 * Effective output for a live factory: base x efficiency x pacing x perks.
 * Under-construction or disabled factories produce nothing.
 *
 * `industryPercent` scales every channel at once — one multiplication, applied
 * to the scaled result, so a perk can never change which channel a factory is
 * built around. `airPercent` scales aircraft capacity only, so an Air Power
 * investor grows their air arm without also inflating gold and troops.
 */
export function factoryOutputFor(
  factoryType: FactoryType,
  level: number,
  efficiencyPercent: number,
  pacingPercent: number,
  opts?: {
    underConstruction?: boolean;
    disabledTicks?: number;
    perks?: FactoryPerkPercents;
  },
): FactoryOutput {
  if (opts?.underConstruction === true) return { ...EMPTY_FACTORY_OUTPUT };
  if ((opts?.disabledTicks ?? 0) > 0) return { ...EMPTY_FACTORY_OUTPUT };
  const perks = opts?.perks ?? NEUTRAL_FACTORY_PERK_PERCENTS;
  const base = baseFactoryOutput(factoryType, level);
  // Both multipliers are skipped at 100 so a perk-less factory produces the
  // exact integer it did before progression existed — `v * 100 / 100` is not `v`
  // for every double, and this feeds troop counts.
  const industry = perks.industryPercent;
  const air = perks.airPercent;
  const scale = (value: number): number => {
    const scaled = scaleFactoryOutput(value, efficiencyPercent, pacingPercent);
    return industry <= 100 ? scaled : (scaled * industry) / 100;
  };
  const airPoints = scale(base.aircraftPoints);
  return {
    incomeGoldPerTick: scale(base.incomeGoldPerTick),
    constructionPoints: scale(base.constructionPoints),
    reinforcementTroopsPerTick: scale(base.reinforcementTroopsPerTick),
    armorPoints: scale(base.armorPoints),
    artilleryPoints: scale(base.artilleryPoints),
    aircraftPoints: air <= 100 ? airPoints : (airPoints * air) / 100,
  };
}

// ---------------------------------------------------------------------------
// Construction duration with pacing (5.2, 5.8)
// ---------------------------------------------------------------------------

/**
 * Construction ticks for a factory type under a pacing construction-speed
 * multiplier (integer percent, 100 = Standard). Higher multiplier = faster
 * build = fewer ticks. instantBuild short-circuits to 0.
 */
export function factoryConstructionTicks(
  factoryType: FactoryType,
  constructionSpeedPercent: number,
  instantBuild: boolean,
): number {
  if (instantBuild) return 0;
  const base =
    FACTORY_CONSTRUCTION_TICKS_STANDARD[factoryType] ??
    FACTORY_CONSTRUCTION_TICKS_STANDARD[FactoryType.Civilian];
  const speed = constructionSpeedPercent > 0 ? constructionSpeedPercent : 100;
  // ticks = base * 100 / speed, rounded up so faster pacing never hits 0.
  return Math.max(1, Math.ceil((base * 100) / speed));
}

// ---------------------------------------------------------------------------
// Capture / damage / repair / bombing hooks (5.4, 5.7)
// ---------------------------------------------------------------------------

/**
 * Deterministic capture efficiency in [30, 60] derived from the unit id.
 * No RNG: same unit id always captures to the same efficiency, and the value
 * always lands inside the spec range. Uses a Knuth multiplicative hash.
 */
export function captureEfficiencyFor(unitId: number): number {
  const range =
    FACTORY_CAPTURE_EFFICIENCY_MAX - FACTORY_CAPTURE_EFFICIENCY_MIN + 1; // 31
  // >>> 0 forces uint32 wraparound; Math.imul keeps 32-bit multiplication
  // exact (no float rounding).
  const h = (Math.imul(unitId | 0, 2654435761) >>> 0) % range;
  return FACTORY_CAPTURE_EFFICIENCY_MIN + h;
}

export function applyFactoryDamage(
  currentEfficiency: number,
  damagePercent: number,
): number {
  return clampEfficiency(clampEfficiency(currentEfficiency) - damagePercent);
}

export function repairFactoryTick(currentEfficiency: number): number {
  // Called once per REPAIR_TICKS_PER_PERCENT window by FactoryExecution.
  if (currentEfficiency >= FACTORY_EFFICIENCY_FULL) {
    return FACTORY_EFFICIENCY_FULL;
  }
  return clampEfficiency(currentEfficiency + 1);
}

// ---------------------------------------------------------------------------
// Status + UI (5.5)
// ---------------------------------------------------------------------------

export type FactoryStatus =
  | "UnderConstruction"
  | "Disabled"
  | "Damaged"
  | "Operational";

export function factoryStatusFor(opts: {
  underConstruction: boolean;
  disabledTicks: number;
  efficiencyPercent: number;
}): FactoryStatus {
  if (opts.underConstruction) return "UnderConstruction";
  if (opts.disabledTicks > 0) return "Disabled";
  if (clampEfficiency(opts.efficiencyPercent) < FACTORY_EFFICIENCY_FULL) {
    return "Damaged";
  }
  return "Operational";
}

export interface FactoryDisplayInfo {
  factoryType: FactoryType;
  level: number;
  /** Total production points (sum of the capacity channels) for "+X". */
  production: number;
  output: FactoryOutput;
  status: FactoryStatus;
  efficiencyPercent: number;
  ownerName: string;
  upgradeCost: bigint;
  canUpgrade: boolean;
}

/** Sum all capacity channels into one "+X" production number for the panel. */
export function factoryProductionTotal(output: FactoryOutput): number {
  return (
    output.incomeGoldPerTick +
    output.constructionPoints +
    output.reinforcementTroopsPerTick +
    output.armorPoints +
    output.artilleryPoints +
    output.aircraftPoints
  );
}

/**
 * UI helper for the selected-factory panel (5.5):
 *   Military Factory / Level 1 / Production: +X / Status: Operational /
 *   Owner: Player / Upgrade Cost: Y / [ UPGRADE ]
 * Pure except for reading live unit/game state; no mutation.
 */
export function factoryDisplayInfoFor(
  unit: Unit,
  game: Game,
  owner: Player,
): FactoryDisplayInfo {
  const factoryType = unit.factoryType();
  const level = unit.level();
  const efficiency = unit.factoryEfficiency();
  const disabledTicks = unit.factoryDisabledTicks();
  const underConstruction = unit.isUnderConstruction();
  const pacing = game.config().factoryOutputPacingPercentFor(owner);
  const output = factoryOutputFor(factoryType, level, efficiency, pacing, {
    underConstruction,
    disabledTicks,
    perks: factoryPerkPercentsFor(owner),
  });
  const status = factoryStatusFor({
    underConstruction,
    disabledTicks,
    efficiencyPercent: efficiency,
  });
  const upgradeCost = game.config().unitInfo(unit.type()).cost(game, owner);
  const canUpgrade =
    level >= FACTORY_MIN_LEVEL &&
    level < FACTORY_MAX_LEVEL &&
    !underConstruction &&
    disabledTicks <= 0;
  return {
    factoryType,
    level,
    production: factoryProductionTotal(output),
    output,
    status,
    efficiencyPercent: efficiency,
    ownerName: owner.displayName(),
    upgradeCost,
    canUpgrade,
  };
}

/**
 * Per-player production perk multipliers, read from the owner's applied
 * progression perks (Prompt 6). Lives here rather than in Config so the factory
 * output model owns its own inputs and every caller gets the same pair.
 */
export function factoryPerkPercentsFor(
  owner: { appliedPerks?: () => readonly string[] } | null | undefined,
): FactoryPerkPercents {
  return {
    industryPercent: 100 + perkBonusFor(owner, "industry"),
    airPercent: 100 + perkBonusFor(owner, "air"),
  };
}

/**
 * Player-level rollup: sum effective output across all of a player's active,
 * fully-built factories. Used by production ticks and leaderboard hooks.
 */
export function totalFactoryOutputForPlayer(
  factories: Array<{
    factoryType: FactoryType;
    level: number;
    efficiencyPercent: number;
    underConstruction: boolean;
    disabledTicks: number;
    isActive: boolean;
  }>,
  pacingPercent: number,
  perks: FactoryPerkPercents = NEUTRAL_FACTORY_PERK_PERCENTS,
): FactoryOutput {
  const total: FactoryOutput = { ...EMPTY_FACTORY_OUTPUT };
  for (const f of factories) {
    if (!f.isActive) continue;
    const out = factoryOutputFor(
      f.factoryType,
      f.level,
      f.efficiencyPercent,
      pacingPercent,
      {
        underConstruction: f.underConstruction,
        disabledTicks: f.disabledTicks,
        perks,
      },
    );
    total.incomeGoldPerTick += out.incomeGoldPerTick;
    total.constructionPoints += out.constructionPoints;
    total.reinforcementTroopsPerTick += out.reinforcementTroopsPerTick;
    total.armorPoints += out.armorPoints;
    total.artilleryPoints += out.artilleryPoints;
    total.aircraftPoints += out.aircraftPoints;
  }
  return total;
}
