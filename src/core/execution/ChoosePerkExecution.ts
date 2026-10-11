// ChoosePerkExecution — the authoritative level-up perk pick (Prompt 6).
//
// Validation lives here, in the simulation, not in the UI and not in the intent
// schema. Every client runs this same execution on the same turn, so a pick is
// either accepted identically everywhere or refused everywhere.
//
// The client names a perk by its stable catalog ID and supplies nothing else —
// no effect, no magnitude, no level. Three independent gates, all in here:
//   1. the player is alive and in the game (a spectator cannot pick)
//   2. the ID is in the perk catalog at all (a forged name is refused)
//   3. the ID is one of the options the simulation itself generated and stored
//      as pending for this player (a real-but-unavailable perk is refused)
// Gate 3 is what makes the pick server-authoritative in the sense the spec
// means: the client cannot apply anything it was not offered. Passing gate 3
// consumes the pending set, so a replayed pick finds nothing pending and is
// refused — a perk is applied exactly once per level.
//
// Validation is also state, not just behavior: an ID already in appliedPerks is
// refused even if a pending set somehow listed it twice, so a duplicated
// pending array cannot stack a perk's magnitude.

import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { isPerkId } from "../game/Progression";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { zPlayerRef } from "../snapshot/SnapshotType";

export class ChoosePerkExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;

  constructor(
    private player: Player,
    private perkId: string,
  ) {}

  /** Why the pick was refused, for tests and logs. Null once accepted. */
  failureReason(): string | null {
    return this.rejectedReason;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (!this.player.isAlive() || !this.player.hasSpawned()) {
      this.reject("player is not in the game");
      return;
    }
    if (!isPerkId(this.perkId)) {
      this.reject(`unknown perk ${this.perkId}`);
      return;
    }
    if (this.player.appliedPerks().includes(this.perkId)) {
      this.reject(`perk ${this.perkId} is already applied`);
      return;
    }
    if (!this.player.choosePerk(this.perkId)) {
      this.reject(`perk ${this.perkId} is not one of the pending choices`);
      return;
    }
    this.active = false;
  }

  tick(ticks: number): void {
    // The pick lands in init(); there is nothing to do afterwards.
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
    return ChoosePerkExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      perkId: this.perkId,
      rejectedReason: this.rejectedReason,
    });
  }

  restoreSnapshot(s: ChoosePerkState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.perkId = s.perkId;
    this.rejectedReason = s.rejectedReason;
  }
}

const ChoosePerkStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  perkId: z.string(),
  rejectedReason: z.string().nullable(),
});
type ChoosePerkState = z.infer<typeof ChoosePerkStateSchema>;

export const ChoosePerkExecutionSnapshot = execSnapshotType({
  name: "ChoosePerk",
  version: 1,
  schema: ChoosePerkStateSchema,
  cls: () => ChoosePerkExecution,
});
