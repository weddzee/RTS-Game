// The Army entity (Prompt 3.1).
//
// An army is a *named, movable, configurable* command that owns a slice of a
// player's troop pool. It deliberately does not replace the territorial troop
// mechanics: creating an army moves troops out of `Player.troops()` into the
// army, and an offensive order runs the existing AttackExecution against the
// existing attackLogic. Territory still wins fights; the army is the thing you
// name, move, compose and watch gain experience.

import type {
  ArmyComposition,
  ArmyDerivedStats,
  ArmySupplyStatus,
} from "./ArmyComposition";
import type { ArmyVeterancyTier, VeterancyCombatBonus } from "./ArmyVeterancy";
import type { Player, Tick } from "./Game";
import type { TileRef } from "./GameMap";
import type { ArmyUpdate } from "./GameUpdates";

/**
 * Every order the army panel can issue. One tagged union, not a set of
 * booleans, so an army is always in exactly one state and the client cannot
 * send a contradictory pair.
 *
 *  - `hold`: stand at the current tile. The default for a fresh army.
 *  - `move`: relocate to a tile, pathing across land.
 *  - `attack`: run the territorial attack loop against whoever owns the tile.
 *  - `createFront`: raise a front anchored at a tile and take assignment to it.
 *  - `reinforce`: pull troops from the owner's pool back into the army.
 *  - `stop`: cancel everything — orders and front assignment.
 */
export type ArmyOrder =
  | { type: "hold" }
  | { type: "move"; tile: TileRef }
  | { type: "attack"; tile: TileRef }
  | { type: "createFront"; tile: TileRef }
  | { type: "reinforce"; troops: number }
  | { type: "stop" };

export type ArmyOrderType = ArmyOrder["type"];

export const ARMY_ORDER_TYPES: readonly ArmyOrderType[] = [
  "hold",
  "move",
  "attack",
  "createFront",
  "reinforce",
  "stop",
];

export const isArmyOrderType = (value: unknown): value is ArmyOrderType =>
  typeof value === "string" && (ARMY_ORDER_TYPES as string[]).includes(value);

/** Where the army is on the map in its own terms, for the panel and markers. */
export type ArmyMovementState = "idle" | "moving" | "holding" | "engaging";

/**
 * What the army is doing to someone right now. Only two states are reachable:
 * an army is either running an offensive through the ordinary attack loop, or
 * it is not. "Defending" is deliberately absent — an army that is not
 * attacking is defending, and a second flag for that would be a state the
 * simulation has to keep in sync with the order.
 */
export type ArmyCombatState = "none" | "attacking";

/** Career record, surfaced in the army panel. */
export interface ArmyStatistics {
  battlesFought: number;
  battlesWon: number;
  casualtiesInflicted: number;
  casualtiesTaken: number;
  tilesCaptured: number;
}

export function emptyArmyStatistics(): ArmyStatistics {
  return {
    battlesFought: 0,
    battlesWon: 0,
    casualtiesInflicted: 0,
    casualtiesTaken: 0,
    tilesCaptured: 0,
  };
}

/**
 * A group of armies acting toward one anchor tile. Deliberately minimal: the
 * battle-plan system that will consume fronts properly is not built yet, but
 * `Army.assignedFrontId()` is a real, populated field rather than a stub that
 * is always null.
 */
export interface ArmyFront {
  id: number;
  ownerID: number;
  tile: TileRef;
  armyIDs: number[];
}

/**
 * The mutable state block of one army.
 *
 * Plain data with no object references, so the snapshot writes it verbatim and
 * a restore is a single assignment. `ownerID` is the owner's small id; the
 * Player is resolved from it. Composition and statistics are copied on read so
 * a caller cannot mutate an army by holding on to a returned object.
 */
export interface ArmyState {
  id: number;
  ownerID: number;
  name: string;
  tile: TileRef;
  frontId: number | null;
  battlePlanId: number | null;
  /** Troops currently in the army. Fractional, exactly like attack stacks. */
  strength: number;
  /**
   * Troops the owner has paid into this army since it was raised. The ceiling
   * `reinforce` draws up to, and the figure the creation cap is checked against.
   */
  manpower: number;
  composition: ArmyComposition;
  /** Career experience, 0 at creation. See game/ArmyVeterancy.ts. */
  xp: number;
  /** Morale, 0..100, recovering between battles. */
  organization: number;
  /** Supply percent, 0..100. */
  supply: number;
  order: ArmyOrder;
  combatState: ArmyCombatState;
  movementState: ArmyMovementState;
  createdAt: Tick;
  statistics: ArmyStatistics;
  isActive: boolean;
  /** Consecutive upkeep ticks spent below minimum strength. */
  starvingTicks: number;
}

export function emptyArmyState(id: number, ownerID: number): ArmyState {
  return {
    id,
    ownerID,
    name: "",
    tile: 0,
    frontId: null,
    battlePlanId: null,
    strength: 0,
    manpower: 0,
    composition: { infantry: 60, armor: 20, artillery: 15, support: 5 },
    xp: 0,
    organization: 100,
    supply: 100,
    order: { type: "hold" },
    combatState: "none",
    movementState: "idle",
    createdAt: 0,
    statistics: emptyArmyStatistics(),
    isActive: true,
    starvingTicks: 0,
  };
}

export function isArmy(value: unknown): value is Army {
  return (
    typeof value === "object" &&
    value !== null &&
    "isArmy" in value &&
    typeof (value as Army).isArmy === "function" &&
    (value as Army).isArmy()
  );
}

/**
 * Read-only view of one army.
 *
 * Every accessor is total and side-effect free, so the same interface serves
 * the executions, the army panel and the map markers without any of them
 * needing to know how the state block is laid out. Mutators are listed
 * explicitly rather than exposed wholesale, and the two a player can reach
 * (rename, setComposition) validate and return a boolean.
 */
export interface Army {
  isArmy(): this is Army;

  id(): number;
  owner(): Player;
  /** The custom name. Never empty: a generated default is assigned at creation. */
  displayName(): string;
  /** The tile the army is standing on. */
  tile(): TileRef;
  createdAt(): Tick;
  isActive(): boolean;

  /** Front this army is assigned to, or null. See ArmyFront. */
  assignedFrontId(): number | null;
  assignedBattlePlanId(): number | null;

  /** Troops currently in the army. Fractional, exactly like attack stacks. */
  totalStrength(): number;
  /** Troops paid into this army since it was raised; the reinforce ceiling. */
  manpower(): number;

  composition(): ArmyComposition;
  derivedStats(): ArmyDerivedStats;

  xp(): number;
  tier(): ArmyVeterancyTier;
  combatBonus(): VeterancyCombatBonus;

  /** Morale, 0..100. */
  organization(): number;
  /** Supply percent, 0..100, and the banded status the panel shows. */
  supply(): number;
  supplyStatus(): ArmySupplyStatus;

  order(): ArmyOrder;
  movementState(): ArmyMovementState;
  combatState(): ArmyCombatState;
  statistics(): ArmyStatistics;
  starvingTicks(): number;

  toUpdate(): ArmyUpdate;
  hash(): number;

  // --- mutation (core executions only) ----------------------------------

  rename(name: unknown): boolean;
  setTile(tile: TileRef): void;
  setAssignedFrontId(id: number | null): void;
  setAssignedBattlePlanId(id: number | null): void;
  addStrength(troops: number): number;
  /** Purchase: raises both the live strength and the manpower ceiling. */
  reinforce(troops: number): number;
  removeStrength(troops: number): number;
  /** Losses plus the matching veterancy dilution, in one step. */
  applyLosses(troops: number): number;
  setComposition(composition: ArmyComposition): boolean;
  addExperience(gained: number): void;
  addOrganization(delta: number): void;
  setSupply(supply: number): void;
  setOrder(order: ArmyOrder): void;
  setMovementState(state: ArmyMovementState): void;
  setCombatState(state: ArmyCombatState): void;
  recordBattleFought(): void;
  recordBattleWon(): void;
  recordCasualtiesInflicted(troops: number): void;
  recordTilesCaptured(tiles: number): void;
  setStarvingTicks(ticks: number): void;
  delete(): void;
}
