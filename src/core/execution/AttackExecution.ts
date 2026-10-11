import { z } from "zod";
import { renderTroops } from "../../client/Utils";
import { ArmyAttackModifiers, AttackLogicInput } from "../configuration/Config";
import { escalationLevelForGame } from "../Escalation";
import { airDefensePercentForTile } from "./air/AirRegionExecution";
import type { Army } from "../game/Army";
import {
  attackerLossDivisor,
  breakthroughMultiplier,
  offenseMultiplier,
} from "../game/ArmyComposition";
import {
  xpForCasualtiesInflicted,
  xpForTilesCaptured,
} from "../game/ArmyVeterancy";
import {
  Attack,
  Difficulty,
  Execution,
  Game,
  MessageType,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
  TerraNullius,
  UnitType,
} from "../game/Game";
import { GameMap, TileRef } from "../game/GameMap";
import {
  perkBonusFor,
  XP_FOR_BATTLE_WON,
  XP_FOR_DEFENSE_HELD,
  xpForCasualties,
} from "../game/Progression";
import { PseudoRandom } from "../PseudoRandom";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRandom,
  zRef,
  zTile,
  zTiles,
} from "../snapshot/SnapshotType";
import { assertNever } from "../Util";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap"; // adjust path if needed

const malusForRetreat = 25;
export class AttackExecution implements Execution {
  private active: boolean = true;
  private toConquer = new FlatBinaryHeap();

  private random = new PseudoRandom(123);

  private target: Player | TerraNullius;

  private mg: Game;
  // Direct GameMap reference to skip the Game delegation hop in hot loops.
  private map: GameMap;

  private attack: Attack | null = null;

  // Cached smallIDs for integer owner comparisons in hot loops.
  private ownerSmallID: number;
  private targetSmallID: number;
  // Reusable neighbor buffers to avoid closures/allocation in hot loops.
  private nbuf: TileRef[] = [0, 0, 0, 0];
  private nbuf2: TileRef[] = [0, 0, 0, 0];

  // Match XP (Prompt 6), accumulated for the life of this offensive and paid
  // once at a terminal path. Awarding per tile would floor most single-tile
  // casualty batches to zero XP; batching here means a long fight pays out for
  // what it actually cost. Both sides' casualties count: the attacker earns for
  // destroying enemy military strength, the defender for holding the line.
  private defenderCasualties = 0;
  private attackerCasualties = 0;
  private tilesConquered = 0;
  private xpAwarded = false;

  constructor(
    private startTroops: number | null = null,
    private _owner: Player,
    private _targetID: PlayerID | null,
    private sourceTile: TileRef | null = null,
    private removeTroops: boolean = true,
    // Prompt 3: when this attack is an army's offensive, the army owns the
    // troops and receives the combat bookkeeping (losses, captures, veterancy,
    // combat state). Null — the ordinary click-to-attack path — is unchanged.
    private army: Army | null = null,
  ) {}

  public targetID(): PlayerID | null {
    return this._targetID;
  }

  /** The army this offensive belongs to, or null for an ordinary attack. */
  armyRef(): Army | null {
    return this.army;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    if (!this.active) {
      return;
    }
    this.mg = mg;
    this.map = mg.map();

    if (this._targetID !== null && !mg.hasPlayer(this._targetID)) {
      console.warn(`target ${this._targetID} not found`);
      this.active = false;
      return;
    }

    this.target =
      this._targetID === this.mg.terraNullius().id()
        ? mg.terraNullius()
        : mg.player(this._targetID);
    this.ownerSmallID = this._owner.smallID();
    this.targetSmallID = this.target.smallID();

    if (this._owner === this.target) {
      console.error(`Player ${this._owner} cannot attack itself`);
      this.active = false;
      return;
    }

    // ALLIANCE CHECK — block attacks on friendly (ally or same team)
    if (this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (this._owner.isFriendly(targetPlayer)) {
        console.warn(
          `${this._owner.displayName()} cannot attack ${targetPlayer.displayName()} because they are friendly (allied or same team)`,
        );
        this.active = false;
        return;
      }
    }

    if (this.target && this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (
        targetPlayer.type() !== PlayerType.Bot &&
        this._owner.type() !== PlayerType.Bot
      ) {
        // Don't let bots embargo since they can't trade anyway.
        targetPlayer.addEmbargo(this._owner, true);
        this.rejectIncomingAllianceRequests(targetPlayer);
      }
    }

    if (this.target.isPlayer() && !this._owner.canAttackPlayer(this.target)) {
      this.active = false;
      this.releaseArmy(false);
      return;
    }

    this.startTroops ??= this.mg
      .config()
      .attackAmount(this._owner, this.target);
    if (this.army !== null && this.army.owner() !== this._owner) {
      // The army and the attack must belong to the same player; anything else
      // is a bug or a forged intent, and neither may spend the other's troops.
      console.warn("army attack owner does not own the army");
      this.active = false;
      return;
    }
    if (this.removeTroops) {
      if (this.army !== null) {
        // An army's offensive is paid for out of the army, not out of the
        // owner's free troop pool — the troops already left the pool when the
        // army was raised.
        this.startTroops = Math.min(
          this.army.totalStrength(),
          this.startTroops,
        );
        this.startTroops = this.army.removeStrength(this.startTroops);
      } else {
        this.startTroops = Math.min(this._owner.troops(), this.startTroops);
        // Take the amount that was actually deducted, not the amount asked for.
        // removeTroops() floors, so a fractional request leaves the attack
        // holding troops the owner never paid for — and retreat refunds the
        // combined total, turning the leftover fractions into free troops.
        this.startTroops = this._owner.removeTroops(this.startTroops);
      }
    }
    this.attack = this._owner.createAttack(
      this.target,
      this.startTroops,
      this.sourceTile,
      new Set<TileRef>(),
    );

    if (this.sourceTile !== null) {
      this.addNeighbors(this.sourceTile);
    } else {
      this.refreshToConquer();
    }

    // Record stats
    this.mg.stats().attack(this._owner, this.target, this.startTroops);

    for (const incoming of this._owner.incomingAttacks()) {
      if (incoming.attacker() === this.target) {
        // Target has opposing attack, cancel them out
        if (incoming.troops() > this.attack.troops()) {
          incoming.setTroops(incoming.troops() - this.attack.troops());
          this.attack.delete();
          this.active = false;
          this.releaseArmy(false);
          return;
        } else {
          this.attack.setTroops(this.attack.troops() - incoming.troops());
          incoming.delete();
        }
      }
    }
    for (const outgoing of this._owner.outgoingAttacks()) {
      if (
        outgoing !== this.attack &&
        outgoing.target() === this.attack.target() &&
        // Boat attacks (sourceTile is not null) are not combined with other attacks
        this.attack.sourceTile() === null &&
        // An army's troops stay under its own command: merging would hand
        // them to another (unnamed, possibly non-army) attack and the army
        // would come back short.
        this.army === null
      ) {
        this.attack.setTroops(this.attack.troops() + outgoing.troops());
        outgoing.delete();
      }
    }

    // Only now is it known how large the attack the defender actually faces
    // is: a big assault is built by clicking repeatedly, and each click's
    // execution absorbs the earlier ones above. Recorded before the loops it
    // would measure one click, and would count an attack that cancelled out
    // and never landed.
    this.mg.stats().attackMaxIncoming(this.target, this.attack.troops());

    if (this.target.isPlayer()) {
      const difficulty = this.mg.config().gameConfig().difficulty;
      let relationChange: number;
      switch (difficulty) {
        case Difficulty.Easy:
          relationChange = -60;
          break;
        case Difficulty.Medium:
          relationChange = -70;
          break;
        case Difficulty.Hard:
          relationChange = -80;
          break;
        case Difficulty.Impossible:
          relationChange = -100;
          break;
        default:
          assertNever(difficulty);
      }
      this.target.updateRelation(this._owner, relationChange);
    }
  }

  private refreshToConquer() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    this.toConquer.clear();
    this.attack.clearBorder();
    // forEach over the dense storage — the values() generator showed up in long-game profiles
    this._owner.borderTiles().forEach((tile) => this.addNeighbors(tile));
  }

  /**
   * Pay out this offensive's match XP (Prompt 6). Called from every terminal
   * path, exactly once, guarded by `xpAwarded` so a defensive no-op (an attack
   * that never landed and had no casualties) pays nothing.
   *
   * Three rewards, all for behavior that took deliberate action:
   *   - destroying enemy military strength, from casualties inflicted
   *   - winning battles, from actually taking ground
   *   - defending successfully, credited to the defender when they still hold
   *     land after the offensive ended
   * An ally never appears here: attacks on friendlies are refused in init()
   * and the friendly check in tick() retreats first, so there is no path by
   * which two allies hand each other XP.
   */
  private awardMatchXP(): void {
    if (this.xpAwarded) return;
    this.xpAwarded = true;

    const inflicted = xpForCasualties(this.defenderCasualties);
    if (inflicted > 0) this._owner.addMatchXP(inflicted);
    if (this.tilesConquered > 0) this._owner.addMatchXP(XP_FOR_BATTLE_WON);

    // The defender's reward is for repelling something, so it needs a real
    // attacker on the other side and a defender still standing on land.
    if (!this.target.isPlayer()) return;
    const defender = this.target;
    if (!defender.isAlive() || defender.numTilesOwned() <= 0) return;
    const taken = xpForCasualties(this.attackerCasualties);
    if (taken > 0) defender.addMatchXP(taken);
    if (this.defenderCasualties > 0) defender.addMatchXP(XP_FOR_DEFENSE_HELD);
  }

  private retreat(malusPercent = 0) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    this.awardMatchXP();
    const deaths = this.attack.troops() * (malusPercent / 100);
    if (deaths) {
      this.mg.displayMessage(
        "events_display.attack_cancelled_retreat",
        MessageType.ATTACK_CANCELLED,
        this._owner.id(),
        undefined,
        { troops: renderTroops(deaths) },
      );
    }
    if (this.removeTroops === false && this.sourceTile === null) {
      // startTroops are always added to attack troops at init but not always removed from owner troops
      // subtract startTroops from attack troops so we don't give back startTroops to owner that were never removed
      // boat attacks (sourceTile !== null) are the exception: troops were removed at departure and must be returned after attack still
      this.attack.setTroops(this.attack.troops() - (this.startTroops ?? 0));
    }

    const survivors = this.attack.troops() - deaths;
    // An army's survivors go back into the army — the same troops it committed
    // at init — not into the owner's free pool. addStrength, not reinforce:
    // nothing was paid for them a second time.
    if (this.army !== null) this.army.addStrength(survivors);
    else this._owner.addTroops(survivors);
    this.attack.delete();
    this.active = false;
    this.releaseArmy(true);

    // Not all retreats are canceled attacks
    if (this.attack.retreated()) {
      // Record stats
      this.mg.stats().attackCancel(this._owner, this.target, survivors);
    }
  }

  tick(ticks: number) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }
    let troopCount = this.attack.troops(); // cache troop count
    const targetIsPlayer = this.target.isPlayer(); // cache target type
    const targetPlayer = targetIsPlayer ? (this.target as Player) : null; // cache target player

    if (this.attack.retreated()) {
      if (targetIsPlayer) {
        this.retreat(malusForRetreat);
      } else {
        this.retreat();
      }
      this.active = false;
      return;
    }

    if (this.attack.retreating()) {
      return;
    }

    if (!this.attack.isActive()) {
      this.active = false;
      // The attack was deleted underneath us (a sweep, or a merge we cannot
      // be part of). Anything still on it is lost. The fight still happened,
      // so whatever it cost both sides is paid out.
      this.awardMatchXP();
      this.releaseArmy(false);
      return;
    }

    if (targetPlayer && this._owner.isFriendly(targetPlayer)) {
      // In this case a new alliance was created AFTER the attack started.
      this.retreat();
      return;
    }

    const borderSize = this.attack.borderSize() + this.random.nextInt(0, 5);
    // Each tile consumes a fraction of the tick; conquer until it is spent.
    let tickBudget = 1;

    while (tickBudget > 0) {
      if (troopCount < 1) {
        this.attack.delete();
        this.active = false;
        // The offensive was destroyed mid-fight, but the casualties it caused
        // and the ground it took were real, so both sides still get paid.
        this.awardMatchXP();
        this.releaseArmy(false);
        return;
      }

      if (this.toConquer.size() === 0) {
        this.refreshToConquer();
        this.retreat();
        return;
      }

      const tileToConquer = this.toConquer.dequeue();
      this.attack.removeBorderTile(tileToConquer);

      let onBorder = false;
      const numNeighbors = this.map.neighbors4(tileToConquer, this.nbuf);
      for (let i = 0; i < numNeighbors; i++) {
        if (this.map.ownerID(this.nbuf[i]) === this.ownerSmallID) {
          onBorder = true;
          break;
        }
      }
      if (this.map.ownerID(tileToConquer) !== this.targetSmallID || !onBorder) {
        continue;
      }
      if (
        !this.map.isLand(tileToConquer) ||
        this.map.isImpassable(tileToConquer)
      ) {
        continue;
      }
      this.addNeighbors(tileToConquer);
      const { attackerTroopLoss, defenderTroopLoss, tickFraction } = this.mg
        .config()
        .attackLogic(
          this.attackLogicInput(troopCount, tileToConquer, borderSize),
        );
      tickBudget -= tickFraction;
      troopCount -= attackerTroopLoss;
      this.attack.setTroops(troopCount);
      this.attackerCasualties += attackerTroopLoss;
      this.defenderCasualties += defenderTroopLoss;
      if (targetPlayer) {
        targetPlayer.removeTroops(defenderTroopLoss);
      }
      this._owner.conquer(tileToConquer);
      this.tilesConquered++;
      if (this.army !== null)
        this.recordArmyProgress(attackerTroopLoss, defenderTroopLoss);
      this.handleDeadDefender();
    }
  }

  /**
   * Mirror one conquered tile onto the army: its own losses (which also dilute
   * its veterancy), the damage it did to the defender, and the experience for
   * ground taken.
   */
  private recordArmyProgress(
    attackerTroopLoss: number,
    defenderTroopLoss: number,
  ): void {
    const army = this.army;
    if (army === null) return;
    if (attackerTroopLoss > 0) {
      army.applyLosses(attackerTroopLoss);
      army.addExperience(xpForCasualtiesInflicted(attackerTroopLoss));
    }
    if (defenderTroopLoss > 0) {
      // Casualties the army inflicted are the defender's losses, so the same
      // experience rate applies — the damage it deals is what teaches it.
      army.recordCasualtiesInflicted(defenderTroopLoss);
      army.addExperience(xpForCasualtiesInflicted(defenderTroopLoss));
    }
    army.recordTilesCaptured(1);
    army.addExperience(xpForTilesCaptured(1));
  }

  /**
   * Hand the army back to its own execution now that the fight is over.
   *
   * Called from every terminal path. `survivorsReturned` distinguishes the two
   * endings: a retreat already put the survivors back on the army, whereas an
   * attack deleted underneath us still has troops on it, and those are losses.
   * No-op for an ordinary (non-army) attack.
   */
  private releaseArmy(survivorsReturned: boolean): void {
    const army = this.army;
    if (army === null || !army.isActive()) return;
    if (!survivorsReturned && this.attack !== null) {
      army.applyLosses(this.attack.troops());
    }
    // A fight that ended with troops still standing was won.
    if (survivorsReturned && army.totalStrength() > 0) {
      army.recordBattleWon();
    }
    army.setCombatState("none");
    army.setMovementState("idle");
    // The offensive is over whatever happened; standing orders resume.
    army.setOrder({ type: "hold" });
  }

  /**
   * Air superiority over the contested tile (Prompt 7.5), from the air war's
   * own pass. Attached to the defender rather than folded into `perkDefensePercent`
   * so the two sources stay legible: one is a doctrine perk the player chose,
   * the other is the result of a regional fight happening right now.
   */
  private airDefensePercent(tile: TileRef): number {
    if (!this.target.isPlayer()) return 0;
    return airDefensePercentForTile(this.mg, this.target, tile);
  }

  private attackLogicInput(
    attackTroops: number,
    tile: TileRef,
    borderSize: number,
  ): AttackLogicInput {
    const defender = this.target.isPlayer() ? this.target : null;
    // Same test as scanning nearbyUnits() for a post owned by the defender
    // (active, not under construction, within range), without building a
    // result array per conquered tile — this runs for every tile of every
    // attack on the map.
    const defenderHasDefensePost =
      defender !== null &&
      this.mg.hasUnitNearby(
        tile,
        this.mg.config().defensePostRange(),
        UnitType.DefensePost,
        defender.id(),
      );
    const perks = this.perkModifiers();
    const airPercent = defender === null ? 0 : this.airDefensePercent(tile);
    return {
      terrain: this.map.terrainType(tile),
      attackTroops,
      attacker: {
        type: this._owner.type(),
        numTiles: this._owner.numTilesOwned(),
      },
      defender:
        defender === null
          ? null
          : {
              type: defender.type(),
              numTiles: defender.numTilesOwned(),
              troops: defender.troops(),
              isTraitor: defender.isTraitor(),
              isDisconnectedTeammate:
                defender.isDisconnected() && this._owner.isOnSameTeam(defender),
              ...(perks.perkDefensePercent === undefined
                ? {}
                : { perkDefensePercent: perks.perkDefensePercent }),
              ...(airPercent <= 0 ? {} : { airDefensePercent: airPercent }),
            },
      defenderHasDefensePost,
      falloutRatio: this.mg.hasFallout(tile)
        ? this.mg.numTilesWithFallout() / this.mg.numLandTiles()
        : null,
      borderSize,
      // Late-game pressure; 0 before the deadline (see Escalation).
      escalationLevel: escalationLevelForGame(this.mg),
      ...this.armyModifiers(),
      // A perk-only attack still needs the whole attackerModifiers block; an
      // army's composition/veterancy and the attacker's perks add together.
      ...(perks.attackerModifiers === undefined
        ? {}
        : {
            attackerModifiers: this.combineAttackModifiers(
              perks.attackerModifiers,
            ),
          }),
    };
  }

  /**
   * Army composition/veterancy (Prompt 3.3) and progression perks (Prompt 6)
   * both scale the same three numbers, on the same 100 = neutral scale, so they
   * multiply: an armored veteran army led by a Blitz specialist bleeds less
   * than either would alone.
   */
  private combineAttackModifiers(
    perks: ArmyAttackModifiers,
  ): ArmyAttackModifiers {
    const army = this.armyModifiers().attackerModifiers;
    if (army === undefined) return perks;
    return {
      lossDivisor: (army.lossDivisor * perks.lossDivisor) / 100,
      defenderLossMultiplier:
        (army.defenderLossMultiplier * perks.defenderLossMultiplier) / 100,
      conquestCostMultiplier:
        (army.conquestCostMultiplier * perks.conquestCostMultiplier) / 100,
    };
  }

  /**
   * Composition and veterancy folded into the per-tile combat math, on the
   * 100 = neutral scale the army stats already use. Absent for an ordinary
   * attack, which must resolve exactly as it did before armies existed.
   */
  private armyModifiers(): { attackerModifiers?: ArmyAttackModifiers } {
    if (this.army === null) return {};
    const stats = this.army.derivedStats();
    const bonus = this.army.combatBonus();
    // Breakthrough and veterancy both shorten the conquest cost, so an
    // experienced armored army visibly takes ground faster.
    const conquestCost =
      (breakthroughMultiplier(stats) * bonus.conquestCostMultiplier) / 100;
    return {
      attackerModifiers: {
        // A defensive composition bleeds less per tile; the divisor keeps the
        // neutral case at 1x and floored so a pathological composition can
        // never make an attack free.
        lossDivisor: Math.max(
          50,
          (attackerLossDivisor(stats) * bonus.lossDivisor) / 100,
        ),
        defenderLossMultiplier: Math.max(50, offenseMultiplier(stats)),
        conquestCostMultiplier: Math.max(25, conquestCost),
      },
    };
  }

  /**
   * Progression perks (Prompt 6) folded into the same per-tile combat math.
   *
   * Blitz ("offense") makes an attacker bleed less per tile and take ground
   * faster; Fortress ("defense") makes a defender bleed less. Both ride the
   * 100 = neutral scale. The floors keep a stacked perk from making an attack
   * free or a defense invulnerable.
   *
   * Returns `{}` when neither side has perks, so an ordinary attack between
   * two perk-less players resolves exactly as it did before progression existed.
   */
  private perkModifiers(): {
    attackerModifiers?: ArmyAttackModifiers;
    perkDefensePercent?: number;
  } {
    const offense = perkBonusFor(this._owner, "offense");
    const defense = this.target.isPlayer()
      ? perkBonusFor(this.target, "defense")
      : 0;
    if (offense === 0 && defense === 0) return {};
    return {
      ...(offense > 0
        ? {
            attackerModifiers: {
              lossDivisor: 100 + offense,
              defenderLossMultiplier: 100 + offense,
              conquestCostMultiplier: 100 + offense,
            },
          }
        : {}),
      ...(defense > 0 ? { perkDefensePercent: defense } : {}),
    };
  }

  private rejectIncomingAllianceRequests(target: Player) {
    const request = this._owner
      .incomingAllianceRequests()
      .find((ar) => ar.requestor() === target);
    if (request !== undefined) {
      request.reject();
    }
  }

  private addNeighbors(tile: TileRef) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const tickNow = this.mg.ticks(); // cache tick

    const numNeighbors = this.map.neighbors4(tile, this.nbuf);
    for (let i = 0; i < numNeighbors; i++) {
      const neighbor = this.nbuf[i];
      if (
        this.map.isWater(neighbor) ||
        this.map.isImpassable(neighbor) ||
        this.map.ownerID(neighbor) !== this.targetSmallID
      ) {
        continue;
      }
      this.attack.addBorderTile(neighbor);
      let numOwnedByMe = 0;
      const numInner = this.map.neighbors4(neighbor, this.nbuf2);
      for (let j = 0; j < numInner; j++) {
        if (this.map.ownerID(this.nbuf2[j]) === this.ownerSmallID) {
          numOwnedByMe++;
        }
      }

      let mag: number;
      switch (this.map.terrainType(neighbor)) {
        case TerrainType.Plains:
          mag = 1;
          break;
        case TerrainType.Highland:
          mag = 1.5;
          break;
        case TerrainType.Mountain:
          mag = 2;
          break;
        default:
          mag = 0;
          break;
      }

      const priority =
        (this.random.nextInt(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) +
        tickNow;

      this.toConquer.enqueue(neighbor, priority);
    }
  }

  private handleDeadDefender() {
    if (!(this.target.isPlayer() && this.target.numTilesOwned() < 100)) return;
    const target: Player = this.target;

    this.mg.conquerPlayer(this._owner, target);

    const MAX_PASSES = 100;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let progressed = false;
      for (const tile of target.tiles()) {
        let borders = false;
        this.mg.forEachNeighbor(tile, (t) => {
          if (!borders && this.mg.owner(t) === this._owner) {
            borders = true;
          }
        });
        if (borders) {
          this._owner.conquer(tile);
          progressed = true;
        } else {
          let captured = false;
          this.mg.forEachNeighbor(tile, (neighbor) => {
            if (captured) return;
            const no = this.mg.owner(neighbor);
            if (no.isPlayer() && no !== target && !no.isFriendly(target)) {
              this.mg.player(no.id()).conquer(tile);
              captured = true;
            }
          });
          if (captured) progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  owner(): Player {
    return this._owner;
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AttackExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      toConquer: this.toConquer.getState(),
      random: w.random(this.random),
      target: this.target === undefined ? null : w.owner(this.target),
      attack: this.attack === null ? null : w.attack(this.attack),
      army: w.armyOrNull(this.army),
      startTroops: this.startTroops,
      owner: w.player(this._owner),
      targetID: this._targetID,
      sourceTile: this.sourceTile,
      removeTroops: this.removeTroops,
      defenderCasualties: this.defenderCasualties,
      attackerCasualties: this.attackerCasualties,
      tilesConquered: this.tilesConquered,
      xpAwarded: this.xpAwarded,
    });
  }

  restoreSnapshot(s: AttackExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    this.toConquer = FlatBinaryHeap.fromState(s.toConquer);
    this.random = r.random(s.random);
    if (s.initialized) {
      this.mg = r.game;
      this.map = r.game.map();
    }
    if (s.target !== null) {
      this.target = r.owner(s.target);
      // Set together with target in init(); small ids are the stored refs.
      this.ownerSmallID = s.owner;
      this.targetSmallID = s.target;
    }
    this.attack = s.attack === null ? null : r.attack(s.attack);
    this.army = r.armyOrNull(s.army);
    // Scratch buffers, overwritten before every read.
    this.nbuf = [0, 0, 0, 0];
    this.nbuf2 = [0, 0, 0, 0];
    this.startTroops = s.startTroops;
    this._owner = r.player(s.owner);
    this._targetID = s.targetID;
    this.sourceTile = s.sourceTile;
    this.removeTroops = s.removeTroops;
    this.defenderCasualties = s.defenderCasualties;
    this.attackerCasualties = s.attackerCasualties;
    this.tilesConquered = s.tilesConquered;
    this.xpAwarded = s.xpAwarded;
  }
}

const AttackExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  // Exact heap layout: ties between equal priorities dequeue by position.
  toConquer: z.object({
    pri: z.custom<Float32Array>(
      (v) => v instanceof Float32Array,
      "expected float32s",
    ),
    tiles: zTiles(),
    capacity: zInt(),
  }),
  random: zRandom(),
  /** Null until init() resolves the target. */
  target: zPlayerRef().nullable(),
  attack: zRef().nullable(),
  /** The army whose troops this attack spends (Prompt 3); null for a click. */
  army: zRef().nullable(),
  startTroops: zNum().nullable(),
  owner: zPlayerRef(),
  targetID: z.string().nullable(),
  sourceTile: zTile().nullable(),
  removeTroops: z.boolean(),
  // Match XP accumulators (Prompt 6, v3). An in-flight attack from an older
  // snapshot simply forfeits its payout; awardMatchXP() then pays only the
  // battle-win reward for ground it already took.
  // Floats: the per-tile troop losses these sum are fractional, and rounding
  // each one on the way in would throw away most of a small fight. Only the
  // XP conversion floors, and it does so once, at payout.
  defenderCasualties: zNum(),
  attackerCasualties: zNum(),
  tilesConquered: zInt(),
  xpAwarded: z.boolean(),
});
type AttackExecutionState = z.infer<typeof AttackExecutionStateSchema>;

export const AttackExecutionSnapshot = execSnapshotType({
  name: "Attack",
  version: 3,
  schema: AttackExecutionStateSchema,
  migrations: {
    // v1 predates armies: every attack was a click, so none of them had one.
    1: (d: Record<string, unknown>) => ({ ...d, army: null }),
    // v2 predates match XP: no attack had tracked casualties or ground, and an
    // already-terminal one must never pay twice.
    2: (d: Record<string, unknown>) => ({
      ...d,
      defenderCasualties: 0,
      attackerCasualties: 0,
      tilesConquered: 0,
      xpAwarded: !d.active,
    }),
  },
  cls: () => AttackExecution,
});
