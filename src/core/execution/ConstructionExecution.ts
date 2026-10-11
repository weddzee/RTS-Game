import { z } from "zod";
import {
  FactoryType,
  isFactoryType,
  isFactoryTypeExposed,
} from "../game/Factory";
import { Execution, Game, Player, Tick, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { perkBonusFor, xpForStructure } from "../game/Progression";
import { UnitTypeSchema } from "../snapshot/CommonSchemas";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { zInt, zPlayerRef, zRef } from "../snapshot/SnapshotType";
import { CityExecution } from "./CityExecution";
import { DefensePostExecution } from "./DefensePostExecution";
import { FactoryExecution } from "./FactoryExecution";
import { MirvExecution } from "./MIRVExecution";
import { MissileSiloExecution } from "./MissileSiloExecution";
import { NukeExecution } from "./NukeExecution";
import { PortExecution } from "./PortExecution";
import { SAMLauncherExecution } from "./SAMLauncherExecution";
import { WarshipExecution } from "./WarshipExecution";

export class ConstructionExecution implements Execution {
  private structure: Unit | null = null;
  private active: boolean = true;
  private mg: Game;

  private ticksUntilComplete: Tick;

  constructor(
    private player: Player,
    private constructionType: UnitType,
    private tile: TileRef,
    private rocketDirectionUp?: boolean,
    private amount?: number,
    private factoryType?: FactoryType,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    if (this.mg.config().isUnitDisabled(this.constructionType)) {
      console.warn(
        `cannot build construction ${this.constructionType} because it is disabled`,
      );
      this.active = false;
      return;
    }

    if (!this.mg.isValidRef(this.tile)) {
      console.warn(`cannot build construction invalid tile ${this.tile}`);
      this.active = false;
      return;
    }

    // Factories: resolve specialization now so cost/validation use it.
    // Later-compatible types exist in the model but are not exposed yet.
    if (this.constructionType === UnitType.Factory) {
      if (
        this.factoryType !== undefined &&
        (!isFactoryType(this.factoryType) ||
          !isFactoryTypeExposed(this.factoryType))
      ) {
        console.warn(
          `cannot build factory type ${this.factoryType}: not exposed`,
        );
        this.active = false;
        return;
      }
      this.factoryType ??= FactoryType.Civilian;
    }
  }

  tick(ticks: number): void {
    if (this.structure === null) {
      const info = this.mg.unitInfo(this.constructionType);
      // For non-structure units (nukes/warship), charge once and delegate to specialized executions.
      const isStructure = this.isStructure(this.constructionType);
      if (!isStructure) {
        // Defer validation and gold deduction to the specific execution
        this.completeConstruction();
        this.active = false;
        return;
      }

      // Structures: build real unit and mark under construction.
      // Server validates ownership/resources/build limits/placement rules/
      // construction cooldown inside canBuild (5.2). Cooldown for factories
      // is enforced here (intent path) so direct buildUnit setup bypasses it.
      if (this.constructionType === UnitType.Factory) {
        const impl = this.player as unknown as {
          factoryCooldownReady?: () => boolean;
          recordFactoryBuild?: () => void;
        };
        if (
          impl.factoryCooldownReady !== undefined &&
          !impl.factoryCooldownReady()
        ) {
          console.warn(`cannot build Factory: construction cooldown`);
          this.active = false;
          return;
        }
      }
      const spawnTile = this.player.canBuild(this.constructionType, this.tile);
      if (spawnTile === false) {
        console.warn(`cannot build ${this.constructionType}`);
        this.active = false;
        return;
      }
      const params =
        this.constructionType === UnitType.Factory
          ? { factoryType: this.factoryType ?? FactoryType.Civilian }
          : {};
      this.structure = this.player.buildUnit(
        this.constructionType,
        spawnTile,
        params,
      );
      if (this.constructionType === UnitType.Factory) {
        const impl = this.player as unknown as {
          recordFactoryBuild?: () => void;
        };
        impl.recordFactoryBuild?.();
      }
      const duration =
        this.constructionType === UnitType.Factory
          ? this.mg
              .config()
              .factoryConstructionDuration(
                this.factoryType ?? FactoryType.Civilian,
                this.player,
              )
          : this.scaledConstructionDuration(info.constructionDuration ?? 0);
      if (duration > 0) {
        this.structure.setUnderConstruction(true);
        this.ticksUntilComplete = duration;
        return;
      }
      // No construction time
      this.completeConstruction();
      this.active = false;
      return;
    }

    if (!this.structure.isActive()) {
      this.active = false;
      return;
    }

    if (this.player !== this.structure.owner()) {
      this.player = this.structure.owner();
    }

    if (this.ticksUntilComplete === 0) {
      this.player = this.structure.owner();
      this.completeConstruction();
      this.active = false;
      return;
    }
    this.ticksUntilComplete--;
  }

  /**
   * A base structure build time adjusted for the builder's Industry
   * "rapid construction" perk (Prompt 6). Higher speed percent = fewer ticks.
   * Integer percents keep the sim deterministic, and the ceil guarantees a
   * strong perk shortens a build without ever making it free.
   *
   * Only the perk, not the match pacing: ordinary structures are paced
   * elsewhere (or not at all), and re-timing them here would silently change
   * every existing structure duration in rapid and extended matches. A player
   * with no perk gets exactly the build time they always got.
   */
  private scaledConstructionDuration(base: number): number {
    const bonus = perkBonusFor(this.player, "construction");
    if (base <= 0 || bonus <= 0) return base;
    return Math.max(1, Math.ceil((base * 100) / (100 + bonus)));
  }

  private completeConstruction() {
    if (this.structure) {
      this.structure.setUnderConstruction(false);
    }
    const player = this.player;
    // Match XP (Prompt 6, 6.1): constructing industry is a meaningful
    // strategic act, so finishing a structure pays for it. Keyed by UnitType,
    // and an unrecognized type pays nothing — so this can never become a
    // generic "build anything" XP faucet.
    player.addMatchXP(xpForStructure(this.constructionType));
    switch (this.constructionType) {
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb: {
        const count = this.amount ?? 1;
        for (let i = 0; i < count; i++) {
          // NukeExecution staggers same-tick launches per silo itself.
          this.mg.addExecution(
            new NukeExecution(
              this.constructionType,
              player,
              this.tile,
              null,
              -1,
              0,
              this.rocketDirectionUp,
            ),
          );
        }
        break;
      }
      case UnitType.MIRV:
        this.mg.addExecution(new MirvExecution(player, this.tile));
        break;
      case UnitType.Warship:
        this.mg.addExecution(
          new WarshipExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.Port:
        this.mg.addExecution(new PortExecution(this.structure!));
        break;
      case UnitType.MissileSilo:
        this.mg.addExecution(new MissileSiloExecution(this.structure!));
        break;
      case UnitType.DefensePost:
        this.mg.addExecution(new DefensePostExecution(this.structure!));
        break;
      case UnitType.SAMLauncher:
        this.mg.addExecution(
          new SAMLauncherExecution(player, null, this.structure!),
        );
        break;
      case UnitType.City:
        this.mg.addExecution(new CityExecution(this.structure!));
        break;
      case UnitType.Factory:
        this.mg.addExecution(new FactoryExecution(this.structure!));
        break;
      default:
        console.warn(
          `unit type ${this.constructionType} cannot be constructed`,
        );
        break;
    }
  }

  private isStructure(type: UnitType): boolean {
    switch (type) {
      case UnitType.Port:
      case UnitType.MissileSilo:
      case UnitType.DefensePost:
      case UnitType.SAMLauncher:
      case UnitType.City:
      case UnitType.Factory:
        return true;
      default:
        return false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ConstructionExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      constructionType: this.constructionType,
      tile: this.tile,
      rocketDirectionUp: this.rocketDirectionUp,
      amount: this.amount,
      factoryType: this.factoryType ?? null,
      structure: w.unitOrNull(this.structure),
      ticksUntilComplete: this.ticksUntilComplete,
    });
  }

  restoreSnapshot(s: ConstructionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.constructionType = s.constructionType;
    this.tile = s.tile;
    this.rocketDirectionUp = s.rocketDirectionUp;
    this.amount = s.amount;
    this.factoryType = s.factoryType ?? undefined;
    this.structure = r.unitOrNull(s.structure);
    this.ticksUntilComplete = s.ticksUntilComplete as Tick;
  }
}

const FactoryTypeSchema = z.enum([
  FactoryType.Civilian,
  FactoryType.Military,
  FactoryType.Air,
  FactoryType.Research,
  FactoryType.SupplyHub,
  FactoryType.MissileFacility,
]);

const ConstructionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  constructionType: UnitTypeSchema,
  // Validated in init, so a pending execution may hold any number.
  tile: zInt(),
  rocketDirectionUp: z.boolean().optional(),
  amount: zInt().optional(),
  factoryType: FactoryTypeSchema.nullable().optional(),
  structure: zRef().nullable(),
  // Unset until a structure with a build time is placed.
  ticksUntilComplete: zInt().optional(),
});
type ConstructionState = z.infer<typeof ConstructionStateSchema>;

export const ConstructionExecutionSnapshot = execSnapshotType({
  name: "Construction",
  version: 2,
  schema: ConstructionStateSchema,
  cls: () => ConstructionExecution,
  migrations: {
    1: (d: any) => ({ ...d, factoryType: null }),
  },
});
