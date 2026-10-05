// EditBattlePlanExecution — everything a player can do to a plan after drawing
// it (Prompt 4.9): pause, resume, redraw, reassign, delete.
//
// One execution for all five rather than five near-identical ones, because they
// share the only interesting part: proving the plan exists and the sender owns
// it. That check runs before anything else, so a client cannot use the edit path
// to discover a plan id it does not own — the same reasoning as
// ArmyOrderExecution.
//
// `redraw` re-derives the whole canonical geometry from a fresh gesture, exactly
// as creation does. It is not a patch: the old route is discarded rather than
// merged, because the new arrow is a new instruction and blending two of them
// would produce a plan neither of them asked for.

import { z } from "zod";
import {
  BATTLE_PLAN_MAX_ARMIES,
  BATTLE_PLAN_MAX_FRONTIER_TILES,
  BATTLE_PLAN_MAX_ROUTE_STEPS,
} from "../../configuration/BattlePlanBalance";
import {
  BATTLE_PLAN_ORDERS,
  isOffensiveOrder,
  type BattlePlanOrder,
} from "../../game/BattlePlan";
import type { BattlePlanImpl } from "../../game/BattlePlanImpl";
import {
  deriveOffensiveRoute,
  validateFallbackLine,
  validateFrontier,
} from "../../game/BattlePlanRoute";
import { Execution, Game, Player } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zInt, zPlayerRef, zTile } from "../../snapshot/SnapshotType";
import { CreateBattlePlanExecution } from "./CreateBattlePlanExecution";

/** The post-creation lifecycle operations, as sent on the wire. */
export type BattlePlanEditAction =
  | "pause"
  | "resume"
  | "delete"
  | "reassign"
  | "redraw";

export class EditBattlePlanExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private rejectedReason: string | null = null;

  constructor(
    private player: Player,
    private planId: number,
    private action: BattlePlanEditAction,
    private armyIDs: readonly number[] = [],
    private frontier: readonly TileRef[] = [],
    private route: readonly TileRef[] = [],
    private kind: BattlePlanOrder = "frontline",
  ) {}

  /** Why the edit was refused, for tests and logs. Null once it succeeded. */
  failureReason(): string | null {
    return this.rejectedReason;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (!this.player.isAlive() || !this.player.hasSpawned()) {
      this.reject("player is not in the game");
      return;
    }
    // Existence and ownership first, before anything else is looked at: a
    // client must not be able to learn whether a plan id it guessed exists.
    const plan = mg.battlePlan(this.planId);
    if (plan === undefined) {
      this.reject(`battle plan ${this.planId} not found`);
      return;
    }
    if (plan.owner() !== this.player) {
      this.reject(`battle plan ${this.planId} is not owned by the sender`);
      return;
    }
    if (this.armyIDs.length > BATTLE_PLAN_MAX_ARMIES) {
      this.reject("reassignment exceeds the plan army limit");
      return;
    }
    if (
      this.frontier.length > BATTLE_PLAN_MAX_FRONTIER_TILES ||
      this.route.length > BATTLE_PLAN_MAX_ROUTE_STEPS
    ) {
      this.reject("redraw exceeds the gesture size limit");
      return;
    }
    if (this.action === "redraw" && !BATTLE_PLAN_ORDERS.includes(this.kind)) {
      this.reject(`unknown battle plan kind ${this.kind}`);
      return;
    }
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === undefined || this.rejectedReason !== null) {
      this.active = false;
      return;
    }
    const plan = mg.battlePlan(this.planId) as BattlePlanImpl;
    if (plan === undefined || plan.owner() !== this.player) {
      // Deleted between init and tick, or the sender is gone. Nothing to do.
      this.active = false;
      return;
    }

    switch (this.action) {
      case "pause":
        // Standing a plan down is not the same as holding it: a paused plan
        // issues no orders at all, so an army mid-walk keeps walking and an army
        // mid-fight finishes it. `hold` is the order that stops them.
        plan.setStatus("paused");
        break;
      case "resume":
        // Resuming a finished plan would send it straight back to a destination
        // it already reached; resuming anything else picks up where it stopped.
        if (plan.status() !== "completed") plan.setStatus("active");
        break;
      case "delete":
        mg.removeBattlePlan(plan as BattlePlanImpl);
        break;
      case "reassign":
        CreateBattlePlanExecution.assign(mg, plan, this.armyIDs);
        break;
      case "redraw":
        this.redraw(mg, plan);
        break;
    }
    this.active = false;
  }

  /**
   * Re-derive the plan's geometry from a fresh gesture.
   *
   * Identical validation to creation, on purpose: a redraw is a create, and
   * running it through a second code path is how the two drift apart and the
   * second one stops being trustworthy.
   */
  private redraw(mg: Game, plan: BattlePlanImpl): void {
    const frontier = validateFrontier(mg, this.player, this.frontier);
    if (frontier.length === 0 && this.kind !== "fallback") {
      this.reject("drawn frontline does not lie on the owner's border");
      this.active = false;
      return;
    }
    const fallbackLine =
      this.kind === "fallback"
        ? validateFallbackLine(mg, this.player, this.frontier)
        : [];
    if (this.kind === "fallback" && fallbackLine.length === 0) {
      this.reject("drawn fallback line is not in the owner's territory");
      this.active = false;
      return;
    }
    const route = isOffensiveOrder(this.kind)
      ? deriveOffensiveRoute(mg, this.player, frontier, this.route)
      : [];

    plan.setKind(this.kind);
    plan.setGeometry(frontier, route, fallbackLine);
    // A redraw is an instruction to start again, whether the plan was running or
    // stood down: the player just drew a new arrow.
    plan.setStatus("active");
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
    return EditBattlePlanExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      planId: this.planId,
      action: this.action,
      armyIDs: [...this.armyIDs],
      frontier: [...this.frontier],
      route: [...this.route],
      kind: this.kind,
      rejectedReason: this.rejectedReason,
    });
  }

  restoreSnapshot(s: EditBattlePlanState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.planId = s.planId;
    this.action = s.action;
    this.armyIDs = [...s.armyIDs];
    this.frontier = [...s.frontier];
    this.route = [...s.route];
    this.kind = s.kind;
    this.rejectedReason = s.rejectedReason;
  }
}

const EditBattlePlanStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  planId: zInt(),
  action: z.enum(["pause", "resume", "delete", "reassign", "redraw"]),
  armyIDs: z.array(zInt()),
  frontier: z.array(zTile()),
  route: z.array(zTile()),
  kind: z.enum(BATTLE_PLAN_ORDERS),
  rejectedReason: z.string().nullable(),
});
type EditBattlePlanState = z.infer<typeof EditBattlePlanStateSchema>;

export const EditBattlePlanExecutionSnapshot = execSnapshotType({
  name: "EditBattlePlan",
  version: 1,
  schema: EditBattlePlanStateSchema,
  cls: () => EditBattlePlanExecution,
});
