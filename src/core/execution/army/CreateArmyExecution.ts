// CreateArmyExecution â€” raise a new army out of the owner's troop pool.
//
// This is the one place troops leave `Player.troops()`, so it is also the one
// place the authority for army creation lives. Everything the client asked for
// is re-derived here and re-checked against the simulation: the requested troop
// count is clamped to what the owner actually has, the composition is
// normalized, and the name is validated. A client that sends a bigger army, a
// composition that does not total 100, or a name full of markup gets a
// different army than it asked for â€” on every client, identically.
//
// init() only validates; tick() raises the army. That split is deliberate and
// load-bearing: GameImpl.executeNextTick iterates the pending-execution list
// with a forEach that has already captured its length, so an execution added
// during another execution's init() is lost when the list is replaced. Adding
// the army's own long-lived execution from tick() avoids that, exactly as
// ConstructionExecution does.

import { z } from "zod";
import { ARMY_MIN_STRENGTH } from "../../configuration/ArmyBalance";
import { type Army, emptyArmyState } from "../../game/Army";
import {
  type ArmyComposition,
  type ArmyCompositionInput,
  normalizeComposition,
} from "../../game/ArmyComposition";
import { ArmyImpl } from "../../game/ArmyImpl";
import { defaultArmyName, validateArmyName } from "../../game/ArmyName";
import { Execution, Game, Player } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zInt, zPlayerRef, zRef, zTile } from "../../snapshot/SnapshotType";
import { ArmyExecution } from "./ArmyExecution";

/**
 * Absolute ceiling on a single creation, independent of the owner's pool.
 * Only reachable for players with an infinite troop pool; everyone else is
 * bounded by Config.maxArmyStrength.
 */
export const ARMY_CREATE_TROOP_CAP = 1_000_000;

export class CreateArmyExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private army: ArmyImpl | null = null;
  private rejectedReason: string | null = null;
  /**
   * The requested composition, normalized once at construction. Normalizing
   * here rather than in init() keeps the pending execution's state total, so a
   * snapshot taken before it runs still carries a concrete composition instead
   * of the raw client payload.
   */
  private composition: ArmyComposition; // reassigned only by restoreSnapshot

  constructor(
    private player: Player,
    private tile: TileRef,
    private requestedTroops: number,
    private requestedName: string | null,
    requestedComposition: ArmyCompositionInput | null,
  ) {
    this.composition = normalizeComposition(requestedComposition);
  }

  /** Why creation was refused, for tests and logs. Null once it succeeded. */
  failureReason(): string | null {
    return this.rejectedReason;
  }

  createdArmy(): Army | null {
    return this.army;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (!this.player.isAlive() || !this.player.hasSpawned()) {
      this.reject("player is not in the game");
      return;
    }

    // The army must start inside the owner's own territory: an army is a
    // formation of troops mustered at home, not a teleport into a front.
    if (!mg.isValidRef(this.tile)) {
      this.reject(`invalid tile ${this.tile}`);
      return;
    }
    if (!mg.isLand(this.tile) || mg.isImpassable(this.tile)) {
      this.reject(`tile ${this.tile} is not deployable land`);
      return;
    }
    if (mg.owner(this.tile) !== this.player) {
      this.reject(`tile ${this.tile} is not owned by the owner`);
      return;
    }

    if (
      mg.armiesOf(this.player).length >= mg.config().maxArmyCount(this.player)
    ) {
      this.reject("army cap reached");
      return;
    }
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === undefined || this.rejectedReason !== null) {
      this.active = false;
      return;
    }

    const troops = this.resolveTroops(mg);
    if (troops === null) {
      return;
    }

    const state = emptyArmyState(mg.nextArmyID(), this.player.smallID());
    state.tile = this.tile;
    state.createdAt = mg.ticks();
    state.composition = this.composition;
    state.strength = troops;
    state.manpower = troops;
    state.name = this.resolveName(mg.armiesOf(this.player).length);

    const army = new ArmyImpl(state, this.player);
    this.army = army;
    mg.addArmy(army);
    // The per-army execution owns supply, organization, movement and combat
    // from here on.
    mg.addExecution(new ArmyExecution(army));
    this.active = false;
  }

  /**
   * The troop count actually committed: the request clamped to what the owner
   * holds, the per-army share cap and an absolute ceiling, and refused outright
   * below the minimum. Returns null (and rejects) when nothing valid is left.
   */
  private resolveTroops(mg: Game): number | null {
    const wanted = Math.min(
      this.requestedTroops,
      this.player.troops(),
      mg.config().maxArmyStrength(this.player),
      ARMY_CREATE_TROOP_CAP,
    );
    // Take what removeTroops actually paid for, not what was asked for:
    // removeTroops floors, and a fractional request would otherwise leave the
    // army holding troops the owner never spent.
    const paid = this.player.removeTroops(wanted);
    if (paid < Math.max(mg.config().minArmyStrength(), ARMY_MIN_STRENGTH)) {
      this.reject(`not enough troops: ${paid}`);
      return null;
    }
    return paid;
  }

  /**
   * The army's name. A supplied name must survive validation; one that does
   * not falls back to the generated default rather than failing the whole
   * creation â€” the troops were already committed by the time we get here, and
   * refusing now would give them back as if nothing had happened.
   */
  private resolveName(existingArmies: number): string {
    if (this.requestedName === null) {
      return defaultArmyName(existingArmies);
    }
    const result = validateArmyName(this.requestedName);
    return result.ok ? result.name : defaultArmyName(existingArmies);
  }

  private reject(reason: string): void {
    this.rejectedReason = reason;
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return CreateArmyExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      tile: this.tile,
      requestedTroops: this.requestedTroops,
      requestedName: this.requestedName,
      composition: this.composition,
      rejectedReason: this.rejectedReason,
      army: w.armyOrNull(this.army),
    });
  }

  restoreSnapshot(s: CreateArmyState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.tile = s.tile;
    this.requestedTroops = s.requestedTroops;
    this.requestedName = s.requestedName;
    // Already normalized when the request arrived; a pending execution that
    // survived a restore keeps the exact composition it was going to apply.
    this.composition = s.composition;
    this.rejectedReason = s.rejectedReason;
    this.army = s.army === null ? null : (r.army(s.army) as ArmyImpl);
  }
}

const CreateArmyStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  tile: zTile(),
  requestedTroops: z.number(),
  requestedName: z.string().nullable(),
  composition: z.object({
    infantry: zInt(),
    armor: zInt(),
    artillery: zInt(),
    support: zInt(),
  }),
  rejectedReason: z.string().nullable(),
  army: zRef().nullable(),
});
type CreateArmyState = z.infer<typeof CreateArmyStateSchema>;

export const CreateArmyExecutionSnapshot = execSnapshotType({
  name: "CreateArmy",
  version: 1,
  schema: CreateArmyStateSchema,
  cls: () => CreateArmyExecution,
});
