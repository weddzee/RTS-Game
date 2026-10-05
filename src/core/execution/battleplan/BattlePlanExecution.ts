// BattlePlanExecution Ä‚ËĂ˘â€šÂ¬Ă˘â‚¬ĹĄ one per live plan, running it.
//
// This is where a drawn arrow becomes an army actually attacking. The shape of
// it is deliberately not "follow the arrow": the arrow is player *intent*, and
// intent is not a legal route on its own. Once a second the plan re-reads the
// map and decides, from scratch, one thing:
//
//     given the frontier as it stands now, which adjacent tile should we take
//     next?
//
// The answer is `chooseAttackTarget`, which only ever considers tiles touching
// the live frontier. That is what makes an army not teleport: the set of tiles
// it can ever be ordered to attack is always the ring around ground it holds.
// When a target changes hands the plan advances its waypoint cursor along the
// canonical route and asks again, so the offensive progresses step by step
// toward the drawn destination rather than in one rush (Prompt 4.5).
//
// Every kind has a branch:
//   - `offensive` / `spearhead`: progress along the route. A spearhead is the
//     same loop with a narrower candidate lane, which is what makes it faster,
//     more fragile, and easier to encircle.
//   - `frontline`: hold the line, attack nothing.
//   - `move`: walk the assigned armies along the drawn line, attack nothing.
//   - `hold`: cancel every offensive and stand. This is the 4.7 order, and it is
//     reachable from any other kind because the plan's own status is what stops
//     it Ä‚ËĂ˘â€šÂ¬Ă˘â‚¬ĹĄ a paused plan issues nothing.
//   - `fallback`: keep assigned armies inside the drawn defensive line. When
//     one's supply gives out it walks back to the nearest line tile. Deliberately
//     crude (4.8 says manual triggering is acceptable for now): an army that is
//     still fighting finishes its fight first.

import { z } from "zod";
import {
  BATTLE_PLAN_FALLBACK_TRIGGER_SUPPLY,
  BATTLE_PLAN_STRATEGY_INTERVAL_TICKS,
} from "../../configuration/BattlePlanBalance";
import type { Army } from "../../game/Army";
import { BattlePlanImpl } from "../../game/BattlePlanImpl";
import { chooseAttackTarget, liveFrontier } from "../../game/BattlePlanRoute";
import { Execution, Game } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zInt, zRef } from "../../snapshot/SnapshotType";

export class BattlePlanExecution implements Execution {
  private mg: Game | undefined;
  private active = true;
  /** Ticks until the next strategic re-evaluation. */
  private strategyTimer = 0;
  /** Last tile ordered, so the plan does not re-issue an identical order. */
  private lastTarget: TileRef | null = null;

  constructor(private plan: BattlePlanImpl) {}

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === undefined) {
      this.active = false;
      return;
    }
    const plan = this.plan;
    const owner = plan.owner();

    // A plan whose owner is gone has nothing left to decide. The plan record
    // itself stays on the map as a record of what was ordered, matching how a
    // completed plan is kept.
    if (!owner.isAlive() || plan.armyIDs().length === 0) {
      this.active = false;
      return;
    }

    if (--this.strategyTimer > 0) return;
    this.strategyTimer = BATTLE_PLAN_STRATEGY_INTERVAL_TICKS;

    if (!plan.isRunning()) {
      this.lastTarget = null;
      return;
    }

    switch (plan.kind()) {
      case "offensive":
      case "spearhead":
        this.runOffensive(mg, plan);
        break;
      case "fallback":
        this.runFallback(mg, plan);
        break;
      case "move":
        this.runMove(mg, plan);
        break;
      case "frontline":
      case "hold":
        this.runHold(mg, plan);
        break;
    }
  }

  // --- offensive ----------------------------------------------------------

  /**
   * One step of a progressive offensive.
   *
   * Three phases, in this order, because they can each end the step:
   *   1. Advance the waypoint cursor past anything already ours. The route is
   *      fixed at draw time but the map has moved since, so a waypoint two
   *      territory changes ago is not a target any more.
   *   2. If nothing is left to walk to, the plan is done.
   *   3. Otherwise pick the best adjacent target and give the assigned armies
   *      something to do about it.
   */
  private runOffensive(mg: Game, plan: BattlePlanImpl): void {
    const owner = plan.owner();
    const route = plan.route();
    this.advanceWaypoint(mg, plan);
    if (route.length === 0) {
      // The drawn destination was unreachable, so the plan has degenerated to
      // holding the front it was given. Say so rather than idling silently.
      this.holdAll(plan);
      return;
    }
    if (plan.step() >= route.length - 1 && this.ownsWaypoint(mg, plan)) {
      plan.setStatus("completed");
      this.holdAll(plan);
      return;
    }

    const frontier = liveFrontier(mg, owner, plan.frontier());
    if (frontier.length === 0) {
      // The front has been overrun or absorbed into the interior. There is
      // nothing left to push from, so stop pushing rather than pick a target
      // the army cannot reach.
      this.holdAll(plan);
      return;
    }

    const target = chooseAttackTarget(
      mg,
      owner,
      plan.kind(),
      frontier,
      plan.currentWaypoint(),
    );
    if (target === null) {
      this.holdAll(plan);
      return;
    }

    if (target === this.lastTarget && this.allEngaged(plan, target)) {
      // Already pressing this tile with every assigned army. Re-ordering would
      // cancel the fight in progress, since an army takes one order at a time.
      return;
    }
    this.lastTarget = target;
    this.orderAttack(plan, target);
  }

  /**
   * Move the waypoint cursor forward past tiles the owner already holds.
   *
   * Strictly forward: a route is a direction, and a waypoint we have not reached
   * yet stays the goal even if some other tile on the route happens to be ours.
   */
  private advanceWaypoint(mg: Game, plan: BattlePlanImpl): void {
    const route = plan.route();
    let step = plan.step();
    while (step < route.length && mg.owner(route[step]) === plan.owner()) {
      step++;
    }
    plan.setStep(step);
  }

  private ownsWaypoint(mg: Game, plan: BattlePlanImpl): boolean {
    const waypoint = plan.currentWaypoint();
    return waypoint !== null && mg.owner(waypoint) === plan.owner();
  }

  /**
   * Point every free assigned army at the current target.
   *
   * Armies already committed to a fight are left alone: `Army.order()` is a
   * single value, so re-ordering an engaged army would cancel the AttackExecution
   * holding its troops and throw the battle away mid-resolve.
   */
  private orderAttack(plan: BattlePlanImpl, target: TileRef): void {
    const mg = this.mg!;
    for (const army of this.assignedArmies(plan)) {
      if (!mg.player(army.owner().id()).canAttack(target)) continue;
      if (army.combatState() === "attacking") continue;
      const order = army.order();
      if (order.type === "attack" && order.tile === target) continue;
      army.setOrder({ type: "attack", tile: target });
    }
  }

  private allEngaged(plan: BattlePlanImpl, target: TileRef): boolean {
    for (const army of this.assignedArmies(plan)) {
      if (army.combatState() === "attacking") continue;
      const order = army.order();
      if (order.type !== "attack" || order.tile !== target) return false;
    }
    return true;
  }

  // --- the other kinds ----------------------------------------------------

  /**
   * Man the drawn front. No attacks: the whole point of a frontline order is a
   * line the player wants held, not ground they want taken.
   */
  private runHold(mg: Game, plan: BattlePlanImpl): void {
    const frontier = liveFrontier(mg, plan.owner(), plan.frontier());
    for (const army of this.assignedArmies(plan)) {
      if (army.combatState() === "attacking") continue;
      // An army already inside the front holds where it stands; one that has
      // been pushed out walks back to the nearest tile of it.
      const outside = frontier.length > 0 && !frontier.includes(army.tile());
      if (outside) {
        const nearest = this.nearestOf(mg, frontier, army.tile());
        if (nearest !== null) {
          army.setOrder({ type: "move", tile: nearest });
          continue;
        }
      }
      army.setOrder({ type: "hold" });
    }
  }

  /**
   * A `move` plan is a drawn line with no fighting on it. Armies walk the route
   * in order, one waypoint at a time, and the plan does not care what is on the
   * far side of it.
   */
  private runMove(mg: Game, plan: BattlePlanImpl): void {
    const route = plan.route();
    if (route.length === 0) {
      this.holdAll(plan);
      return;
    }
    const target = plan.currentWaypoint();
    if (target === null) {
      plan.setStatus("completed");
      this.holdAll(plan);
      return;
    }
    for (const army of this.assignedArmies(plan)) {
      if (army.combatState() === "attacking") continue;
      if (mg.owner(target) === plan.owner()) {
        plan.setStep(plan.step() + 1);
        return;
      }
      army.setOrder({ type: "move", tile: target });
      return;
    }
  }

  /**
   * Fallback: keep assigned armies inside the drawn defensive line.
   *
   * An army that still has supply keeps doing whatever it was doing; one whose
   * supply has dropped to `cut` walks back to the nearest tile of the line. A
   * drawn line in the player's own territory is what makes this safe to do
   * automatically Ä‚ËĂ˘â€šÂ¬Ă˘â‚¬ĹĄ the destination is by construction not contested ground.
   */
  private runFallback(mg: Game, plan: BattlePlanImpl): void {
    const line = plan.fallbackLine();
    for (const army of this.assignedArmies(plan)) {
      if (army.combatState() === "attacking") continue;
      if (line.includes(army.tile())) {
        army.setOrder({ type: "hold" });
        continue;
      }
      if (army.supply() > BATTLE_PLAN_FALLBACK_TRIGGER_SUPPLY) continue;
      const nearest = this.nearestOf(mg, line, army.tile());
      if (nearest === null) continue;
      army.setOrder({ type: "move", tile: nearest });
    }
  }

  // --- helpers ------------------------------------------------------------

  private holdAll(plan: BattlePlanImpl): void {
    for (const army of this.assignedArmies(plan)) {
      if (army.order().type === "hold") continue;
      army.setOrder({ type: "hold" });
    }
  }

  /** Assigned armies that still exist. A disbanded army is simply absent. */
  private assignedArmies(plan: BattlePlanImpl): Army[] {
    const mg = this.mg!;
    const out: Army[] = [];
    for (const armyID of plan.armyIDs()) {
      const army = mg.army(armyID);
      if (army === undefined || !army.isActive()) continue;
      out.push(army);
    }
    return out;
  }

  /**
   * Nearest tile in `candidates`, by squared Euclidean distance with the lowest
   * ref breaking ties. Integer-only, so two clients pick the same tile.
   */
  private nearestOf(
    mg: Game,
    candidates: readonly TileRef[],
    from: TileRef,
  ): TileRef | null {
    let best: TileRef | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    const fx = mg.x(from);
    const fy = mg.y(from);
    for (const candidate of candidates) {
      const dx = mg.x(candidate) - fx;
      const dy = mg.y(candidate) - fy;
      const d = dx * dx + dy * dy;
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    return best;
  }

  // --- snapshot -----------------------------------------------------------

  snapshot(w: SnapshotWriter): ExecRecord {
    return BattlePlanExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      plan: w.battlePlan(this.plan),
      strategyTimer: this.strategyTimer,
      lastTarget: this.lastTarget,
    });
  }

  restoreSnapshot(s: BattlePlanExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.plan = r.battlePlan(s.plan) as BattlePlanImpl;
    this.strategyTimer = s.strategyTimer;
    this.lastTarget = s.lastTarget;
  }
}

const BattlePlanExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  plan: zRef(),
  strategyTimer: zInt(),
  lastTarget: zInt().nullable(),
});
type BattlePlanExecutionState = z.infer<typeof BattlePlanExecutionStateSchema>;

export const BattlePlanExecutionSnapshot = execSnapshotType({
  name: "BattlePlanExecution",
  version: 1,
  schema: BattlePlanExecutionStateSchema,
  cls: () => BattlePlanExecution,
});
