// CreateBattlePlanExecution — turn a drawn gesture into a canonical plan.
//
// This is where the client stops being believed (Prompt 4.2). Everything the
// drag sent is a proposal: a list of tiles the pointer crossed and a list of
// tiles the arrow passed through. What gets stored is re-derived:
//
//   - The frontier keeps only tiles the sender owns *and* that border ground
//     they do not. A front drawn through the player's own interior, or across
//     land it does not own, cannot survive those two checks.
//   - The drawn route is not adopted. It is read for the tile the player was
//     pointing at, and the canonical route is searched for over passable land
//     with integer costs, so an arrow drawn across water becomes a route that
//     goes around it.
//   - Assigned armies must belong to the sender. Anything else is dropped
//     rather than refused, so a stale id in a stale panel costs the player one
//     army instead of the whole plan.
//
// Like CreateArmyExecution, init() only validates and tick() creates. The
// driver execution that actually runs the plan is added from tick(), because an
// execution added during another execution's init() is lost by the
// pending-execution forEach in GameImpl.executeNextTick.

import { z } from "zod";
import {
  BATTLE_PLAN_MAX_ARMIES,
  BATTLE_PLAN_MAX_FRONTIER_TILES,
  BATTLE_PLAN_MAX_PER_PLAYER,
  BATTLE_PLAN_MAX_ROUTE_STEPS,
} from "../../configuration/BattlePlanBalance";
import type { Army } from "../../game/Army";
import {
  BATTLE_PLAN_ORDERS,
  emptyBattlePlanState,
  isOffensiveOrder,
  type BattlePlanOrder,
} from "../../game/BattlePlan";
import { BattlePlanImpl } from "../../game/BattlePlanImpl";
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
import { zInt, zPlayerRef, zRef, zTile } from "../../snapshot/SnapshotType";
import { BattlePlanExecution } from "./BattlePlanExecution";

export interface BattlePlanProposal {
  kind: BattlePlanOrder;
  /** Tiles the pointer crossed, in draw order. */
  frontier: readonly TileRef[];
  /** The drawn arrow, already simplified by the client. Never trusted. */
  route: readonly TileRef[];
  armyIDs: readonly number[];
}

export class CreateBattlePlanExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private plan: BattlePlanImpl | null = null;
  private rejectedReason: string | null = null;

  constructor(
    private player: Player,
    private proposal: BattlePlanProposal,
  ) {}

  /** Why the plan was refused, for tests and logs. Null once it succeeded. */
  failureReason(): string | null {
    return this.rejectedReason;
  }

  createdPlan(): BattlePlanImpl | null {
    return this.plan;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (!this.player.isAlive() || !this.player.hasSpawned()) {
      this.reject("player is not in the game");
      return;
    }
    if (!BATTLE_PLAN_ORDERS.includes(this.proposal.kind)) {
      this.reject(`unknown battle plan kind ${this.proposal.kind}`);
      return;
    }
    // The wire schema caps these too. Re-checking here means the invariant holds
    // however the execution was constructed — a test, a future caller, or an
    // intent that reached core through a path the schema does not cover.
    if (
      this.proposal.frontier.length > BATTLE_PLAN_MAX_FRONTIER_TILES ||
      this.proposal.route.length > BATTLE_PLAN_MAX_ROUTE_STEPS ||
      this.proposal.armyIDs.length > BATTLE_PLAN_MAX_ARMIES
    ) {
      this.reject("drawn battle plan exceeds the gesture size limit");
      return;
    }
    if (mg.battlePlansOf(this.player).length >= BATTLE_PLAN_MAX_PER_PLAYER) {
      this.reject("battle plan cap reached");
      return;
    }
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === undefined || this.rejectedReason !== null) {
      this.active = false;
      return;
    }

    const frontier = validateFrontier(mg, this.player, this.proposal.frontier);
    // Every kind except `fallback` is drawn along the border, so a front the
    // owner does not actually hold is a plan with nothing to stand on. A
    // fallback is drawn in the interior instead, and is checked against that.
    if (frontier.length === 0 && this.proposal.kind !== "fallback") {
      this.reject("drawn frontline does not lie on the owner's border");
      return;
    }

    const fallbackLine =
      this.proposal.kind === "fallback"
        ? validateFallbackLine(mg, this.player, this.proposal.frontier)
        : [];
    if (this.proposal.kind === "fallback" && fallbackLine.length === 0) {
      this.reject("drawn fallback line is not in the owner's territory");
      return;
    }

    // Offensives derive their route; the rest carry no arrow. A `frontline`
    // plan is a front with nobody pushing it, which is a legitimate thing to
    // want and is not a failure.
    const route = isOffensiveOrder(this.proposal.kind)
      ? deriveOffensiveRoute(mg, this.player, frontier, this.proposal.route)
      : [];

    const state = emptyBattlePlanState(
      mg.nextBattlePlanID(),
      this.player.smallID(),
    );
    state.kind = this.proposal.kind;
    state.createdAt = mg.ticks();
    state.frontier = frontier;
    state.route = route;
    state.fallbackLine = fallbackLine;

    const plan = new BattlePlanImpl(state, this.player);
    this.plan = plan;
    mg.addBattlePlan(plan);

    CreateBattlePlanExecution.assign(mg, plan, this.proposal.armyIDs);

    // The driver owns the plan's ongoing behaviour: progressive targeting,
    // pausing, completion. Added here rather than in init() — see the header.
    mg.addExecution(new BattlePlanExecution(plan));
    this.active = false;
  }

  /**
   * Bind a set of armies to a plan, dropping any the sender does not own.
   *
   * Shared with EditBattlePlanExecution's reassign, so the two paths cannot drift
   * on what "this army can be on this plan" means. One army is on one plan: an
   * army joining leaves every other plan first, and an army dropped from this one
   * has its assignment cleared rather than being left pointing at a plan it is no
   * longer part of.
   */
  static assign(
    mg: Game,
    plan: BattlePlanImpl,
    armyIDs: readonly number[],
  ): number[] {
    const accepted: number[] = [];
    const seen = new Set<number>();
    for (const armyID of armyIDs) {
      if (seen.has(armyID)) continue;
      const army = mg.army(armyID);
      if (army === undefined || !army.isActive()) continue;
      if (army.owner() !== plan.owner()) continue;
      seen.add(armyID);
      CreateBattlePlanExecution.detachFromOtherPlans(mg, army, plan.id());
      accepted.push(armyID);
    }
    for (const armyID of plan.armyIDs()) {
      if (seen.has(armyID)) continue;
      mg.army(armyID)?.setAssignedBattlePlanId(null);
    }
    plan.setArmyIDs(accepted);
    for (const armyID of accepted) {
      mg.army(armyID)?.setAssignedBattlePlanId(plan.id());
    }
    return accepted;
  }

  /** Releases `army` from every plan that is not `keepPlanId`. */
  static detachFromOtherPlans(mg: Game, army: Army, keepPlanId: number): void {
    for (const other of mg.battlePlans()) {
      if (other.id() === keepPlanId) continue;
      const i = other.armyIDs().indexOf(army.id());
      if (i === -1) continue;
      (other as BattlePlanImpl).setArmyIDs(
        other.armyIDs().filter((id) => id !== army.id()),
      );
    }
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
    return CreateBattlePlanExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      proposal: {
        kind: this.proposal.kind,
        frontier: [...this.proposal.frontier],
        route: [...this.proposal.route],
        armyIDs: [...this.proposal.armyIDs],
      },
      rejectedReason: this.rejectedReason,
      plan: w.battlePlanOrNull(this.plan),
    });
  }

  restoreSnapshot(s: CreateBattlePlanState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.proposal = {
      kind: s.proposal.kind,
      frontier: [...s.proposal.frontier],
      route: [...s.proposal.route],
      armyIDs: [...s.proposal.armyIDs],
    };
    this.rejectedReason = s.rejectedReason;
    this.plan =
      s.plan === null ? null : (r.battlePlan(s.plan) as BattlePlanImpl);
  }
}

const ProposalSchema = z.object({
  kind: z.enum(BATTLE_PLAN_ORDERS),
  frontier: z.array(zTile()),
  route: z.array(zTile()),
  armyIDs: z.array(zInt()),
});

const CreateBattlePlanStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  proposal: ProposalSchema,
  rejectedReason: z.string().nullable(),
  plan: zRef().nullable(),
});
type CreateBattlePlanState = z.infer<typeof CreateBattlePlanStateSchema>;

export const CreateBattlePlanExecutionSnapshot = execSnapshotType({
  name: "CreateBattlePlan",
  version: 1,
  schema: CreateBattlePlanStateSchema,
  cls: () => CreateBattlePlanExecution,
});
