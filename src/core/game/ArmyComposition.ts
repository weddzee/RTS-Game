// Pure composition math for armies (Prompt 3.3).
//
// Deliberately NOT a HOI4-style division designer: four categories, integer
// percentages that always total 100, four presets, and a weighted average that
// turns a composition into the handful of derived stats the simulation reads.
// Every function here is pure and integer-only (weighted sums floored once at
// the end), so the simulation and the UI derive byte-identical numbers and the
// tests are deterministic.

import {
  ARMY_CATEGORIES,
  ARMY_CATEGORY_STATS,
  ARMY_CATEGORY_TERRAIN_MOVEMENT,
  ARMY_COMPOSITION_TOTAL,
  ARMY_PRESET_COMPOSITIONS,
  ARMY_PRESETS,
  ARMY_SUPPLY_THRESHOLDS,
  ARMY_TERRAIN_MOVEMENT,
  type ArmyCategory,
  type ArmyCategoryStats,
  type ArmyPreset,
  type ArmyTerrainKey,
} from "../configuration/ArmyBalance";
import { TerrainType } from "./Game";

export { ARMY_CATEGORIES, ARMY_COMPOSITION_TOTAL, ARMY_PRESETS };
export type { ArmyCategory, ArmyPreset, ArmyTerrainKey };

/**
 * An army's makeup as integer percentages, one per category. Every value is in
 * [0, 100] and the four always sum to ARMY_COMPOSITION_TOTAL — that invariant
 * is enforced by `validateComposition`/`normalizeComposition` and is what makes
 * the weighted-average derived stats meaningful.
 */
export type ArmyComposition = Record<ArmyCategory, number>;

export type ArmyCompositionInput = Partial<Record<ArmyCategory, number>>;

const isInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v);

/** A fresh object every call — callers store the result and mutate it. */
export function emptyComposition(): ArmyComposition {
  return { infantry: 0, armor: 0, artillery: 0, support: 0 };
}

/** Preset composition by name. Always valid; never shares a mutable object. */
export function presetComposition(preset: ArmyPreset): ArmyComposition {
  return { ...ARMY_PRESET_COMPOSITIONS[preset] };
}

/** The preset a composition exactly matches, or null if it is a custom mix. */
export function matchingPreset(c: ArmyComposition): ArmyPreset | null {
  for (const preset of ARMY_PRESETS) {
    const p = ARMY_PRESET_COMPOSITIONS[preset];
    if (ARMY_CATEGORIES.every((k) => c[k] === p[k])) return preset;
  }
  return null;
}

export function compositionTotal(c: ArmyCompositionInput): number {
  let total = 0;
  for (const k of ARMY_CATEGORIES) total += c[k] ?? 0;
  return total;
}

/**
 * True when the input is already a legal composition: four integer
 * percentages in range, totalling exactly 100. Anything else (fractional
 * values, negative, over 100, wrong total, NaN, non-object) is rejected —
 * server-side this is what keeps a client from manufacturing an army with a
 * composition the rules do not allow.
 */
export function validateComposition(input: unknown): input is ArmyComposition {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  // Reject unknown keys: a typo'd category would otherwise be silently
  // dropped and quietly shift the total.
  for (const key of Object.keys(record)) {
    if (!ARMY_CATEGORIES.includes(key as ArmyCategory)) return false;
  }
  let total = 0;
  for (const k of ARMY_CATEGORIES) {
    const v = record[k];
    if (!isInteger(v) || v < 0 || v > ARMY_COMPOSITION_TOTAL) return false;
    total += v;
  }
  return total === ARMY_COMPOSITION_TOTAL;
}

export function cloneComposition(c: ArmyComposition): ArmyComposition {
  return {
    infantry: c.infantry,
    armor: c.armor,
    artillery: c.artillery,
    support: c.support,
  };
}

/**
 * Coerce arbitrary input into a legal composition.
 *
 * Values are clamped to [0, 100] and then scaled proportionally to total 100.
 * Each share is floored, and the leftover units are handed to the largest
 * fractional parts (largest-remainder / Hamilton apportionment), so the four
 * values always total exactly 100 with no rounding bias toward a category.
 * Ties break toward the earlier category in ARMY_CATEGORIES order, so the
 * result depends only on the input — never on iteration luck.
 *
 * Input that is unusable — not an object, or all zeroes — normalizes to the
 * fallback preset (Balanced) rather than to an arbitrary even split.
 */
export function normalizeComposition(
  input: unknown,
  fallback: ArmyPreset = "balanced",
): ArmyComposition {
  const record =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const raw: number[] = [];
  for (const k of ARMY_CATEGORIES) {
    const value = record[k];
    raw.push(
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(ARMY_COMPOSITION_TOTAL, Math.max(0, value))
        : 0,
    );
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) return presetComposition(fallback);

  const scaled = raw.map((v) => (v * ARMY_COMPOSITION_TOTAL) / sum);
  const shares = scaled.map(Math.floor);
  let leftover = ARMY_COMPOSITION_TOTAL - shares.reduce((a, b) => a + b, 0);

  // Largest fractional part first; ties break toward the earlier category.
  const byRemainder = scaled
    .map((value, i) => ({ i, frac: value - shares[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = emptyComposition();
  ARMY_CATEGORIES.forEach((k, i) => {
    out[k] = shares[i];
  });
  for (let n = 0; leftover > 0; n++, leftover--) {
    out[ARMY_CATEGORIES[byRemainder[n % byRemainder.length].i]] += 1;
  }
  return out;
}

/**
 * The stat axes a composition resolves to. Every field is on the
 * 100 = neutral percentage scale, floored once from the weighted sum.
 */
export interface ArmyDerivedStats {
  offense: number;
  defense: number;
  breakthrough: number;
  speed: number;
  supply: number;
  organization: number;
  recon: number;
  manpowerCost: number;
  equipmentCost: number;
}

const STAT_KEYS = Object.keys(ARMY_CATEGORY_STATS.infantry) as Array<
  keyof ArmyCategoryStats
>;

/** Weighted average of a stat across the four categories, in whole percent. */
function weightedStat(
  c: ArmyComposition,
  key: keyof ArmyCategoryStats,
): number {
  let sum = 0;
  for (const category of ARMY_CATEGORIES) {
    sum += c[category] * ARMY_CATEGORY_STATS[category][key];
  }
  return Math.floor(sum / ARMY_COMPOSITION_TOTAL);
}

/**
 * Composition -> stat axes. Percentages, floored once so the result is a
 * whole number and identical on every client.
 */
export function derivedStats(c: ArmyComposition): ArmyDerivedStats {
  const stats = {} as ArmyDerivedStats;
  for (const key of STAT_KEYS) {
    stats[key] = weightedStat(c, key);
  }
  return stats;
}

/** Maps the simulation's TerrainType onto the movement table's key. */
export function armyTerrainKey(terrain: TerrainType): ArmyTerrainKey | null {
  switch (terrain) {
    case TerrainType.Plains:
      return "plains";
    case TerrainType.Highland:
      return "highland";
    case TerrainType.Mountain:
      return "mountain";
    default:
      // Water and impassable terrain have no movement value.
      return null;
  }
}

/**
 * Speed for a composition on a given terrain: base speed, scaled by the
 * terrain multiplier and again by the category's terrain adjustment. This is
 * where armor earns its "faster in suitable terrain" — 130 on plains, 80 in
 * the mountains.
 */
export function terrainAdjustedSpeed(
  c: ArmyComposition,
  terrain: TerrainType,
): number {
  const key = armyTerrainKey(terrain);
  if (key === null) return 0;
  const base = weightedStat(c, "speed");
  const terrainMult = ARMY_TERRAIN_MOVEMENT[key];
  let sum = 0;
  for (const category of ARMY_CATEGORIES) {
    const categoryMult = ARMY_CATEGORY_TERRAIN_MOVEMENT[category][key] ?? 100;
    sum += c[category] * categoryMult;
  }
  const categoryMult = Math.floor(sum / ARMY_COMPOSITION_TOTAL);
  return Math.floor((base * terrainMult * categoryMult) / 10_000);
}

/**
 * Supply status thresholds for an army's current supply percent. The four
 * states are what the army panel shows and what gates organization regen and
 * attrition.
 */
export type ArmySupplyStatus = "sufficient" | "strained" | "cut" | "starving";

export function supplyStatusFor(supplyPercent: number): ArmySupplyStatus {
  if (supplyPercent >= ARMY_SUPPLY_THRESHOLDS.sufficient) return "sufficient";
  if (supplyPercent >= ARMY_SUPPLY_THRESHOLDS.strained) return "strained";
  if (supplyPercent >= ARMY_SUPPLY_THRESHOLDS.cut) return "cut";
  return "starving";
}

/**
 * Composition -> multiplier on the defender's troop loss per tile. This is the
 * army's offensive damage: an all-artillery army hits hardest.
 */
export function offenseMultiplier(stats: ArmyDerivedStats): number {
  return stats.offense;
}

/**
 * Composition -> divisor on the army's own troop loss per tile. Defensive
 * strength is what keeps an army in the field, so a defensive composition
 * bleeds less. 100 = neutral; 130 means a third less loss per tile.
 */
export function attackerLossDivisor(stats: ArmyDerivedStats): number {
  return stats.defense;
}

/**
 * Composition -> multiplier on a tile's conquest cost, i.e. breakthrough.
 * Above 100 the army takes front tiles faster.
 */
export function breakthroughMultiplier(stats: ArmyDerivedStats): number {
  return stats.breakthrough;
}
