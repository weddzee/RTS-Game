// AirWingOrderExecution — station a wing and set its mission (Prompt 7.5, 7.6).
//
// One execution for both halves of "where is it going and what is it doing",
// because they are one player decision: moving a bomber to a new region and
// changing what it attacks is the same gesture.
//
// The mission is validated against the wing's own aircraft type here, not just
// in the entity, so an illegal pairing is reported as a rejection the tests and
// logs can see rather than silently ignored.

import { z } from "zod";
import type { AirMission } from "../../game/Aircraft";
import { validateAirMission } from "../../game/Aircraft";
import { Execution, Game, Player } from "../../game/Game";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zPlayerRef } from "../../snapshot/SnapshotType";

export class AirWingOrderExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;

  constructor(
    private player: Player,
    private wingId: number,
    private requestedRegionId: number | null,
    private requestedMission: AirMission,
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
    if (wing.owner() !== this.player) {
      this.reject(`air wing ${this.wingId} is not owned by the sender`);
      return;
    }
    const regionId = this.validateRegion(mg);
    if (regionId === false) {
      this.reject(`unknown air region ${String(this.requestedRegionId)}`);
      return;
    }
    if (
      validateAirMission(this.requestedMission, wing.aircraftType()) === null
    ) {
      this.reject(
        `${wing.aircraftType()} cannot fly ${String(this.requestedMission?.type)}`,
      );
      return;
    }
    wing.setAssignedRegionId(regionId);
    wing.setMission(this.requestedMission);
    this.active = false;
  }

  tick(ticks: number): void {
    this.active = false;
  }

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
    return AirWingOrderExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      wingId: this.wingId,
      requestedRegionId: this.requestedRegionId,
      requestedMission: { ...this.requestedMission } as AirMission,
      rejectedReason: this.rejectedReason,
    });
  }

  restoreSnapshot(s: AirWingOrderState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.wingId = s.wingId;
    this.requestedRegionId = s.requestedRegionId;
    this.requestedMission = s.requestedMission;
    this.rejectedReason = s.rejectedReason;
  }
}

const AirWingOrderStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  wingId: z.number().int(),
  requestedRegionId: z.number().int().nullable(),
  requestedMission: z.discriminatedUnion("type", [
    z.object({ type: z.literal("airSuperiority") }),
    z.object({ type: z.literal("intercept") }),
    z.object({
      type: z.literal("strike"),
      target: z.enum([
        "militaryIndustry",
        "airIndustry",
        "groundArmy",
        "infrastructure",
      ]),
    }),
  ]),
  rejectedReason: z.string().nullable(),
});
type AirWingOrderState = z.infer<typeof AirWingOrderStateSchema>;

export const AirWingOrderExecutionSnapshot = execSnapshotType({
  name: "AirWingOrder",
  version: 1,
  schema: AirWingOrderStateSchema,
  cls: () => AirWingOrderExecution,
});