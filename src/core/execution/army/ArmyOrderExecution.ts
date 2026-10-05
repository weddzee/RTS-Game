// ArmyOrderExecution — apply one order to one army.
//
// Everything the army panel's buttons do that is not a rename or a
// composition change lands here: move, draw offensive, hold, stop, create front,
// reinforce.
//
// Two of them touch resources, and both are validated here rather than trusted:
//  - `reinforce` pulls troops out of the owner's free pool, so it is clamped to
//    what the owner actually holds.
//  - `createFront` raises a new front record on the game.
//
// The order itself is stored on the army; ArmyExecution reads it from there
// every movement interval, so an order issued mid-movement takes effect at the
// next step rather than needing its own execution to interrupt one.

import { z } from "zod";
import { ARMY_MIN_STRENGTH } from "../../configuration/ArmyBalance";
import type { ArmyFront, ArmyOrder } from "../../game/Army";
import { Execution, Game, Player } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zInt, zPlayerRef, zTile } from "../../snapshot/SnapshotType";

export class ArmyOrderExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;

  constructor(
    private player: Player,
    private armyId: number,
    private order: ArmyOrder,
  ) {}

  failureReason(): string | null {
    return this.rejectedReason;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (!this.player.isAlive() || !this.player.hasSpawned()) {
      this.reject("player is not in the game");
      return;
    }
    const army = mg.army(this.armyId);
    if (army === undefined || !army.isActive()) {
      this.reject(`army ${this.armyId} not found`);
      return;
    }
    if (army.owner() !== this.player) {
      this.reject(`army ${this.armyId} is not owned by the sender`);
      return;
    }

    switch (this.order.type) {
      case "hold":
        army.setOrder({ type: "hold" });
        break;
      case "stop":
        army.setOrder({ type: "stop" });
        army.setAssignedFrontId(null);
        break;
      case "move": {
        const tile = this.deployableTile(this.order.tile);
        if (tile === null) return;
        army.setOrder({ type: "move", tile });
        break;
      }
      case "attack": {
        // The target does not have to be land the army can stand on — an
        // offensive ends at a hostile border tile — but it must be a real
        // tile its owner is allowed to attack.
        const tile = this.order.tile;
        if (!mg.isValidRef(tile)) {
          this.reject(`invalid tile ${tile}`);
          return;
        }
        if (!this.player.canAttack(tile)) {
          this.reject(`cannot attack tile ${tile}`);
          return;
        }
        army.setOrder({ type: "attack", tile });
        break;
      }
      case "createFront": {
        const tile = this.deployableTile(this.order.tile);
        if (tile === null) return;
        const front: ArmyFront = {
          id: mg.nextFrontID(),
          ownerID: this.player.smallID(),
          tile,
          armyIDs: [],
        };
        mg.fronts().push(front);
        // An army belongs to one front: taking a new one releases the old.
        this.releaseFromFront(mg, army.id());
        front.armyIDs.push(army.id());
        army.setAssignedFrontId(front.id);
        army.setTile(tile);
        army.setOrder({ type: "hold" });
        army.setMovementState("holding");
        break;
      }
      case "reinforce": {
        const config = mg.config();
        const wanted = Math.min(
          this.order.troops,
          this.player.troops(),
          config.maxReinforceAmount(this.player),
        );
        const paid = this.player.removeTroops(wanted);
        if (paid < ARMY_MIN_STRENGTH) {
          this.reject(`not enough troops to reinforce: ${paid}`);
          return;
        }
        army.reinforce(paid);
        break;
      }
    }
    this.active = false;
  }

  tick(ticks: number): void {
    // Orders are applied in init(); the ongoing work belongs to ArmyExecution.
    this.active = false;
  }

  /**
   * The tile an army may be ordered to occupy: valid, deployable land, and
   * either unowned or already this player's. An army cannot be teleported into
   * enemy ground — that is what an attack order is for.
   */
  private deployableTile(tile: TileRef): TileRef | null {
    const mg = this.mg!;
    if (!mg.isValidRef(tile)) {
      this.reject(`invalid tile ${tile}`);
      return null;
    }
    if (!mg.isLand(tile) || mg.isImpassable(tile)) {
      this.reject(`tile ${tile} is not deployable land`);
      return null;
    }
    const ownerOf = mg.owner(tile);
    if (ownerOf.isPlayer() && ownerOf !== this.player) {
      this.reject(`tile ${tile} belongs to another player`);
      return null;
    }
    return tile;
  }

  private releaseFromFront(mg: Game, armyId: number): void {
    const fronts = mg.fronts();
    for (const front of fronts) {
      const i = front.armyIDs.indexOf(armyId);
      if (i !== -1) front.armyIDs.splice(i, 1);
    }
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
    return ArmyOrderExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      armyId: this.armyId,
      order: this.order,
      rejectedReason: this.rejectedReason,
    });
  }

  restoreSnapshot(s: ArmyOrderState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.armyId = s.armyId;
    this.order = s.order;
    this.rejectedReason = s.rejectedReason;
  }
}

const OrderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hold") }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("move"), tile: zTile() }),
  z.object({ type: z.literal("attack"), tile: zTile() }),
  z.object({ type: z.literal("createFront"), tile: zTile() }),
  z.object({ type: z.literal("reinforce"), troops: z.number() }),
]);

const ArmyOrderStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  armyId: zInt(),
  order: OrderSchema,
  rejectedReason: z.string().nullable(),
});
type ArmyOrderState = z.infer<typeof ArmyOrderStateSchema>;

export const ArmyOrderExecutionSnapshot = execSnapshotType({
  name: "ArmyOrder",
  version: 1,
  schema: ArmyOrderStateSchema,
  cls: () => ArmyOrderExecution,
});
