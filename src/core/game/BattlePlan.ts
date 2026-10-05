// Battle plans (Prompt 4).
//
// A battle plan is the canonical record of a drawn order: where the player put
// the front, which way they drew the arrow, which armies carry it out, and how
// far along it has got. The gesture that produced it is client-side and
// cosmetic; everything below is derived in the simulation from map topology.
//
// The split matters and is the whole point of this file. The client sends
// "these are the tiles I drew over" and "this is the arrow I drew", both of
// which are proposals. What lands here is the validated version: a frontier the
// player actually owns and can defend, and a route a legal army could actually
// walk. See game/BattlePlanRoute.ts for the conversion, which is the only place
// a proposal becomes a plan.

import type { Player, Tick } from "./Game";
import type { TileRef } from "./GameMap";
import type { BattlePlanUpdate } from "./GameUpdates";

/**
 * What a plan does. One tagged set of literals rather than a bag of booleans,
 * so a plan is always in exactly one mode and two modes can never disagree.
 *
 *  - `move`: reposition the assigned armies along a drawn line. No attacks.
 *  - `hold`: cancel every offensive the plan was running and keep the current
 *    region. The "prioritizes defense" order.
 *  - `frontline`: raise a front and man it. No arrow, no attacks.
 *  - `offensive`: the drawn arrow. Progressively takes targets toward the
 *    destination as territory changes hands.
 *  - `spearhead`: a narrower, more aggressive offensive. Same machinery, one
 *    lane instead of the whole front â€” see BattlePlanBalance.
 *  - `fallback`: a defensive line drawn in *own* territory. Assigned armies
 *    withdraw to it when their supply gives out.
 */
export type BattlePlanOrder =
  | "move"
  | "hold"
  | "frontline"
  | "offensive"
  | "spearhead"
  | "fallback";

export const BATTLE_PLAN_ORDERS: readonly BattlePlanOrder[] = [
  "move",
  "hold",
  "frontline",
  "offensive",
  "spearhead",
  "fallback",
];

export const isBattlePlanOrder = (value: unknown): value is BattlePlanOrder =>
  typeof value === "string" &&
  (BATTLE_PLAN_ORDERS as readonly string[]).includes(value);

/** Orders that commit troops to taking ground. */
export const isOffensiveOrder = (order: BattlePlanOrder): boolean =>
  order === "offensive" || order === "spearhead";

/**
 * Lifecycle. A plan is `active` when it is running, `paused` when the player
 * has stood it down without throwing it away, and `completed` when it has
 * reached its destination â€” a completed plan is kept so the arrow stays on the
 * map as a record of what was ordered, but nothing more executes.
 */
export type BattlePlanStatus = "active" | "paused" | "completed";

/**
 * The mutable state block of one plan.
 *
 * Plain data with no object references, so a snapshot writes it verbatim and a
 * restore is a single assignment. Arrays are copied on read; the caller cannot
 * mutate a plan by holding on to a returned reference.
 */
export interface BattlePlanState {
  id: number;
  /** Owner's small id; the Player is resolved from it. */
  ownerID: number;
  kind: BattlePlanOrder;
  status: BattlePlanStatus;
  /**
   * Canonical frontier: tiles the owner holds that border something they do
   * not. Never a tile the owner does not own â€” that is what makes a drawn
   * frontline safe to trust.
   */
  frontier: TileRef[];
  /**
   * Canonical arrow: the ordered strategic waypoints derived from the drawn
   * path by walking map topology. Empty for a plan with no reachable
   * destination, which degrades to a manning order rather than failing.
   */
  route: TileRef[];
  /**
   * Defensive line in owned territory. Only used by `fallback` plans, and every
   * entry is a tile the owner holds when the plan is created *and* re-verified
   * whenever it is used.
   */
  fallbackLine: TileRef[];
  armyIDs: number[];
  /**
   * Index into `route` of the waypoint the plan is working toward. Advances as
   * waypoints change hands, and is what makes the plan progressive rather than
   * a single rush at the final tile.
   */
  step: number;
  createdAt: Tick;
  /**
   * Bumped on every canonical change. Consumers use it to skip redrawing a
   * plan whose geometry has not moved, which is most ticks.
   */
  version: number;
}

export function emptyBattlePlanState(
  id: number,
  ownerID: number,
): BattlePlanState {
  return {
    id,
    ownerID,
    kind: "frontline",
    status: "active",
    frontier: [],
    route: [],
    fallbackLine: [],
    armyIDs: [],
    step: 0,
    createdAt: 0,
    version: 0,
  };
}

export function isBattlePlan(value: unknown): value is BattlePlan {
  return (
    typeof value === "object" &&
    value !== null &&
    "isBattlePlan" in value &&
    typeof (value as BattlePlan).isBattlePlan === "function" &&
    (value as BattlePlan).isBattlePlan()
  );
}

/**
 * Read-only view of one plan, plus the mutations the executions need.
 *
 * Every accessor is total and side-effect free, so the same interface serves the
 * driver execution, the panel and the map renderer without any of them knowing
 * how the state block is laid out.
 */
export interface BattlePlan {
  isBattlePlan(): this is BattlePlan;

  id(): number;
  owner(): Player;
  kind(): BattlePlanOrder;
  status(): BattlePlanStatus;

  frontier(): readonly TileRef[];
  route(): readonly TileRef[];
  fallbackLine(): readonly TileRef[];
  armyIDs(): readonly number[];
  step(): number;
  createdAt(): Tick;
  version(): number;

  /** True while the plan is running: active, and not a completion record. */
  isRunning(): boolean;
  /** The waypoint the plan is currently working toward, or null when exhausted. */
  currentWaypoint(): TileRef | null;

  toUpdate(): BattlePlanUpdate;
  hash(): number;

  // --- mutation (core executions only) ------------------------------------

  setKind(kind: BattlePlanOrder): void;
  setStatus(status: BattlePlanStatus): void;
  /**
   * Replaces the canonical geometry wholesale. Every field is re-validated by
   * the caller before it gets here, so this is the "the validator said this is
   * the plan" entry point rather than a general setter.
   */
  setGeometry(
    frontier: readonly TileRef[],
    route: readonly TileRef[],
    fallbackLine: readonly TileRef[],
  ): void;
  setArmyIDs(armyIDs: readonly number[]): void;
  setStep(step: number): void;
  /** Bumps `version`; call after any change the renderer needs to notice. */
  touch(): void;
}
