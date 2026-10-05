// BattlePlanImpl â€” the plan entity's state block and accessors.
//
// Mirrors ArmyImpl: plain integer state, a schema for the snapshot, and a hash
// that folds the whole plan into the game hash so two clients that disagree
// about anyone's plans disagree loudly instead of silently rendering different
// arrows.

import { z } from "zod";
import { snapshotType, zInt, zTile } from "../snapshot/SnapshotType";
import {
  BATTLE_PLAN_ORDERS,
  type BattlePlan,
  type BattlePlanOrder,
  type BattlePlanState,
  type BattlePlanStatus,
} from "./BattlePlan";
import type { Player, Tick } from "./Game";
import type { TileRef } from "./GameMap";
import type { BattlePlanUpdate } from "./GameUpdates";
import { GameUpdateType } from "./GameUpdates";

export class BattlePlanImpl implements BattlePlan {
  private s: BattlePlanState;
  private _owner: Player;

  constructor(state: BattlePlanState, _owner: Player) {
    this.s = state;
    this._owner = _owner;
  }

  isBattlePlan(): this is BattlePlan {
    return true;
  }

  id(): number {
    return this.s.id;
  }

  owner(): Player {
    return this._owner;
  }

  /** Rebinds the owner. Snapshot restore resolves players after the table. */
  bindOwner(owner: Player): void {
    this._owner = owner;
    this.s.ownerID = owner.smallID();
  }

  kind(): BattlePlanOrder {
    return this.s.kind;
  }

  status(): BattlePlanStatus {
    return this.s.status;
  }

  frontier(): readonly TileRef[] {
    return this.s.frontier;
  }

  route(): readonly TileRef[] {
    return this.s.route;
  }

  fallbackLine(): readonly TileRef[] {
    return this.s.fallbackLine;
  }

  armyIDs(): readonly number[] {
    return this.s.armyIDs;
  }

  step(): number {
    return this.s.step;
  }

  createdAt(): Tick {
    return this.s.createdAt;
  }

  version(): number {
    return this.s.version;
  }

  isRunning(): boolean {
    return this.s.status === "active";
  }

  currentWaypoint(): TileRef | null {
    if (this.s.route.length === 0) return null;
    const i = Math.min(this.s.step, this.s.route.length - 1);
    return this.s.route[i];
  }

  state(): BattlePlanState {
    return this.s;
  }

  /** Snapshot fill. The owner arrives already resolved, like an army's. */
  restoreSnapshot(s: BattlePlanState, owner: Player): void {
    this.s = {
      id: s.id,
      ownerID: s.ownerID,
      kind: s.kind,
      status: s.status,
      frontier: [...s.frontier],
      route: [...s.route],
      fallbackLine: [...s.fallbackLine],
      armyIDs: [...s.armyIDs],
      step: s.step,
      createdAt: s.createdAt,
      version: s.version,
    };
    this._owner = owner;
  }

  toUpdate(): BattlePlanUpdate {
    const s = this.s;
    return {
      type: GameUpdateType.BattlePlan,
      id: s.id,
      ownerID: s.ownerID,
      kind: s.kind,
      status: s.status,
      frontier: [...s.frontier],
      route: [...s.route],
      fallbackLine: [...s.fallbackLine],
      armyIDs: [...s.armyIDs],
      step: s.step,
      createdAt: s.createdAt,
      version: s.version,
      isActive: true,
    };
  }

  /** Tombstone for a deleted plan, so clients drop it on the next flush. */
  toRemovalUpdate(): BattlePlanUpdate {
    return {
      ...this.toUpdate(),
      isActive: false,
    };
  }

  /**
   * Integer-only fold, like ArmyImpl.hash and PlayerImpl.hash.
   *
   * Every array contributes its length plus its elements, which is enough to
   * catch a reordered or truncated route without hashing the tiles themselves.
   */
  hash(): number {
    const s = this.s;
    let h = s.id + s.ownerID + s.step + s.createdAt + s.version;
    h = h * 31 + s.kind.length;
    h = h * 31 + s.status.length;
    h = h * 31 + sum(s.frontier);
    h = h * 31 + sum(s.route);
    h = h * 31 + sum(s.fallbackLine);
    h = h * 31 + sum(s.armyIDs);
    return h | 0;
  }

  // --- mutation -----------------------------------------------------------

  setKind(kind: BattlePlanOrder): void {
    this.s.kind = kind;
    this.touch();
  }

  setStatus(status: BattlePlanStatus): void {
    this.s.status = status;
    this.touch();
  }

  setGeometry(
    frontier: readonly TileRef[],
    route: readonly TileRef[],
    fallbackLine: readonly TileRef[],
  ): void {
    this.s.frontier = [...frontier];
    this.s.route = [...route];
    this.s.fallbackLine = [...fallbackLine];
    // A redrawn plan starts again from its beginning: the arrow the player
    // just drew is the one being executed, not the previous attempt.
    this.s.step = 0;
    this.touch();
  }

  setArmyIDs(armyIDs: readonly number[]): void {
    this.s.armyIDs = [...armyIDs];
    this.touch();
  }

  setStep(step: number): void {
    const clamped = Math.max(0, Math.min(step, this.s.route.length - 1));
    if (clamped === this.s.step) return;
    this.s.step = clamped;
    this.touch();
  }

  touch(): void {
    this.s.version++;
  }

  // --- snapshot -----------------------------------------------------------

  /**
   * The snapshot payload. Plain state with no object references, so the writer
   * stores it verbatim and a restore is a single assignment.
   */
  static toState(p: BattlePlanImpl): BattlePlanState {
    const s = p.s;
    return {
      id: s.id,
      ownerID: s.ownerID,
      kind: s.kind,
      status: s.status,
      frontier: [...s.frontier],
      route: [...s.route],
      fallbackLine: [...s.fallbackLine],
      armyIDs: [...s.armyIDs],
      step: s.step,
      createdAt: s.createdAt,
      version: s.version,
    };
  }
}

const BattlePlanStateSchema = z.object({
  id: zInt(),
  ownerID: zInt(),
  kind: z.enum(BATTLE_PLAN_ORDERS),
  status: z.enum(["active", "paused", "completed"]),
  frontier: z.array(zTile()),
  route: z.array(zTile()),
  fallbackLine: z.array(zTile()),
  armyIDs: z.array(zInt()),
  step: zInt(),
  createdAt: zInt(),
  version: zInt(),
});

export const BattlePlanSnapshot = snapshotType({
  name: "BattlePlan",
  version: 1,
  schema: BattlePlanStateSchema,
});

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
