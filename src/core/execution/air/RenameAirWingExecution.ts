// RenameAirWingExecution — the authoritative air wing rename.
//
// Same contract as RenameArmyExecution and for the same reason: wings and armies
// are both named things, so they share one validation path (validateArmyName)
// rather than each having a near-identical one that drifts. Markup is not
// escaped away because it is never parsed — the name is a text node and canvas
// text.

import { z } from "zod";
import type { AirWing } from "../../game/AirWing";
import { Execution, Game, Player } from "../../game/Game";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zPlayerRef } from "../../snapshot/SnapshotType";

export class RenameAirWingExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;

  constructor(
    private player: Player,
    private wingId: number,
    private requestedName: string,
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
    const wing = mg.airWing(this.wingId);
    if (wing === undefined || !wing.isActive()) {
      this.reject(`air wing ${this.wingId} not found`);
      return;
    }
    // Ownership first, so a rename cannot be used to probe which wing ids exist.
    if (wing.owner() !== this.player) {
      this.reject(`air wing ${this.wingId} is not owned by the sender`);
      return;
    }
    if (!wing.rename(this.requestedName)) {
      this.reject(`invalid air wing name: ${this.requestedName}`);
      return;
    }
    this.active = false;
  }

  tick(ticks: number): void {
    this.active = false;
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
    return RenameAirWingExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      wingId: this.wingId,
      requestedName: this.requestedName,
      rejectedReason: this.rejectedReason,
    });
  }

  restoreSnapshot(s: RenameAirWingState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.wingId = s.wingId;
    this.requestedName = s.requestedName;
    this.rejectedReason = s.rejectedReason;
  }
}

const RenameAirWingStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  wingId: z.number().int(),
  requestedName: z.string(),
  rejectedReason: z.string().nullable(),
});
type RenameAirWingState = z.infer<typeof RenameAirWingStateSchema>;

export const RenameAirWingExecutionSnapshot = execSnapshotType({
  name: "RenameAirWing",
  version: 1,
  schema: RenameAirWingStateSchema,
  cls: () => RenameAirWingExecution,
});