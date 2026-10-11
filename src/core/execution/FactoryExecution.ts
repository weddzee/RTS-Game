import { z } from "zod";
import {
  FACTORY_REPAIR_TICKS_PER_PERCENT,
  factoryOutputFor,
  factoryPerkPercentsFor,
} from "../game/Factory";
import { Execution, Game, Unit, UnitType } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { zRef } from "../snapshot/SnapshotType";
import { TrainStationExecution } from "./TrainStationExecution";

export class FactoryExecution implements Execution {
  private active: boolean = true;
  private game: Game;
  private stationCreated = false;

  constructor(private factory: Unit) {}

  init(mg: Game, ticks: number): void {
    this.game = mg;
  }

  tick(ticks: number): void {
    if (!this.stationCreated) {
      this.createStation();
      this.stationCreated = true;
    }
    if (!this.factory.isActive()) {
      this.active = false;
      return;
    }
    if (this.factory.type() !== UnitType.Factory) {
      this.active = false;
      return;
    }

    // Bombing hook countdown (5.7): disabled factories tick down here.
    // Production is suppressed while disabled (see factoryOutputFor).
    if (this.factory.factoryDisabledTicks() > 0) {
      this.factory.tickFactoryDisabled();
    }

    // Capture repair (5.4): damaged factories recover gradually instead of
    // snapping to full output. +1% every REPAIR window.
    if (
      !this.factory.isUnderConstruction() &&
      this.factory.factoryEfficiency() < 100 &&
      ticks % FACTORY_REPAIR_TICKS_PER_PERCENT === 0
    ) {
      this.factory.repairFactoryTick();
    }

    // Production (5.3): capacity, not SKUs. Civilian pays gold, military pays
    // troops; air/aircraft and armor/artillery points are tracked as capacity
    // for later systems (Prompt 7 consumes aircraft points via bombing hooks).
    // Under-construction or disabled factories produce nothing.
    if (
      !this.factory.isUnderConstruction() &&
      this.factory.factoryDisabledTicks() <= 0
    ) {
      const owner = this.factory.owner();
      const pacing = this.game.config().factoryOutputPacingPercentFor(owner);
      const out = factoryOutputFor(
        this.factory.factoryType(),
        this.factory.level(),
        this.factory.factoryEfficiency(),
        pacing,
        {
          underConstruction: false,
          disabledTicks: 0,
          perks: factoryPerkPercentsFor(owner),
        },
      );
      if (out.incomeGoldPerTick > 0) {
        owner.addGold(BigInt(out.incomeGoldPerTick));
      }
      if (out.reinforcementTroopsPerTick > 0) {
        owner.addTroops(out.reinforcementTroopsPerTick);
      }
      // Aircraft (Prompt 7.3): air factories bank production on their owner,
      // which is the only way a wing is ever raised or a loss ever replaced.
      // With no Air factory this never moves, so 7.3's "no air factory means
      // negligible or no aircraft replacement" is structural rather than a
      // rate that has to be tuned.
      if (out.aircraftPoints > 0) {
        owner.addAirCapacity(out.aircraftPoints);
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  private createStation(): void {
    const structures = this.game.nearbyUnits(
      this.factory.tile()!,
      this.game.config().trainStationMaxRange(),
      [UnitType.City, UnitType.Port, UnitType.Factory],
    );

    this.game.addExecution(new TrainStationExecution(this.factory, true));
    for (const { unit } of structures) {
      if (!unit.hasTrainStation()) {
        this.game.addExecution(new TrainStationExecution(unit));
      }
    }
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return FactoryExecutionSnapshot.write({
      active: this.active,
      initialized: this.game !== undefined,
      stationCreated: this.stationCreated,
      factory: w.unit(this.factory),
    });
  }

  restoreSnapshot(s: FactoryState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.game = r.game;
    this.stationCreated = s.stationCreated;
    this.factory = r.unit(s.factory);
  }
}

const FactoryStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  stationCreated: z.boolean(),
  factory: zRef(),
});
type FactoryState = z.infer<typeof FactoryStateSchema>;

export const FactoryExecutionSnapshot = execSnapshotType({
  name: "Factory",
  version: 1,
  schema: FactoryStateSchema,
  cls: () => FactoryExecution,
});
