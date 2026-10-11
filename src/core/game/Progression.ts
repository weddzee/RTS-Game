// Fast per-match levels, XP, doctrines and choices (Prompt 6).
//
// A level system designed for ONE match: no persistent grind, every player
// starts at Level 1, target maximum Level 7 (8 later). XP rewards meaningful
// strategic behavior — never passive waiting, never ally farming.
//
// This module is the single source of truth for progression tuning. It is
// pure and deterministic: integer math only, no floats, no Math.random.
// Choice generation hashes stable IDs, so every client derives the same
// options and the server never trusts the client (6.4).

import type { Player } from "./Game";

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export const PROGRESSION_MIN_LEVEL = 1;
/** Target maximum for a match (6.x). Level 8 stays possible later. */
export const PROGRESSION_MAX_LEVEL = 7;

/**
 * Cumulative XP required to REACH each level, Standard pacing. Index = level.
 * Feel targets for a competitive Standard match: L2 early opening, L3 first
 * meaningful wars, L4 midgame, L5 strong specialization, L6 late game,
 * L7 endgame.
 *
 * Calibrated against the XP sources in this file, not guessed. A player who
 * only expands into empty land and never fights lands ~100-250 XP and stops at
 * Level 1-2 — waiting is never rewarded. A strong player who conquers ~400
 * tiles (mix of players and terra), finishes ~30k troops of casualties across
 * both sides, wins and defends a handful of fights, builds a few structures
 * and eliminates one opponent passes ~3000-4000 XP by the late game and
 * reaches Level 5-6, with Level 7 reserved for a dominant performance. See
 * tests/Progression.test.ts, which asserts those ends of the curve.
 */
export const MATCH_XP_THRESHOLDS: readonly number[] = [
  0, // unused index 0
  0, // Level 1: start
  250, // Level 2: early opening
  700, // Level 3: first meaningful wars
  1400, // Level 4: midgame
  2400, // Level 5: strong specialization
  3700, // Level 6: late game
  5300, // Level 7: endgame
];

/** XP still owed to reach the next level; 0 at the maximum. */
export function xpToNextLevel(xp: number): number {
  return Math.max(0, xpForLevel(levelForXP(xp) + 1) - xp);
}

/** XP already earned toward the next level; 0 at the maximum. */
export function xpIntoLevel(xp: number): number {
  const level = levelForXP(xp);
  if (level >= PROGRESSION_MAX_LEVEL) return 0;
  return Math.max(0, xp - xpForLevel(level));
}

/**
 * Progress toward the next level as whole percent, for the XP bar (6.5).
 * Returns 100 at the maximum level so the bar reads "full" rather than
 * collapsing to a divide-by-zero there.
 */
export function xpProgressPercent(xp: number): number {
  const level = levelForXP(xp);
  if (level >= PROGRESSION_MAX_LEVEL) return 100;
  const floor = xpForLevel(level);
  const span = xpForLevel(level + 1) - floor;
  if (span <= 0) return 100;
  return Math.max(0, Math.min(100, Math.floor(((xp - floor) / span) * 100)));
}

export function xpForLevel(level: number): number {
  if (level <= PROGRESSION_MIN_LEVEL) return 0;
  if (level > PROGRESSION_MAX_LEVEL)
    return MATCH_XP_THRESHOLDS[PROGRESSION_MAX_LEVEL] ?? 0;
  return MATCH_XP_THRESHOLDS[level] ?? 0;
}

export function levelForXP(xp: number): number {
  if (xp < 0) return PROGRESSION_MIN_LEVEL;
  let level = PROGRESSION_MIN_LEVEL;
  for (let l = PROGRESSION_MIN_LEVEL + 1; l <= PROGRESSION_MAX_LEVEL; l++) {
    if (xp >= (MATCH_XP_THRESHOLDS[l] ?? Number.MAX_SAFE_INTEGER)) {
      level = l;
    } else {
      break;
    }
  }
  return level;
}

// ---------------------------------------------------------------------------
// XP sources (6.1)
//
// Base awards at Standard pacing; callers pass base amounts through
// addMatchXP(), which scales by the pacing multiplier. Anti-farm rules live
// with the callers: attacks on friendlies are blocked before any XP path
// runs, terra nullius pays the low expansion rate, and there is no
// time-based income — waiting earns nothing.
// ---------------------------------------------------------------------------

/** Per tile conquered from another player. */
export const XP_PER_TILE_VS_PLAYER = 3;
/** Per tile taken from empty land. Deliberately low: expansion is not war. */
export const XP_PER_TILE_VS_TERRA = 1;
/**
 * Troops of casualties per 1 XP (either direction). Integer division.
 *
 * Large on purpose: this is the one source that could scale without bound, and
 * a busy 15-minute fight moves tens of thousands of troops. At 40, a strong
 * player killing ~30k troops earns ~750 XP — real progress toward the late
 * levels, but never the whole curve on its own.
 */
export const XP_CASUALTIES_PER_XP = 40;
/** Finishing an offensive that took ground (winning battles). */
export const XP_FOR_BATTLE_WON = 60;
/** Repelling an incoming attack while still holding land (defending). */
export const XP_FOR_DEFENSE_HELD = 45;
/** For eliminating a player (major objective). */
export const XP_FOR_ELIMINATION = 800;

/**
 * Industry construction rewards (constructing industry, 6.1). Keyed by UnitType
 * string so xpForStructure(constructionType) needs no mapping table.
 */
export const XP_FOR_STRUCTURE: Record<string, number> = {
  Factory: 120,
  City: 60,
  Port: 60,
  "Missile Silo": 80,
  "SAM Launcher": 80,
  "Defense Post": 30,
};

export function xpForStructure(unitType: string): number {
  return XP_FOR_STRUCTURE[unitType] ?? 0;
}

/** Whole-XP from casualties, floored. Callers batch per tick, not per tile. */
export function xpForCasualties(casualties: number): number {
  if (casualties <= 0) return 0;
  return Math.floor(casualties / XP_CASUALTIES_PER_XP);
}

/** Scale a base award by a pacing percent (100 = Standard). Integer math. */
export function scaleXPForPacing(
  baseXP: number,
  pacingPercent: number,
): number {
  if (baseXP <= 0 || pacingPercent <= 0) return 0;
  return Math.floor((baseXP * pacingPercent) / 100);
}

// ---------------------------------------------------------------------------
// Doctrines and perks (6.3)
//
// Small families, not a huge tech tree. Perks are tagged by doctrine; the
// player does not lock into one tree — each level offers cross-doctrine
// choices. IDs are stable wire IDs (6.4); magnitudes are integer percents.
// ---------------------------------------------------------------------------

export enum Doctrine {
  Blitz = "Blitz",
  MassAssault = "MassAssault",
  Fortress = "Fortress",
  AirPower = "AirPower",
  Industry = "Industry",
  Logistics = "Logistics",
}

export const DOCTRINES: readonly Doctrine[] = [
  Doctrine.Blitz,
  Doctrine.MassAssault,
  Doctrine.Fortress,
  Doctrine.AirPower,
  Doctrine.Industry,
  Doctrine.Logistics,
] as const;

/**
 * Which simulation knob a perk moves. One channel per perk, so a perk's effect
 * is a single readable multiplication and two perks on the same channel compose
 * by addition.
 *
 * Each channel has exactly one consumer, and every consumer is on the hot path
 * of the simulation (or of the config both sides compute from, so the client
 * predicts the same numbers the sim runs):
 *
 *   offense      Config.attackLogic, via AttackExecution.perkModifiers —
 *                lower attacker losses, faster conquest, harder hits
 *   defense      Config.attackLogic, via the defender's perkDefensePercent —
 *                fewer troops lost per tile while defending
 *   manpower     Config.troopIncreaseRate — faster reinforcement
 *   supply       Config.maxTroops — a higher troop ceiling
 *   industry     factory output percent (Config.factoryOutputPacingPercentFor)
 *   construction construction duration, factories and structures alike
 *   air          aircraft capacity of Air factories (Factory.aircraftPoints)
 */
export type PerkEffectChannel =
  | "offense"
  | "manpower"
  | "defense"
  | "air"
  | "industry"
  | "construction"
  | "supply";

/** Stable wire/snapshot ID for a perk. Aliased to string (see PERK_IDS). */
export type PerkId = string;

export interface PerkDef {
  /** Stable ID: wire, snapshots, translations. Never rename. */
  id: string;
  doctrine: Doctrine;
  channel: PerkEffectChannel;
  /** Integer percent magnitude for the channel. */
  magnitude: number;
  /** Translation keys (en.json `progression.perks.<id>.*`). */
  nameKey: string;
  descKey: string;
}

function perk(
  id: string,
  doctrine: Doctrine,
  channel: PerkEffectChannel,
  magnitude: number,
): PerkDef {
  return {
    id,
    doctrine,
    channel,
    magnitude,
    nameKey: `progression.perks.${id}.name`,
    descKey: `progression.perks.${id}.desc`,
  };
}

export const PERK_CATALOG: Record<string, PerkDef> = {
  "rapid-advance": perk("rapid-advance", Doctrine.Blitz, "offense", 15),
  "deep-battle": perk("deep-battle", Doctrine.Blitz, "offense", 25),
  "mass-mobilization": perk(
    "mass-mobilization",
    Doctrine.MassAssault,
    "manpower",
    15,
  ),
  "total-war": perk("total-war", Doctrine.MassAssault, "manpower", 25),
  "fortified-lines": perk("fortified-lines", Doctrine.Fortress, "defense", 15),
  "grand-citadel": perk("grand-citadel", Doctrine.Fortress, "defense", 25),
  "air-doctrine": perk("air-doctrine", Doctrine.AirPower, "air", 30),
  "air-superiority": perk("air-superiority", Doctrine.AirPower, "air", 50),
  "war-industry": perk("war-industry", Doctrine.Industry, "industry", 20),
  "rapid-construction": perk(
    "rapid-construction",
    Doctrine.Industry,
    "construction",
    25,
  ),
  "supply-lines": perk("supply-lines", Doctrine.Logistics, "supply", 15),
  "field-depots": perk("field-depots", Doctrine.Logistics, "supply", 25),
};

/** Stable catalog order. Choice generation indexes into doctrine groups. */
export const PERK_IDS: readonly string[] = [
  "rapid-advance",
  "deep-battle",
  "mass-mobilization",
  "total-war",
  "fortified-lines",
  "grand-citadel",
  "air-doctrine",
  "air-superiority",
  "war-industry",
  "rapid-construction",
  "supply-lines",
  "field-depots",
];

export function isPerkId(value: unknown): value is string {
  return typeof value === "string" && value in PERK_CATALOG;
}

export function perkDef(id: string): PerkDef | undefined {
  return PERK_CATALOG[id];
}

/** Sum magnitudes of the given perks for one channel. Integer percent. */
export function perkChannelBonus(
  perkIds: readonly string[],
  channel: PerkEffectChannel,
): number {
  let total = 0;
  for (const id of perkIds) {
    const def = PERK_CATALOG[id];
    if (def !== undefined && def.channel === channel) {
      total += def.magnitude;
    }
  }
  return total;
}

/**
 * Read a perk channel off any player-like object. Duck-typed so client
 * mirrors (PlayerView) and minimal test doubles without appliedPerks()
 * safely read 0 instead of throwing.
 */
export function perkBonusFor(
  player: { appliedPerks?: () => readonly string[] } | null | undefined,
  channel: PerkEffectChannel,
): number {
  if (player === null || player === undefined) return 0;
  const fn = player.appliedPerks;
  if (typeof fn !== "function") return 0;
  return perkChannelBonus(fn.call(player), channel);
}

// ---------------------------------------------------------------------------
// Level-up choices (6.3, 6.4)
//
// 3 options per level-up, distinct doctrines when possible, never repeating
// an applied perk. Generated by the server from (playerID, level, applied)
// through a deterministic hash — no RNG, no client input. Stored on the
// player (snapshot) so choices survive reconnect; choosing validates
// membership and applies once.
// ---------------------------------------------------------------------------

/** Deterministic 32-bit hash (no imports; same inputs → same outputs). */
function hashChoiceSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const PERKS_BY_DOCTRINE: Record<Doctrine, string[]> = {
  [Doctrine.Blitz]: ["rapid-advance", "deep-battle"],
  [Doctrine.MassAssault]: ["mass-mobilization", "total-war"],
  [Doctrine.Fortress]: ["fortified-lines", "grand-citadel"],
  [Doctrine.AirPower]: ["air-doctrine", "air-superiority"],
  [Doctrine.Industry]: ["war-industry", "rapid-construction"],
  [Doctrine.Logistics]: ["supply-lines", "field-depots"],
};

export function choicesForLevelUp(
  playerID: string,
  newLevel: number,
  appliedPerks: readonly string[],
): string[] {
  const applied = new Set(appliedPerks);
  const seed = `${playerID}:${newLevel}:${[...applied].sort().join(",")}`;
  let h = hashChoiceSeed(seed);
  const next = (n: number): number => {
    const v = h % n;
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    return v;
  };

  // Doctrine rotation starts at a hashed offset so players diverge.
  const order: Doctrine[] = [...DOCTRINES];
  const start = next(order.length);
  const rotated = order.slice(start).concat(order.slice(0, start));

  const choices: string[] = [];
  for (const doctrine of rotated) {
    if (choices.length >= 3) break;
    const available = PERKS_BY_DOCTRINE[doctrine].filter(
      (id) => !applied.has(id) && !choices.includes(id),
    );
    if (available.length === 0) continue;
    choices.push(available[next(available.length)]);
  }
  // Paranoia fallback (unreachable with 12 perks / max 6 picks): fill from
  // anything unapplied so the panel never comes up empty.
  if (choices.length < 3) {
    for (const id of PERK_IDS) {
      if (choices.length >= 3) break;
      if (!applied.has(id) && !choices.includes(id)) choices.push(id);
    }
  }
  return choices;
}

// ---------------------------------------------------------------------------
// UI data (6.5)
//
// Server-authoritative panel payload: level, choices with doctrine tags and
// translation keys. The client renders it as a quick, closable, non-modal
// panel (no fullscreen interruption); pending choices persist, so the player
// can fight on and pick later.
// ---------------------------------------------------------------------------

export interface LevelUpChoiceView {
  id: string;
  doctrine: Doctrine;
  nameKey: string;
  descKey: string;
}

export interface LevelUpPanelView {
  level: number;
  choices: LevelUpChoiceView[];
}

/**
 * The panel payload for a player with a pending pick, or null when there is
 * nothing to choose (levelUpPanelFor returns null — not an empty panel — so
 * the UI can simply hide itself).
 *
 * The level shown is the one whose choice is on offer, not necessarily the
 * player's current level: a single big award can queue up several picks, and
 * showing "LEVEL UP — 7" for the choice earned at level 4 would misreport it.
 */
export function levelUpPanelFor(unit: {
  matchLevel(): number;
  pendingPerkChoices(): readonly string[];
  pendingPerkLevel?(): number;
}): LevelUpPanelView | null {
  const pending = unit.pendingPerkChoices();
  if (pending.length === 0) return null;
  const pendingLevel =
    typeof unit.pendingPerkLevel === "function" ? unit.pendingPerkLevel() : 0;
  return {
    level: pendingLevel > 0 ? pendingLevel : unit.matchLevel(),
    choices: pending.map((id) => {
      const def = PERK_CATALOG[id];
      return {
        id,
        doctrine: def?.doctrine ?? Doctrine.Logistics,
        nameKey: def?.nameKey ?? "",
        descKey: def?.descKey ?? "",
      };
    }),
  };
}

/** Convenience for execution/UI layers holding a live player + game. */
export function levelUpPanelForPlayer(player: Player): LevelUpPanelView | null {
  return levelUpPanelFor({
    matchLevel: () => player.matchLevel(),
    pendingPerkChoices: () => player.pendingPerkChoices(),
    pendingPerkLevel: () => player.pendingPerkLevel(),
  });
}
