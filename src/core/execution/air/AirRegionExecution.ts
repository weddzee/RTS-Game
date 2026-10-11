// AirRegionExecution — the per-tick air war (Prompt 7.4, 7.5, 7.6, 7.7).
//
// One global execution, added by GameRunner.init(), that resolves every air
// region on a slow cadence. It is the only place where two wings interact.
//
// The order inside a region is fixed and matters:
//
//   1. power   — every wing's contribution, grouped by owner
//   2. share   — each owner's share of that region's air war (7.7)
//   3. recon   — patrol wings grant their owner a recon bonus (7.5)
//   4. air     — every enemy pair of wings exchanges one engagement wave
//   5. strike — bombers hit targets the SIMULATION picks (7.6)
//
// Air-to-air happens before strikes so a bomber caught by fighters this wave is
// already damaged when it flies, which is the whole point of escorts.
//
// Nothing here is a claim from the client. The client chose a mission category
// and a region; every target, every loss and every point of damage below is
// derived from state both clients already hold, in integer arithmetic.

import { z } from "zod";
import {
  AIR_ENGAGEMENT_INTERVAL_TICKS,
  AIR_MAX_STRIKE_AIRCRAFT,
  AIR_STRIKE_AIRCRAFT_PER_WAVE,
  AIR_XP_PER_AIRCRAFT_DESTROYED,
  AIR_XP_PER_DAMAGE,
  AIR_XP_PER_ENGAGEMENT,
  AIR_XP_PER_STRIKE,
} from "../../configuration/AirBalance";
import {
  type AircraftType,
  type BomberTargetCategory,
} from "../../game/Aircraft";
import type { AirWing } from "../../game/AirWing";
import {
  airGroundDefenseBonusPercent,
  airSuperiorityShare,
  airWaveDamage,
  aircraftLostInWave,
  bomberStrikePercent,
  AIR_PARITY_PERCENT,
  reconBonusPercent,
  STRIKE_FACTORY_DISABLE_TICKS,
  strikeArmyLosses,
  strikeFactoryDamage,
  wingPower,
} from "../../game/AirSuperiority";
import { FactoryType } from "../../game/Factory";
import type { Execution, Game, Player } from "../../game/Game";
import { Structures, UnitType } from "../../game/Game";
import type { AirRegionUpdate } from "../../game/GameUpdates";
import { GameUpdateType } from "../../game/GameUpdates";
import { perkBonusFor } from "../../game/Progression";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { zInt } from "../../snapshot/SnapshotType";

/** Accumulated damage a strike did, so the wing can be credited for it. */
interface StrikeOutcome {
  landed: boolean;
  damage: number;
}

export class AirRegionExecution implements Execution {
  private active = true;
  private mg: Game | undefined;
  private timer = AIR_ENGAGEMENT_INTERVAL_TICKS;
  /** Region ids resolved on the most recent wave. Diagnostics only. */
  private lastResolvedRegions = 0;

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === undefined) return;
    if (--this.timer > 0) return;
    this.timer = AIR_ENGAGEMENT_INTERVAL_TICKS;

    const wings = mg.airWings();
    if (wings.length === 0) {
      this.lastResolvedRegions = 0;
      return;
    }
    // Regions are visited in ascending id order and wings within a region in
    // creation order, so the whole wave is a pure function of state. Nothing
    // here depends on iteration order that could differ between clients.
const regionIds: number[] = [];
    for (const wing of wings) {
      const region = wing.assignedRegionId();
      if (region === null || !wing.isActive()) continue;
      if (wing.aircraftCount() <= 0) continue;
      if (!regionIds.includes(region)) regionIds.push(region);
    }
    regionIds.sort((a, b) => a - b);
    this.lastResolvedRegions = regionIds.length;

    // The region set is rebuilt from scratch every wave (7.8). That is what
    // makes a region vanish from the overlay the moment its last aircraft
    // leaves: there is no stale entry for a client to keep drawing.
    const regionUpdates: AirRegionUpdate[] = [];
    for (const regionId of regionIds) {
      this.resolveRegion(mg, regionId);
      const update = this.describeRegion(mg, regionId);
      if (update !== null) regionUpdates.push(update);
    }
    if (regionUpdates.length > 0) {
      for (const update of regionUpdates) mg.addUpdate(update);
    }
  }

  /** Regions resolved on the most recent wave. Diagnostics only. */
  resolvedRegionCount(): number {
    return this.lastResolvedRegions;
  }

  // -------------------------------------------------------------------------

  private resolveRegion(mg: Game, regionId: number): void {
    const wings = mg
      .airWingsInRegion(regionId)
      .filter((w) => w.isActive() && w.aircraftCount() > 0);
    if (wings.length === 0) return;

    const shares = computeRegionalShares(mg, wings);
    const recon = computeRegionalRecon(mg, wings);
    this.resolveAirToAir(mg, wings);
    this.resolveStrikes(mg, wings, shares, recon);
  }

/**
   * The region as a client sees it (7.8): where it is, who holds its sky, and
   * whether anyone is contesting it.
   *
   * The leader is the highest-share owner, ties broken by small id so two clients
   * agree on the colour without exchanging anything. Parity with no owner means
   * the region emptied mid-wave — no update, and the client drops it.
   */
  private describeRegion(mg: Game, regionId: number): AirRegionUpdate | null {
    const wings = mg
      .airWingsInRegion(regionId)
      .filter((w) => w.isActive() && w.aircraftCount() > 0);
    if (wings.length === 0) return null;
    const shares = computeRegionalShares(mg, wings);
    if (shares.size === 0) return null;

    let leaderID: number | null = null;
    let leaderShare = AIR_PARITY_PERCENT;
    for (const [ownerID, share] of shares) {
      if (leaderID === null || share > leaderShare) {
        leaderID = ownerID;
        leaderShare = share;
      }
    }
    if (leaderID === null) return null;

    // Contested means aircraft from more than one side, which is a different
    // question from who is winning: two allies in one region are not contesting
    // it, but two enemies are even if one is winning 90-10.
    const owners = new Set<number>();
    for (const wing of wings) owners.add(wing.owner().smallID());
    let contested = false;
    if (owners.size > 1) {
      for (const a of owners) {
        for (const b of owners) {
          if (a >= b) continue;
          const pa = asPlayer(mg, a);
          const pb = asPlayer(mg, b);
          if (pa === null || pb === null || pa.isFriendly(pb)) continue;
          contested = true;
        }
      }
    }

    const rect = mg.airRegions().bounds(regionId);
    if (rect === null) return null;
    return {
      type: GameUpdateType.AirRegion,
      regionId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      sharePercent: leaderShare,
      leaderSmallID: leaderID,
      contested,
    };
  }

  /**
   * Step 1 and 2: each owner's power in the region, and their share of it.
   *
   * Friendly players' air is *allied*, not pooled: two allies in the same region
   * add up to the same total power but neither gains share from the other, so
   * two allies cannot manufacture air superiority between them.
   */
  private resolveStrikes(
    mg: Game,
    wings: AirWing[],
    shares: Map<number, number>,
    recon: Map<number, number>,
  ): void {
    for (const wing of wings) {
      const mission = wing.mission();
      if (mission.type !== "strike") continue;
      const regionId = wing.assignedRegionId();
      if (regionId === null) continue;
      const owner = wing.owner();
      const ownerRecon = recon.get(owner.smallID()) ?? 0;
      const target = selectStrikeTarget(mg, owner, wing, regionId, mission.target);
      if (target === null) continue;
      const outcome = applyStrike(mg, owner, wing, target, shares, ownerRecon);
      if (outcome.landed) {
        wing.recordStrikeLanded(outcome.damage);
        wing.addExperience(AIR_XP_PER_STRIKE + AIR_XP_PER_DAMAGE * outcome.damage);
      }
    }
  }

  /**
   * Step 4: every unordered pair of enemy wings trades one engagement wave.
   *
   * Both sides shoot in the same pass, and losses are computed from the damage
   * each side put in, so nothing depends on who "went first". A pair of wings
   * that are allied or on the same team never engages.
   */
  private resolveAirToAir(mg: Game, wings: AirWing[]): void {
    const incoming = new Map<AirWing, number>();
    for (let i = 0; i < wings.length; i++) {
      const attacker = wings[i];
      for (let j = i + 1; j < wings.length; j++) {
        const defender = wings[j];
        if (attacker.owner().isFriendly(defender.owner())) continue;
        const a = airWaveDamage(
          attacker.aircraftCount(),
          attacker.mission(),
          attacker.experience(),
          airOwnerBonus(attacker.owner()),
          defender.aircraftType(),
        );
        const d = airWaveDamage(
          defender.aircraftCount(),
          defender.mission(),
          defender.experience(),
          airOwnerBonus(defender.owner()),
          attacker.aircraftType(),
        );
        incoming.set(attacker, (incoming.get(attacker) ?? 0) + d);
        incoming.set(defender, (incoming.get(defender) ?? 0) + a);
        attacker.recordEngagement();
        defender.recordEngagement();
      }
    }
    // Losses are applied after every pair has been scored, so a wing's losses
    // this wave never depend on the order the pairs were visited in.
    for (const wing of wings) {
      const damagePoints = incoming.get(wing) ?? 0;
      if (damagePoints <= 0) continue;
      const lost = aircraftLostInWave(
        wing.aircraftType(),
        wing.aircraftCount(),
        damagePoints,
      );
      if (lost <= 0) continue;
      wing.applyLosses(lost);
      wing.recordAircraftLost(lost);
      wing.addExperience(AIR_XP_PER_ENGAGEMENT);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    // Wings only exist after a player has spawned and built an air factory, so
    // there is nothing to resolve during the spawn phase.
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AirRegionExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      timer: this.timer,
      lastResolvedRegions: this.lastResolvedRegions,
    });
  }

  restoreSnapshot(s: AirRegionExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.timer = s.timer;
    this.lastResolvedRegions = s.lastResolvedRegions;
  }
}

// ---------------------------------------------------------------------------
// Regional picture
// ---------------------------------------------------------------------------

/** Per-owner share of the air war in one region, keyed by owner small id. */
export function computeRegionalShares(
  mg: Game,
  wings: AirWing[],
): Map<number, number> {
  const ownPower = new Map<number, number>();
  for (const wing of wings) {
    const ownerID = wing.owner().smallID();
    ownPower.set(
      ownerID,
      (ownPower.get(ownerID) ?? 0) +
        wingPower(
          wing.aircraftCount(),
          wing.mission(),
          wing.experience(),
          airOwnerBonus(wing.owner()),
        ),
    );
  }
  const shares = new Map<number, number>();
  for (const [ownerID, power] of ownPower) {
let enemy = 0;
    const owner = asPlayer(mg, ownerID);
    for (const [otherID, otherPower] of ownPower) {
      if (otherID === ownerID) continue;
      const other = asPlayer(mg, otherID);
      if (owner === null || other === null) continue;
      if (owner.isOnSameTeam(other)) continue;
      enemy += otherPower;
    }
    shares.set(ownerID, airSuperiorityShare(power, enemy));
  }
  return shares;
}

/** Per-owner recon bonus in one region, from patrol wings. */
export function computeRegionalRecon(
  mg: Game,
  wings: AirWing[],
): Map<number, number> {
  const patrols = new Map<number, number>();
  for (const wing of wings) {
    if (wing.mission().type !== "airSuperiority") continue;
    const ownerID = wing.owner().smallID();
    patrols.set(ownerID, (patrols.get(ownerID) ?? 0) + 1);
  }
  const recon = new Map<number, number>();
  for (const [ownerID, count] of patrols) {
    recon.set(ownerID, reconBonusPercent(count));
  }
  return recon;
}

/**
 * A player's Air Power doctrine bonus, as a percent on the 100 = base scale.
 */
export function airOwnerBonus(player: Player): number {
  return perkBonusFor(player, "air");
}

/**
 * `Game.playerBySmallID` answers "who owns this tile", which includes terra
 * nullius; the air war is only ever about real players, so every lookup here
 * goes through this and nulls out terra nullius rather than narrowing it
 * unsafely.
 */
function asPlayer(mg: Game, smallID: number): Player | null {
  const p = mg.playerBySmallID(smallID);
  return p !== undefined && p.isPlayer() ? p : null;
}

/**
 * The ground-combat modifier a defender's air superiority grants them in the
 * region containing a contested tile (7.5).
 *
 * Computed on demand from the defender's own wings in that region rather than
 * cached: it is a scan over a handful of wings per tile, and a cached value
 * would be derived state that a snapshot restore could reproduce differently —
 * which is exactly the kind of divergence this file exists to prevent. Read by
 * AttackExecution and passed into Config.attackLogic.
 */
export function airDefensePercentForTile(
  mg: Game,
  defender: Player,
  tile: number,
): number {
  const regionId = mg.airRegions().at(tile);
  if (regionId < 0) return 0;
  const wings = mg.airWingsInRegion(regionId).filter(
    (w) => w.isActive() && w.aircraftCount() > 0,
  );
  if (wings.length === 0) return 0;
  const shares = computeRegionalShares(mg, wings);
  return airGroundDefenseBonusPercent(shares.get(defender.smallID()) ?? 50);
}

// ---------------------------------------------------------------------------
// Target selection (7.6) — the server picks, the client only asks
// ---------------------------------------------------------------------------

export interface StrikeTarget {
  kind: "factory" | "army" | "structure";
  /** Tile the target sits on, for the panel and any follow-on effect. */
  tile: number;
  /** Factory specialization, when the target is a factory. */
  factoryType?: FactoryType;
  /** Unit or army id. */
  refId: number;
  /** Owning player's small id. */
  ownerID: number;
}

/**
 * Pick a valid target inside the assigned region for the mission category.
 *
 * Deterministic by construction: candidates are gathered in a fixed order and
 * the lowest unit/army id wins, so two clients with the same state pick the same
 * target without exchanging anything. Returns null when there is nothing to hit
 * — a bomber over empty land does not waste its sortie.
 */
export function selectStrikeTarget(
  mg: Game,
  owner: Player,
  wing: AirWing,
  regionId: number,
  category: BomberTargetCategory,
): StrikeTarget | null {
  const regions = mg.airRegions();
  if (!regions.isValid(regionId)) return null;
  const candidates: StrikeTarget[] = [];
  const seen = new Set<number>();

  for (const player of mg.players()) {
    if (!player.isAlive() || player === owner) continue;
    if (owner.isFriendly(player)) continue;
    switch (category) {
      case "militaryIndustry":
      case "airIndustry":
        for (const unit of player.units(UnitType.Factory)) {
          if (!unit.isActive() || seen.has(unit.id())) continue;
          if (regions.at(unit.tile()) !== regionId) continue;
          const wanted =
            category === "airIndustry"
              ? FactoryType.Air
              : FactoryType.Military;
          if (unit.factoryType() !== wanted) continue;
          seen.add(unit.id());
          candidates.push({
            kind: "factory",
            tile: unit.tile(),
            factoryType: unit.factoryType(),
            refId: unit.id(),
            ownerID: player.smallID(),
          });
        }
        break;
      case "groundArmy":
        for (const army of mg.armiesOf(player)) {
          if (!army.isActive() || seen.has(army.id())) continue;
          if (regions.at(army.tile()) !== regionId) continue;
          seen.add(army.id());
          candidates.push({
            kind: "army",
            tile: army.tile(),
            refId: army.id(),
            ownerID: player.smallID(),
          });
        }
        break;
      case "infrastructure":
        for (const unit of player.units(UnitType.City)) {
          if (!unit.isActive() || seen.has(unit.id())) continue;
          if (regions.at(unit.tile()) !== regionId) continue;
          seen.add(unit.id());
          candidates.push({
            kind: "structure",
            tile: unit.tile(),
            refId: unit.id(),
            ownerID: player.smallID(),
          });
        }
        break;
    }
  }
  if (candidates.length === 0) return null;
  // Lowest ref id wins: stable, and independent of the player iteration order
  // because the candidates are sorted, not sampled.
  candidates.sort((a, b) => a.refId - b.refId);
  return candidates[0];
}

/**
 * Apply one strike to a target the simulation chose.
 *
 * The bomber's sortie is `AIR_STRIKE_AIRCRAFT_PER_WAVE` aircraft, capped, and
 * the damage it does is the mission weight, blunted by the *target owner's* air
 * share in the region and sharpened by the attacker's recon there. The client
 * had no say in any of it.
 */
export function applyStrike(
  mg: Game,
  owner: Player,
  wing: AirWing,
  target: StrikeTarget,
  shares: Map<number, number>,
  reconBonusPercent: number,
): StrikeOutcome {
  const spent = Math.min(
    wing.aircraftCount(),
    AIR_MAX_STRIKE_AIRCRAFT,
    Math.max(1, AIR_STRIKE_AIRCRAFT_PER_WAVE),
  );
  if (spent <= 0) return { landed: false, damage: 0 };

  // The defender's share is read from the *target owner's* perspective: it is
  // their sky, so it is their share that blunts the strike.
  const defenderShare = shares.get(target.ownerID) ?? 50;
  const strikePercent = bomberStrikePercent(
    strikeCategoryFor(target),
    defenderShare,
    reconBonusPercent,
  );
  if (strikePercent <= 0) return { landed: false, damage: 0 };

const defender = asPlayer(mg, target.ownerID);
  if (defender === null) return { landed: false, damage: 0 };

  switch (target.kind) {
    case "factory": {
      const unit = findUnitById(mg, defender, target.refId);
      if (unit === undefined || unit.type() !== UnitType.Factory) {
        return { landed: false, damage: 0 };
      }
      const damage = strikeFactoryDamage(strikePercent);
      if (damage <= 0) return { landed: false, damage: 0 };
      // damageFactory/disableFactory are the 5.7 hooks Prompt 5 built and
      // nothing had called: a bomber wing is their first real user.
      unit.damageFactory(damage, owner);
      unit.disableFactory(STRIKE_FACTORY_DISABLE_TICKS);
      return { landed: true, damage };
    }
    case "army": {
      const army = mg.army(target.refId);
      if (army === undefined || !army.isActive()) {
        return { landed: false, damage: 0 };
      }
      const losses = strikeArmyLosses(strikePercent);
      if (losses <= 0) return { landed: false, damage: 0 };
      const removed = army.applyLosses(losses);
      army.recordCasualtiesInflicted(losses);
      return { landed: removed > 0, damage: removed };
    }
    case "structure": {
      const unit = findUnitById(mg, defender, target.refId);
      if (unit === undefined || !Structures.has(unit.type())) {
        return { landed: false, damage: 0 };
      }
      unit.decreaseLevel(owner);
      return { landed: true, damage: 1 };
    }
  }
}

function strikeCategoryFor(target: StrikeTarget): BomberTargetCategory {
  if (target.kind === "army") return "groundArmy";
  if (target.kind === "structure") return "infrastructure";
  return target.factoryType === FactoryType.Air
    ? "airIndustry"
    : "militaryIndustry";
}

function findUnitById(
  mg: Game,
  player: Player,
  unitId: number,
): ReturnType<Player["units"]>[number] | undefined {
  for (const unit of player.units()) {
    if (unit.id() === unitId) return unit;
  }
  return undefined;
}

// ---------------------------------------------------------------------------

const AirRegionExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  timer: zInt(),
  lastResolvedRegions: zInt(),
});
type AirRegionExecutionState = z.infer<typeof AirRegionExecutionStateSchema>;

export const AirRegionExecutionSnapshot = execSnapshotType({
  name: "AirRegion",
  version: 1,
  schema: AirRegionExecutionStateSchema,
  cls: () => AirRegionExecution,
});