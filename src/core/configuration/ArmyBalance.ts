// Every number the army system balances on. Nothing here reads Game state:
// the composition/veterancy math in game/ArmyComposition.ts and
// game/ArmyVeterancy.ts is pure so it can be unit-tested deterministically.
//
// Percentages are integers where 100 means "neutral" — derived stats, veterancy
// bonuses and terrain multipliers all resolve to a 100 = no change scale. That
// keeps the derived math integer-only (floor at the end), matching the style of
// game/Veterancy.ts, so every client derives identical values.
//
// This module deliberately imports nothing from game/: Config.ts pulls it in,
// and game/Game.ts pulls in Config.ts, so a runtime import back into game/ here
// would close a cycle.

/** The four composition categories. Order is the display/serialization order. */
export const ARMY_CATEGORIES = [
  "infantry",
  "armor",
  "artillery",
  "support",
] as const;

export type ArmyCategory = (typeof ARMY_CATEGORIES)[number];

/** Composition is stored as integer percentages that must total this. */
export const ARMY_COMPOSITION_TOTAL = 100;

/** Terrain keys the army movement table is written against. */
export type ArmyTerrainKey = "plains" | "highland" | "mountain";

export const ARMY_TERRAIN_KEYS: readonly ArmyTerrainKey[] = [
  "plains",
  "highland",
  "mountain",
];

/** Named starting compositions players can pick instead of dragging sliders. */
export const ARMY_PRESETS = [
  "balanced",
  "infantry",
  "armored",
  "artillery",
  "fastAssault",
] as const;

export type ArmyPreset = (typeof ARMY_PRESETS)[number];

/**
 * Per-category contribution to each derived stat, expressed per 100% of that
 * category. The derived stat is the composition-weighted average, so a preset
 * of all infantry lands exactly on the infantry row and a 50/50 mix lands on
 * the midpoint of two rows.
 */
export interface ArmyCategoryStats {
  /** Offensive damage: how much a tile's troop loss hurts the enemy. */
  offense: number;
  /** Defensive strength: how much the army holds ground. */
  defense: number;
  /** Breakthrough: how quickly it converts border tiles. */
  breakthrough: number;
  /** Base movement speed before terrain. */
  speed: number;
  /** Supply line efficiency — feeds the army's supply status. */
  supply: number;
  /** Organization (morale) capacity. */
  organization: number;
  /** Recon radius, in tiles. */
  recon: number;
  /** Manpower consumed per troop committed, vs. an all-infantry army. */
  manpowerCost: number;
  /** Equipment/gold consumed per troop committed. */
  equipmentCost: number;
}

/**
 * Category table.
 *
 * Reading the table:
 *  - Infantry: cheap on both manpower and equipment, best defense and
 *    organization, weakest offense and breakthrough.
 *  - Armor: highest breakthrough and the only category with a terrain speed
 *    bonus, but by far the most expensive.
 *  - Artillery: highest offense, but poor at everything else — a pure artillery
 *    army is a sitting duck in melee.
 *  - Support: no combat value of its own; it buys supply, recon and
 *    organization for the categories it is mixed into.
 */
export const ARMY_CATEGORY_STATS: Record<ArmyCategory, ArmyCategoryStats> = {
  infantry: {
    offense: 60,
    defense: 130,
    breakthrough: 70,
    speed: 75,
    supply: 100,
    organization: 130,
    recon: 90,
    manpowerCost: 70,
    equipmentCost: 70,
  },
  armor: {
    offense: 130,
    defense: 120,
    breakthrough: 160,
    speed: 115,
    supply: 80,
    organization: 90,
    recon: 100,
    manpowerCost: 180,
    equipmentCost: 200,
  },
  artillery: {
    offense: 150,
    defense: 60,
    breakthrough: 60,
    speed: 55,
    supply: 80,
    organization: 70,
    recon: 70,
    manpowerCost: 90,
    equipmentCost: 110,
  },
  support: {
    offense: 70,
    defense: 100,
    breakthrough: 90,
    speed: 95,
    supply: 150,
    organization: 150,
    recon: 160,
    manpowerCost: 100,
    equipmentCost: 90,
  },
};

/** Starting compositions behind the one-click presets, in percent. */
export const ARMY_PRESET_COMPOSITIONS: Record<
  ArmyPreset,
  Record<ArmyCategory, number>
> = {
  balanced: { infantry: 60, armor: 20, artillery: 15, support: 5 },
  infantry: { infantry: 85, armor: 5, artillery: 5, support: 5 },
  armored: { infantry: 25, armor: 55, artillery: 10, support: 10 },
  artillery: { infantry: 30, armor: 10, artillery: 50, support: 10 },
  fastAssault: { infantry: 40, armor: 35, artillery: 5, support: 20 },
};

/** Terrain multiplier applied to every category's base speed. */
export const ARMY_TERRAIN_MOVEMENT: Record<ArmyTerrainKey, number> = {
  plains: 100,
  highland: 90,
  mountain: 70,
};

/**
 * Per-category terrain speed adjustment, on top of ARMY_TERRAIN_MOVEMENT.
 * This is what makes armor "faster in suitable terrain": it gains on open
 * ground (+30 on plains, +15 on the highlands) and loses badly in the
 * mountains (-20), while infantry gains a little there. Note the gain is
 * *relative*: no category ends up faster in the mountains than on the plains,
 * because the generic mountain penalty applies to all of them. What changes is
 * how much each one loses — infantry gives up far less ground than armor does.
 * Missing keys mean "no adjustment" (treated as 100).
 */
export const ARMY_CATEGORY_TERRAIN_MOVEMENT: Record<
  ArmyCategory,
  Partial<Record<ArmyTerrainKey, number>>
> = {
  infantry: { mountain: 115 },
  armor: { plains: 130, highland: 115, mountain: 80 },
  artillery: { highland: 95, mountain: 60 },
  support: {},
};

/** Veterancy ladder, bottom to top. Order matters: index is the tier number. */
export const ARMY_VETERANCY_TIERS = [
  "recruit",
  "regular",
  "veteran",
  "elite",
] as const;

export type ArmyVeterancyTier = (typeof ARMY_VETERANCY_TIERS)[number];

/**
 * Cumulative experience needed to *reach* each tier. Tier 0 is free, so a new
 * army starts as recruits. Thresholds grow steeply on purpose: an army should
 * keep improving across a whole match rather than maxing out in the first
 * minute.
 */
export const ARMY_VETERANCY_THRESHOLDS: readonly number[] = [
  0, 2_000, 10_000, 40_000,
];

/**
 * Modest bonuses per tier, percentage points off the 100 = neutral scale.
 * Elite is worth ~15% on both axes — enough to matter in a close fight, far too
 * little to make an experienced army unkillable by a fresh one of equal size.
 */
export const ARMY_VETERANCY_BONUS: Readonly<Record<ArmyVeterancyTier, number>> =
  {
    recruit: 0,
    regular: 5,
    veteran: 10,
    elite: 15,
  };

/**
 * Experience awarded per 1,000 enemy casualties inflicted, before the tier's
 * bonus multiplier. Deliberately small: XP is a byproduct of fighting, not a
 * resource to farm.
 */
export const ARMY_XP_PER_1K_CASUALTIES = 20;

/** Experience awarded for holding a contested tile, per tile captured. */
export const ARMY_XP_PER_TILE_CAPTURED = 4;

/**
 * Experience is diluted when the army shrinks, because replacements arrive as
 * recruits. Rather than halving on a threshold, XP scales by the surviving
 * fraction of the force — proportional steps compose to the same answer as one
 * big loss (prod of s_n/s_0 == s_final/s_0), so per-tick application cannot
 * compound away the whole ladder.
 */
export const ARMY_VETERANCY_DILUTION_ENABLED = true;

/**
 * XP is awarded per thousand *casualties*, and casualty counters are whole
 * troops while attack troop counts are fractional. This floor keeps the
 * conversion total.
 */
export const ARMY_CASUALTY_SCALE = 1000;

/** Minimum strength (troops) an army may be created with. */
export const ARMY_MIN_STRENGTH = 1;

/**
 * Share of a player's troop pool they may put into a single army. Stops the
 * one-army-spans-the-map pattern and leaves room for a second force.
 */
export const ARMY_MAX_SHARE_OF_TROOPS = 90;

/** Armies a single player may field at once. */
export const ARMY_DEFAULT_CAP = 5;

/**
 * Support supply, expressed as the supply status thresholds (see
 * supplyStatusFor in game/ArmyComposition.ts). An army's supply percent is
 * compared against these after terrain/speed weighting.
 */
export const ARMY_SUPPLY_THRESHOLDS = {
  sufficient: 80,
  strained: 50,
  cut: 25,
} as const;

/**
 * Organization (morale) as a percent of max. An army below zero collapses.
 * Regeneration per tick scales with the derived `organization` stat, so an
 * infantry or support-heavy army recovers faster.
 */
export const ARMY_ORGANIZATION_REGEN_PER_TICK = 2;

/**
 * Multiplier on organization regen while supply is `strained` or worse. A
 * cut-off army heals at a crawl instead of at full rate.
 */
export const ARMY_SUPPLY_ORGANIZATION_PENALTY = 40;

/**
 * Strength upkeep per tick, in tenths of a percent of current strength, applied
 * when supply is below `sufficient`. This is what makes over-extended armies
 * bleed out without an explicit "attrition" system.
 */
export const ARMY_ATTRITION_TENTHS_PER_TICK = 1;

/** Ticks an army may spend fully cut off before it is disbanded. */
export const ARMY_DISBAND_TICKS_BELOW_MIN_STRENGTH = 10;

/** Movement is evaluated every this many ticks (1 second at 10Hz). */
export const ARMY_MOVE_INTERVAL_TICKS = 10;

/** Supply and organization are also evaluated on this cadence (1 second). */
export const ARMY_UPKEEP_INTERVAL_TICKS = 10;

/**
 * Tiles an army advances per movement evaluation, per 100 points of terrain-
 * adjusted speed. A balanced composition (speed ~85 on plains) therefore covers
 * about three tiles a second — slow enough that repositioning is a decision,
 * fast enough that an army is not stuck where it was raised.
 */
export const ARMY_TILES_PER_SPEED = 4;

/**
 * Ticks between broadcasts of an army's live update. Two ticks (5Hz) keeps
 * markers and the panel current — armies only move or regenerate on the
 * upkeep cadence anyway — without re-sending every army on every tick.
 */
export const ARMY_UPDATE_INTERVAL_TICKS = 2;
