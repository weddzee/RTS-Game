// AirWingExecution — one wing's own upkeep: replacements and disbanding.
//
// The per-wing half of the air system, and deliberately as small as possible.
// Everything that involves *two* wings — who shoots at whom, who wins a region,
// what a bomber hits — is AirRegionExecution's job. This one only asks a single
// question about a single wing: is it still worth having, and can the owner
// afford to keep it flying?
//
// Which means:
//
//   - Replacement. A wing below its rebuild floor buys aircraft back from the
//     owner's banked air production, one at a time, on a slow cadence. No Air
//     factory, no bank, no replacement — 7.3's rule, enforced structurally.
//   - Disbanding. A wing that has been at zero aircraft for longer than the
//     grace period is removed. The grace period exists so a wing wiped out
//     mid-formation is not destroyed by one bad engagement when its factories
//     are two seconds from producing a replacement.

import { z } from "zod";
import {
  AIRCRAFT_REPLACEMENT_COST,
  AIR_POINTS_PER_AIRCRAFT,
  WING_MAX_AIRCRAFT,
  WING_MIN_EFFECTIVE_PERCENT,
  WING_START_AIRCRAFT,
} from "../../game/Aircraft";
import type { AirWing } from "../../game/AirWing";
import { Execution, Game } from "../../game/Game";
import {
  AIR_EMPTY_WING_GRACE_TICKS,
  AIR_REPLACEMENT_INTERVAL_TICKS,
} from "../../configuration/AirBalance";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zInt, zRef } from "../../snapshot/SnapshotType";

export class AirWingExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private replacementTimer = 0;
  private emptyTicks = 0;

  constructor(private wing: AirWing) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    const wing = this.wing;
    if (!wing.isActive() || !wing.owner().isAlive()) {
      this.disband();
      return;
    }
    if (--this.replacementTimer <= 0) {
      this.replacementTimer = AIR_REPLACEMENT_INTERVAL_TICKS;
      this.tryReplace();
    }
    if (wing.aircraftCount() <= 0) {
      this.emptyTicks++;
      if (this.emptyTicks > AIR_EMPTY_WING_GRACE_TICKS) this.disband();
    } else {
      this.emptyTicks = 0;
    }
  }

  /**
   * Buy one aircraft back, if the owner can pay for it and the wing is damaged
   * enough to want it.
   *
   * The rebuild floor is why this is cheap: a wing that has lost one aircraft
   * does not immediately spend production topping itself up, so a region fight
   * does not drain the owner's bank into a wing that was never really hurt.
   */
private tryReplace(): void {
     const wing = this.wing;
     const owner = wing.owner();
     // Zero is a rebuild, not an exemption: a wing wiped out by a stronger one
     // recovers at one aircraft per tick like any other damage. The grace clock
     // below is what stops a disbanded-for-real wing from being resurrected —
     // it outlasts this, so an owner has to actually bank production to get a
     // wiped wing flying again before it is cleaned up.
     if (wing.aircraftCount() >= WING_MAX_AIRCRAFT) return;
     if (!this.needsRebuild(wing.aircraftCount())) return;
    const cost = AIRCRAFT_REPLACEMENT_COST * AIR_POINTS_PER_AIRCRAFT;
    if (!owner.canAffordAirCapacity(cost)) return;
    owner.spendAirCapacity(cost);
    wing.addAircraft(1);
  }

  /**
   * Whether a wing this size is worth topping up. Below the floor (a quarter of
   * its starting size) the answer is emphatically yes; above it, no — a wing at
   * 7 of 8 is not losing, and should not spend its owner's production.
   */
  private needsRebuild(count: number): boolean {
    const floor = Math.floor(
      (WING_START_AIRCRAFT * WING_MIN_EFFECTIVE_PERCENT) / 100,
    );
    return count <= floor;
  }

  private disband(): void {
    this.wing.delete();
    this.mg?.removeAirWing(this.wing);
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AirWingExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      wing: w.airWing(this.wing),
      replacementTimer: this.replacementTimer,
      emptyTicks: this.emptyTicks,
    });
  }

  restoreSnapshot(s: AirWingExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.wing = r.airWing(s.wing);
    this.replacementTimer = s.replacementTimer;
    this.emptyTicks = s.emptyTicks;
  }
}

const AirWingExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  wing: zRef(),
  replacementTimer: zInt(),
  emptyTicks: zInt(),
});
type AirWingExecutionState = z.infer<typeof AirWingExecutionStateSchema>;

export const AirWingExecutionSnapshot = execSnapshotType({
  name: "AirWingExecution",
  version: 1,
  schema: AirWingExecutionStateSchema,
  cls: () => AirWingExecution,
});