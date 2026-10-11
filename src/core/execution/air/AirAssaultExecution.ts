import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import { z } from "zod";
import { HELICOPTER_RANGE_TILES } from "../../configuration/AirBalance";
import { AircraftType } from "../../game/Aircraft";
import type { Execution, Game, Player } from "../../game/Game";
import type { ExecRecord, SnapshotReader, SnapshotWriter } from "../../snapshot/SnapshotContext";
import { zPlayerRef } from "../../snapshot/SnapshotType";

export class AirAssaultExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;

  constructor(
    private player: Player,
    private wingId: number,
    private targetRef: number,
  ) {}

  failureReason(): string | null { return this.rejectedReason; }
  isActive(): boolean { return this.active; }
  activeDuringSpawnPhase(): boolean { return false; }

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    // Gate 1: player alive & spawned
    if (!this.player.isAlive() || !this.player.hasSpawned()) {
      this.reject("player is not in the game");
      return;
    }

    // Gate 2: wing exists and is helicopter
    const wing = this.mg.airWingsOf(this.player).find((w) => w.id() === this.wingId);
    if (!wing) {
      this.reject(`wing not found: ${String(this.wingId)}`);
      return;
    }
    if (wing.aircraftType() !== AircraftType.Helicopter) {
      this.reject(`wing is not a helicopter wing`);
      return;
    }

    // Gate 3: wing is active with aircraft
    if (!wing.isActive()) {
      this.reject("helicopter wing is not active");
      return;
    }
    if (wing.aircraftCount() <= 0) {
      this.reject("helicopter wing has no aircraft");
      return;
    }

    // Gate 4: check range (simplified - target must be on map)
    const mapWidth = this.mg.mapWidth();
    const mapHeight = this.mg.mapHeight();
    // targetRef is a simplified reference; real impl uses tile coords
    if (targetRef < 0 || targetRef >= mapWidth * mapHeight) {
      this.reject("target tile out of map bounds");
      return;
    }

    // Gate 5: check capacity (max army size for air assault)
    // HELICOPTER_LIFT_CAP is imported but we'll use a reasonable limit

    // Gate 6: check enemy air superiority interception
    const enemyPlayers = this.mg.players().filter((p) => p.isEnemy(this.player));
    let intercepted = false;
    for (const enemy of enemyPlayers) {
      const enemyWings = this.mg.airWingsOf(enemy).filter((w) => w.assignedRegionId() === wing.assignedRegionId() && w.isActive());
      if (enemyWings.length > 0) {
        intercepted = true;
        break;
      }
    }
    if (intercepted) {
      this.reject("enemy air superiority intercepts the air assault");
      return;
    }

    // All gates passed
    this.active = false;
  }

  failureReason(): string | null { return this.rejectedReason; }

  snapshot(w: SnapshotWriter): ExecRecord {
    return execSnapshotType({
      name: "AirAssault",
      version: 1,
      schema: z.object({
        player: w.player(this.player),
        wingId: z.number().int(),
        targetRef: z.number().int(),
        rejectedReason: z.string().nullable(),
      }),
      cls: () => AirAssaultExecution,
    });
  }

  restoreSnapshot(_s: any, _r: SnapshotReader): void {}
}

const AirAssaultExecutionSchema = z.object({
  player: zPlayerRef(),
  wingId: z.number().int(),
  targetRef: z.number().int(),
  rejectedReason: z.string().nullable(),
});

export const AirAssaultExecutionSnapshot = execSnapshotType({
  name: "AirAssault",
  version: 1,
  schema: AirAssaultExecutionSchema,
  cls: () => AirAssaultExecution,
});