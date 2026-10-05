// ArmyExecution — the per-army tick: upkeep, movement, orders.
//
// One of these runs for the lifetime of every army. It owns supply,
// organization, attrition and pathing; it deliberately does NOT own combat.
//
// Combat stays in AttackExecution (see `engageIfReached`): an offensive order
// hands the army's troops to the ordinary attack loop and reads the result
// back through `army.combatState()`. That keeps one set of conquest,
// fortification and defender-attrition rules in the game instead of two that
// drift apart.
//
// Cadence: movement and the supply/organization upkeep run once a second
// (the balances' intervals); the tick itself is cheap.

import { z } from "zod";
import {
  ARMY_ATTRITION_TENTHS_PER_TICK,
  ARMY_DISBAND_TICKS_BELOW_MIN_STRENGTH,
  ARMY_MIN_STRENGTH,
  ARMY_MOVE_INTERVAL_TICKS,
  ARMY_ORGANIZATION_REGEN_PER_TICK,
  ARMY_SUPPLY_ORGANIZATION_PENALTY,
  ARMY_TILES_PER_SPEED,
  ARMY_UPKEEP_INTERVAL_TICKS,
} from "../../configuration/ArmyBalance";
import type { Army } from "../../game/Army";
import { terrainAdjustedSpeed } from "../../game/ArmyComposition";
import { Execution, Game, Player } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zInt, zRef } from "../../snapshot/SnapshotType";
import { AttackExecution } from "../AttackExecution";

/** Reusable cardinal neighbor buffer; avoids a per-tick allocation. */
const CARDINALS: TileRef[] = [0, 0, 0, 0];
/** Reusable 8-neighbor buffer for the movement step. */
const AROUND: TileRef[] = new Array(8).fill(0) as TileRef[];

/**
 * Hard bound on the supply search below. A support-heavy army can reach far,
 * but not arbitrarily far: past this many steps supply is zero regardless, so
 * the walk stops.
 */
const MAX_SUPPLY_STEPS = 48;

export class ArmyExecution implements Execution {
  private mg: Game | undefined;
  private active = true;
  /** Ticks until the next movement evaluation. */
  private moveTimer = 0;
  /** Ticks until the next supply/organization evaluation. */
  private upkeepTimer = 0;

  constructor(private army: Army) {}

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
    const army = this.army;
    if (!army.isActive() || !army.owner().isAlive()) {
      this.disband();
      return;
    }

    if (--this.upkeepTimer <= 0) {
      this.upkeepTimer = ARMY_UPKEEP_INTERVAL_TICKS;
      this.runUpkeep();
      if (!this.active) return;
    }

    if (--this.moveTimer <= 0) {
      this.moveTimer = ARMY_MOVE_INTERVAL_TICKS;
      this.runOrder();
    }
  }

  // --- upkeep ------------------------------------------------------------

  /**
   * Supply, organization and attrition, once a second.
   *
   * Supply is distance-based and deliberately the whole supply system for now:
   * no depots, no captured trucks. An army inside its owner's territory is at
   * full supply; past the border it falls off with how far it has pushed,
   * scaled by the composition's supply stat. Below `sufficient` an army bleeds
   * strength and heals at a crawl, which is what stops a single army from
   * steamrolling across the whole map unopposed.
   */
  private runUpkeep(): void {
    const army = this.army;

    // While an offensive is running the army's troops live on the
    // AttackExecution, so army.totalStrength() is legitimately zero — it is
    // not an empty army, it is a committed one. Attrition, supply and the
    // disband check all read strength, so they are skipped for the duration;
    // what still applies is morale recovery between the army's fights.
    if (army.combatState() === "attacking") {
      army.addOrganization(ARMY_ORGANIZATION_REGEN_PER_TICK);
      return;
    }

    const stats = army.derivedStats();

    army.setSupply(this.computeSupply(stats.supply));

    switch (army.supplyStatus()) {
      case "sufficient":
        army.addOrganization(
          Math.max(
            1,
            Math.floor(
              (ARMY_ORGANIZATION_REGEN_PER_TICK * stats.organization) / 100,
            ),
          ),
        );
        break;
      case "starving":
        army.addOrganization(-ARMY_ORGANIZATION_REGEN_PER_TICK);
        break;
      default:
        // strained / cut: the same regen, scaled down.
        army.addOrganization(
          Math.max(
            1,
            Math.floor(
              (ARMY_ORGANIZATION_REGEN_PER_TICK *
                stats.organization *
                ARMY_SUPPLY_ORGANIZATION_PENALTY) /
                10_000,
            ),
          ),
        );
        break;
    }

    if (army.supplyStatus() !== "sufficient") {
      // Attrition in tenths of a percent of current strength per upkeep tick,
      // so an over-extended army bleeds out over a minute or two.
      army.applyLosses(
        (army.totalStrength() * ARMY_ATTRITION_TENTHS_PER_TICK) / 1000,
      );
    }

    if (army.totalStrength() < ARMY_MIN_STRENGTH) {
      army.setStarvingTicks(army.starvingTicks() + 1);
      if (army.starvingTicks() >= ARMY_DISBAND_TICKS_BELOW_MIN_STRENGTH) {
        this.disband();
      }
    } else {
      army.setStarvingTicks(0);
    }
  }

  /**
   * Supply percent: 100 inside the owner's territory, falling off with the
   * number of steps of hostile or unowned ground between the army and the
   * nearest tile its owner holds. Returns 0 once that exceeds the composition's
   * reach.
   */
  private computeSupply(supplyStat: number): number {
    const mg = this.mg!;
    const owner = this.army.owner();
    if (mg.owner(this.army.tile()) === owner) return 100;
    // Six tiles of reach per 10 supply points, so a balanced army (supply 95)
    // reaches ~57 tiles from home and an all-support army reaches ~96.
    const reach = Math.min(MAX_SUPPLY_STEPS, Math.floor((supplyStat * 6) / 10));
    if (reach <= 0) return 0;
    const distance = this.distanceToFriendlyTile(
      this.army.tile(),
      owner,
      reach,
    );
    if (distance <= 0) return 100;
    if (distance >= reach) return 0;
    return Math.floor((100 * (reach - distance)) / reach);
  }

  /**
   * Steps of hostile or unowned land between `from` and the nearest tile
   * `owner` holds, searching at most `maxDepth` steps out. Returns `maxDepth`
   * when nothing friendly is that close, which the caller reads as zero supply.
   */
  private distanceToFriendlyTile(
    from: TileRef,
    owner: Player,
    maxDepth: number,
  ): number {
    const mg = this.mg!;
    if (mg.owner(from) === owner) return 0;
    const seen = new Set<TileRef>([from]);
    let frontier: TileRef[] = [from];
    for (let depth = 1; depth <= maxDepth; depth++) {
      const next: TileRef[] = [];
      for (const tile of frontier) {
        const count = mg.neighbors4(tile, CARDINALS);
        for (let i = 0; i < count; i++) {
          const n = CARDINALS[i];
          if (seen.has(n)) continue;
          if (!mg.isLand(n) || mg.isImpassable(n)) continue;
          if (mg.owner(n) === owner) return depth;
          seen.add(n);
          next.push(n);
        }
      }
      if (next.length === 0) return maxDepth;
      frontier = next;
    }
    return maxDepth;
  }

  // --- orders ------------------------------------------------------------

  private runOrder(): void {
    const order = this.army.order();
    switch (order.type) {
      case "move":
        this.stepTowards(order.tile);
        break;
      case "attack":
        // No marching first: AttackExecution collects the target tiles from
        // the owner's border, so an offensive is launched from wherever the
        // army is standing — the same rule a human follows when they click a
        // tile from across their own territory. Moving is a separate order.
        this.engage(order.tile);
        break;
      case "hold":
        this.army.setMovementState("holding");
        break;
      case "reinforce":
      case "createFront":
      case "stop":
      default:
        // All three are instantaneous: the order execution already applied
        // them, so there is nothing left to do but stand still.
        this.army.setMovementState("idle");
        break;
    }
  }

  /**
   * One movement evaluation toward `target`: advance up to the army's
   * terrain-adjusted speed, over friendly or neutral land only. Hostile ground
   * is off limits — taking it is what an `attack` order is for.
   *
   * Neutral ground is walkable on purpose: an army may cross unclaimed space to
   * reach a position it wants. Supply (see computeSupply) is what stops one from
   * marching into the void and staying there, not a movement rule.
   */
  private stepTowards(target: TileRef): void {
    const mg = this.mg!;
    const army = this.army;
    const from = army.tile();
    if (from === target) {
      army.setMovementState("holding");
      return;
    }

    const steps = this.movementBudget(from);
    if (steps <= 0) {
      army.setMovementState("idle");
      return;
    }

    const owner = army.owner();
    let current = from;
    let best = from;
    let bestDistance = this.tileDistance(from, target);

    for (let step = 0; step < steps; step++) {
      const count = mg.neighbors8(current, AROUND);
      let next: TileRef | null = null;
      let nextDistance = bestDistance;
      for (let i = 0; i < count; i++) {
        const n = AROUND[i];
        if (!mg.isLand(n) || mg.isImpassable(n)) continue;
        const ownerOf = mg.owner(n);
        if (ownerOf.isPlayer() && ownerOf !== owner) continue;
        const d = this.tileDistance(n, target);
        if (d < nextDistance) {
          next = n;
          nextDistance = d;
        }
      }
      if (next === null) break;
      current = next;
      best = next;
      bestDistance = nextDistance;
    }

    if (best === from) {
      army.setMovementState("holding");
      return;
    }
    army.setTile(best);
    army.setMovementState("moving");
  }

  /**
   * Tiles advanced per movement evaluation, from the composition's speed on the
   * terrain under the army. At least one tile while it still has troops, so an
   * army in rough terrain still crawls forward.
   */
  private movementBudget(from: TileRef): number {
    if (this.army.totalStrength() < ARMY_MIN_STRENGTH) return 0;
    const speed = terrainAdjustedSpeed(
      this.army.composition(),
      this.mg!.terrainType(from),
    );
    if (speed <= 0) return 0;
    return Math.max(1, Math.floor((speed * ARMY_TILES_PER_SPEED) / 100));
  }

  /**
   * Manhattan grid distance — the step-selection metric.
   *
   * Deliberately not Chebyshev: with 8-way movement a diagonal step leaves the
   * Chebyshev distance unchanged, so a "strictly closer" step rule refuses to
   * leave the diagonal at all and an army walks into a corner two tiles from
   * its destination. Manhattan falls by 2 on a diagonal step, so every legal
   * step is strictly improving and the walk terminates.
   */
  private tileDistance(a: TileRef, b: TileRef): number {
    const mg = this.mg!;
    return Math.abs(mg.x(a) - mg.x(b)) + Math.abs(mg.y(a) - mg.y(b));
  }

  // --- combat ------------------------------------------------------------

  /**
   * Open an offensive against the ordered tile, if it is something the owner
   * is allowed to attack.
   *
   * The troops leave the army here and live on the AttackExecution from that
   * point; AttackExecution keeps the army's strength, statistics, veterancy and
   * combat state in step, and sets combatState back to "none" when the fight
   * ends. That is also how this execution knows the army is free again.
   */
  private engage(target: TileRef): void {
    const mg = this.mg!;
    const army = this.army;
    // Already committed to a fight: one offensive at a time.
    if (army.combatState() === "attacking") return;
    if (army.totalStrength() < ARMY_MIN_STRENGTH) return;

    const ownerOf = mg.owner(target);
    if (ownerOf === army.owner()) {
      // Nothing to fight here; hold instead of ordering a pointless attack.
      army.setOrder({ type: "hold" });
      army.setMovementState("holding");
      return;
    }
    if (!army.owner().canAttack(target)) return;

    army.setCombatState("attacking");
    army.setMovementState("engaging");
    army.recordBattleFought();

    mg.addExecution(
      new AttackExecution(
        army.totalStrength(),
        army.owner(),
        ownerOf.isPlayer() ? ownerOf.id() : null,
        null,
        true,
        army,
      ),
    );
  }

  // --- lifecycle ---------------------------------------------------------

  private disband(): void {
    this.army.delete();
    this.mg?.removeArmy(this.army);
    this.active = false;
  }

  // --- snapshot ----------------------------------------------------------

  snapshot(w: SnapshotWriter): ExecRecord {
    return ArmyExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      army: w.army(this.army),
      moveTimer: this.moveTimer,
      upkeepTimer: this.upkeepTimer,
    });
  }

  restoreSnapshot(s: ArmyExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.army = r.army(s.army);
    this.moveTimer = s.moveTimer;
    this.upkeepTimer = s.upkeepTimer;
  }
}

const ArmyExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  army: zRef(),
  moveTimer: zInt(),
  upkeepTimer: zInt(),
});
type ArmyExecutionState = z.infer<typeof ArmyExecutionStateSchema>;

export const ArmyExecutionSnapshot = execSnapshotType({
  name: "ArmyExecution",
  version: 1,
  schema: ArmyExecutionStateSchema,
  cls: () => ArmyExecution,
});
