import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import { z } from "zod";
import { HELICOPTER_LIFT_CAP, HELICOPTER_LIFT_COOLDOWN_TICKS } from "../../configuration/AirBalance";
import { AircraftType } from "../../game/Aircraft";
import type { Execution, Game, Player } from "../../game/Game";
import type { ExecRecord, SnapshotReader, SnapshotWriter } from "../../snapshot/SnapshotContext";
import { zPlayerRef } from "../../snapshot/SnapshotType";

export class AirLiftExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;

  constructor(
    private player: Player,
    private wingId: number,
    private destinationRef: number,
  ) {}

  failureReason(): string | null { return this.rejectedReason; }
  isActive(): boolean { return this.active; }
  activeDuringSpawnPhase(): boolean { return false; }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    // TODO: full validation and lift execution per prompt 8.3
    this.reject("airlift execution not yet fully implemented");
  }

  failureReason(): string | null { return this.rejectedReason; }

  snapshot(w: SnapshotWriter): ExecRecord {
    return execSnapshotType({
      name: "AirLift",
      version: 1,
      schema: z.object({
        player: w.player(this.player),
        wingId: z.number().int(),
        destinationRef: z.number().int(),
        rejectedReason: z.string().nullable(),
      }),
      cls: () => AirLiftExecution,
    });
  }

  restoreSnapshot(_s: any, _r: SnapshotReader): void {}
}

const AirLiftExecutionSchema = z.object({
  player: zPlayerRef(),
  wingId: z.number().int(),
  destinationRef: z.number().int(),
  rejectedReason: z.string().nullable(),
});

export const AirLiftExecutionSnapshot = execSnapshotType({
  name: "AirLift",
  version: 1,
  schema: AirLiftExecutionSchema,
  cls: () => AirLiftExecution,
});