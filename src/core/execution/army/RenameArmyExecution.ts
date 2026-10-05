// RenameArmyExecution — the authoritative army rename.
//
// Validation lives here, in the simulation, not in the UI and not in the
// intent schema. Every client runs this same execution on the same turn, so a
// name is either accepted identically everywhere or rejected everywhere; there
// is no path by which a client can put an unvalidated string on the map.
//
// See game/ArmyName.ts for what "validated" means: 1-32 code points of Unicode,
// no control or bidi-formatting characters, whitespace collapsed. Markup is not
// escaped away because it is never parsed — the name is rendered as a text node
// and as canvas text, so `<img onerror=...>` displays as those characters and
// cannot execute.

import { z } from "zod";
import { validateArmyName } from "../../game/ArmyName";
import { Execution, Game, Player } from "../../game/Game";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zInt, zPlayerRef } from "../../snapshot/SnapshotType";

export class RenameArmyExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;

  constructor(
    private player: Player,
    private armyId: number,
    private requestedName: string,
  ) {}

  /** Why the rename was refused, for tests and logs. Null once accepted. */
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
    // Ownership is checked before the name, so a player cannot use a rename to
    // probe which army ids exist.
    if (army.owner() !== this.player) {
      this.reject(`army ${this.armyId} is not owned by the sender`);
      return;
    }

    const result = validateArmyName(this.requestedName);
    if (!result.ok) {
      this.reject(`invalid army name: ${result.reason}`);
      return;
    }
    if (!army.rename(result.name)) {
      this.reject(`army ${this.armyId} rejected the name`);
      return;
    }
    this.active = false;
  }

  tick(ticks: number): void {
    // The rename lands in init(); there is nothing to do afterwards.
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
    return RenameArmyExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      armyId: this.armyId,
      requestedName: this.requestedName,
      rejectedReason: this.rejectedReason,
    });
  }

  restoreSnapshot(s: RenameArmyState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.armyId = s.armyId;
    this.requestedName = s.requestedName;
    this.rejectedReason = s.rejectedReason;
  }
}

const RenameArmyStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  armyId: zInt(),
  requestedName: z.string(),
  rejectedReason: z.string().nullable(),
});
type RenameArmyState = z.infer<typeof RenameArmyStateSchema>;

export const RenameArmyExecutionSnapshot = execSnapshotType({
  name: "RenameArmy",
  version: 1,
  schema: RenameArmyStateSchema,
  cls: () => RenameArmyExecution,
});
