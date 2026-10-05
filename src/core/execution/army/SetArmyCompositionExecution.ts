// SetArmyCompositionExecution â€” rebalance an existing army.
//
// Like the rename, this validates in the simulation. The client sends the four
// percentages it wants; anything that does not total exactly 100 is normalized
// here (largest-remainder apportionment, see game/ArmyComposition.ts) and the
// result is what every client applies, so a client cannot install a composition
// the rules do not allow.
//
// Composition changes are free and instant. They are a command decision â€” the
// reason a commander shifts an army from infantry to armor is that the next
// fight is coming â€” and charging for them would only push players towards
// never touching the panel.

import { z } from "zod";
import {
  type ArmyComposition,
  type ArmyCompositionInput,
  normalizeComposition,
} from "../../game/ArmyComposition";
import { Execution, Game, Player } from "../../game/Game";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zInt, zPlayerRef } from "../../snapshot/SnapshotType";

export class SetArmyCompositionExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;
  /** Normalized at construction, so a pending execution's state is total. */
  private composition: ArmyComposition; // reassigned only by restoreSnapshot

  constructor(
    private player: Player,
    private armyId: number,
    requestedComposition: ArmyCompositionInput,
  ) {
    this.composition = normalizeComposition(requestedComposition);
  }

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
    if (!army.setComposition(this.composition)) {
      this.reject(`army ${this.armyId} rejected the composition`);
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
    return SetArmyCompositionExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      armyId: this.armyId,
      composition: this.composition,
      rejectedReason: this.rejectedReason,
    });
  }

  restoreSnapshot(s: SetArmyCompositionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.armyId = s.armyId;
    this.composition = s.composition;
    this.rejectedReason = s.rejectedReason;
  }
}

const SetArmyCompositionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  armyId: zInt(),
  composition: z.object({
    infantry: zInt(),
    armor: zInt(),
    artillery: zInt(),
    support: zInt(),
  }),
  rejectedReason: z.string().nullable(),
});
type SetArmyCompositionState = z.infer<typeof SetArmyCompositionStateSchema>;

export const SetArmyCompositionExecutionSnapshot = execSnapshotType({
  name: "SetArmyComposition",
  version: 1,
  schema: SetArmyCompositionStateSchema,
  cls: () => SetArmyCompositionExecution,
});
