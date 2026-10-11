// CreateAirWingExecution — raising an air wing (Prompt 7.2, 7.3).
//
// Validation lives here, in the simulation, not in the UI and not in the intent
// schema. Every client runs this execution on the same turn, so a wing is either
// raised identically everywhere or not raised at all.
//
// Three gates, in this order, because each one is cheaper than the next and
// because the order leaks the least:
//   1. the player is alive, spawned and their Air factory exists at all
//   2. the aircraft type is in the catalog
//   3. the player can pay, and the name (if any) passes the army naming rules
//
// Gate 1 is the "no air factory means no aircraft" half of 7.3. It is a
// structural refusal rather than a price: a player with no air industry cannot
// raise a wing at any price, which is why the capacity check below is not the
// only thing standing between them and free aircraft.

import { z } from "zod";
import { AIR_POINTS_PER_AIRCRAFT, WING_CREATION_COST } from "../../game/Aircraft";
import {
  type AircraftType,
  isAircraftType,
  WING_START_AIRCRAFT,
} from "../../game/Aircraft";
import { emptyAirWingState } from "../../game/Aircraft";
import { AirWingImpl, defaultAirWingName } from "../../game/AirWingImpl";
import type { Execution, Game, Player } from "../../game/Game";
import { UnitType } from "../../game/Game";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zPlayerRef } from "../../snapshot/SnapshotType";
import { AirWingExecution } from "./AirWingExecution";

export class CreateAirWingExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;
  private createdWingId: number | null = null;

  constructor(
    private player: Player,
    private aircraftType: unknown,
    private requestedName: string | null,
    private requestedRegionId: number | null,
  ) {}

  /** Why the wing was refused, for tests and logs. Null once raised. */
  failureReason(): string | null {
    return this.rejectedReason;
  }

  /** Id of the wing this execution created, or null if it was refused. */
  wingId(): number | null {
    return this.createdWingId;
  }

  /**
 * Validation only. The wing is raised in `tick()`, not here.
 *
 * That is not a stylistic choice: `GameImpl.executeNextTick` drains
 * `unInitExecs` into `inited`/`unInited` and then reassigns the field, so an
 * execution that calls `addExecution` *during* another execution's `init()` has
 * its new execution silently dropped before it is ever initialised. Doing the
 * work in `tick()` — after the init pass has finished — is how CreateArmyExecution
 * gets its ArmyExecution onto the board, and it is the only safe place here.
 */
  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (!this.player.isAlive() || !this.player.hasSpawned()) {
      this.reject("player is not in the game");
      return;
    }
    if (!isAircraftType(this.aircraftType)) {
      this.reject(`unknown aircraft type ${String(this.aircraftType)}`);
      return;
    }
    // 7.3: aircraft require Air Factory production. No air industry, no wing.
    const airFactories = this.player
      .units(UnitType.Factory)
      .filter((u) => u.isActive() && !u.isUnderConstruction()).length;
    if (airFactories === 0) {
      this.reject("player has no air factory");
      return;
    }
    if (!this.player.canAffordAirCapacity(this.cost())) {
      this.reject("not enough air production");
      return;
    }
    if (this.validateRegion(mg) === false) {
      this.reject(`unknown air region ${String(this.requestedRegionId)}`);
      return;
    }
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === undefined || this.rejectedReason !== null) {
      this.active = false;
      return;
    }

    // Re-checked here as well as in init(): a tick between the two can change
    // what the player holds, and the charge must never be taken against a wing
    // that is not being raised.
    const regionId = this.validateRegion(mg);
    if (regionId === false || !this.player.canAffordAirCapacity(this.cost())) {
      this.reject(
        regionId === false
          ? `unknown air region ${String(this.requestedRegionId)}`
          : "not enough air production",
      );
      return;
    }

    const name =
      this.requestedName ??
      defaultAirWingName(mg.airWingsOf(this.player).length);

    this.player.spendAirCapacity(this.cost());
    const state = emptyAirWingState(
      mg.nextAirWingID(),
      this.player.smallID(),
      this.aircraftType as AircraftType,
    );
    state.name = "";
    state.aircraftCount = WING_START_AIRCRAFT;
    state.regionId = regionId;
    state.createdAt = mg.ticks();
    const wing = new AirWingImpl(state, this.player);
    // The name goes through the entity so the army naming rules apply to the
    // generated default too: a player who renames later cannot end up with two
    // different naming rules in one match.
    wing.rename(name);
    mg.addAirWing(wing);
    mg.addExecution(new AirWingExecution(wing));
    this.createdWingId = wing.id();
    this.active = false;
  }

  /** Banked production points a new wing costs. */
  private cost(): number {
    return WING_CREATION_COST * AIR_POINTS_PER_AIRCRAFT;
  }

  /** `false` when the requested region does not exist on this map. */
  private validateRegion(mg: Game): number | null | false {
    if (this.requestedRegionId === null) return null;
    return mg.airRegions().isValid(this.requestedRegionId)
      ? this.requestedRegionId
      : false;
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
    return CreateAirWingExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      aircraftType: String(this.aircraftType),
      requestedName: this.requestedName,
      requestedRegionId: this.requestedRegionId,
      createdWingId: this.createdWingId,
      rejectedReason: this.rejectedReason,
    });
  }

  restoreSnapshot(s: CreateAirWingState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.aircraftType = s.aircraftType;
    this.requestedName = s.requestedName;
    this.requestedRegionId = s.requestedRegionId;
    this.createdWingId = s.createdWingId;
    this.rejectedReason = s.rejectedReason;
  }
}

const CreateAirWingStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  aircraftType: z.string(),
  requestedName: z.string().nullable(),
  requestedRegionId: z.number().int().nullable(),
  createdWingId: z.number().int().nullable(),
  rejectedReason: z.string().nullable(),
});
type CreateAirWingState = z.infer<typeof CreateAirWingStateSchema>;

export const CreateAirWingExecutionSnapshot = execSnapshotType({
  name: "CreateAirWing",
  version: 1,
  schema: CreateAirWingStateSchema,
  cls: () => CreateAirWingExecution,
});