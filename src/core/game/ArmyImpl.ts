// ArmyImpl — the mutable army entity plus its snapshot.
//
// All state lives in one plain `ArmyState` record (see game/Army.ts). That
// makes the snapshot a single object write and the restore a single
// assignment, and it keeps every accessor a trivial read.
//
// Mutators that a player could abuse (rename, setComposition) validate and
// return a boolean; the rest are called only from the army executions, which
// have already validated the request.

import { z } from "zod";
import { snapshotType, zInt, zNum, zTile } from "../snapshot/SnapshotType";
import { simpleHash } from "../Util";
import {
  type Army,
  type ArmyCombatState,
  type ArmyMovementState,
  type ArmyOrder,
  type ArmyState,
  type ArmyStatistics,
} from "./Army";
import {
  type ArmyComposition,
  type ArmyDerivedStats,
  type ArmySupplyStatus,
  derivedStats,
  supplyStatusFor,
  validateComposition,
} from "./ArmyComposition";
import { validateArmyName } from "./ArmyName";
import {
  addXp,
  type ArmyVeterancyTier,
  combatBonusFor,
  diluteXp,
  tierForXp,
  type VeterancyCombatBonus,
} from "./ArmyVeterancy";
import type { Player } from "./Game";
import type { TileRef } from "./GameMap";
import type { ArmyUpdate } from "./GameUpdates";
import { GameUpdateType } from "./GameUpdates";

export class ArmyImpl implements Army {
  private s: ArmyState;

  constructor(
    state: ArmyState,
    private _owner: Player,
  ) {
    this.s = state;
  }

  isArmy(): this is Army {
    return true;
  }

  // --- identity -----------------------------------------------------------

  id(): number {
    return this.s.id;
  }

  owner(): Player {
    return this._owner;
  }

  displayName(): string {
    return this.s.name;
  }

  /**
   * Rename in place. The intent execution runs `validateArmyName` first; this
   * re-checks so no other caller can put an unvalidated string on an army.
   * A rejected name changes nothing.
   */
  rename(name: unknown): boolean {
    const result = validateArmyName(name);
    if (!result.ok) return false;
    this.s.name = result.name;
    return true;
  }

  tile(): TileRef {
    return this.s.tile;
  }

  setTile(tile: TileRef): void {
    this.s.tile = tile;
  }

  createdAt(): number {
    return this.s.createdAt;
  }

  isActive(): boolean {
    return this.s.isActive;
  }

  // --- assignment ---------------------------------------------------------

  assignedFrontId(): number | null {
    return this.s.frontId;
  }

  setAssignedFrontId(id: number | null): void {
    this.s.frontId = id;
  }

  assignedBattlePlanId(): number | null {
    return this.s.battlePlanId;
  }

  setAssignedBattlePlanId(id: number | null): void {
    this.s.battlePlanId = id;
  }

  // --- strength and manpower ---------------------------------------------

  totalStrength(): number {
    return this.s.strength;
  }

  /**
   * Put troops back into the army without touching the manpower ceiling —
   * survivors returning from an attack, or a commander withdrawing. This is not
   * a purchase, so `manpower` (what the owner has paid in) must not move.
   */
  addStrength(troops: number): number {
    if (troops <= 0) return 0;
    this.s.strength += troops;
    return troops;
  }

  /**
   * Reinforcement: a purchase. Raises the live strength and the manpower
   * ceiling by the same amount, because the owner just paid for it.
   */
  reinforce(troops: number): number {
    if (troops <= 0) return 0;
    this.s.strength += troops;
    this.s.manpower += troops;
    return troops;
  }

  /** Remove troops (casualties, upkeep). Returns what was actually removed. */
  removeStrength(troops: number): number {
    if (troops <= 0) return 0;
    const removed = Math.min(this.s.strength, troops);
    this.s.strength -= removed;
    return removed;
  }

  manpower(): number {
    return this.s.manpower;
  }

  // --- composition --------------------------------------------------------

  /** A copy: callers must not be able to mutate an army by holding it. */
  composition(): ArmyComposition {
    return { ...this.s.composition };
  }

  /**
   * Replace the composition. Rejects anything that is not already a legal
   * normalized composition — callers normalize first, so this is the
   * authoritative check and not a lenient coercion.
   */
  setComposition(composition: ArmyComposition): boolean {
    if (!validateComposition(composition)) return false;
    this.s.composition = { ...composition };
    return true;
  }

  /** The composition's resolved stat axes. Recomputed per call, not cached. */
  derivedStats(): ArmyDerivedStats {
    return derivedStats(this.s.composition);
  }

  // --- veterancy ----------------------------------------------------------

  xp(): number {
    return this.s.xp;
  }

  tier(): ArmyVeterancyTier {
    return tierForXp(this.s.xp);
  }

  addExperience(gained: number): void {
    this.s.xp = addXp(this.s.xp, gained);
  }

  /**
   * Apply losses to strength and dilute experience by the surviving fraction
   * in the same call, so casualties can never be recorded without the
   * dilution that comes with them.
   */
  applyLosses(troops: number): number {
    const before = this.s.strength;
    const removed = this.removeStrength(troops);
    if (removed <= 0) return 0;
    this.s.xp = diluteXp(this.s.xp, before, this.s.strength);
    this.s.statistics.casualtiesTaken += removed;
    return removed;
  }

  combatBonus(): VeterancyCombatBonus {
    return combatBonusFor(this.s.xp);
  }

  // --- organization, supply ----------------------------------------------

  organization(): number {
    return this.s.organization;
  }

  addOrganization(delta: number): void {
    this.s.organization = Math.min(
      100,
      Math.max(0, this.s.organization + delta),
    );
  }

  supply(): number {
    return this.s.supply;
  }

  setSupply(supply: number): void {
    this.s.supply = Math.min(100, Math.max(0, supply));
  }

  supplyStatus(): ArmySupplyStatus {
    return supplyStatusFor(this.s.supply);
  }

  // --- orders and state --------------------------------------------------

  order(): ArmyOrder {
    return this.s.order;
  }

  setOrder(order: ArmyOrder): void {
    this.s.order = order;
  }

  movementState(): ArmyMovementState {
    return this.s.movementState;
  }

  setMovementState(state: ArmyMovementState): void {
    this.s.movementState = state;
  }

  combatState(): ArmyCombatState {
    return this.s.combatState;
  }

  setCombatState(state: ArmyCombatState): void {
    this.s.combatState = state;
  }

  // --- statistics --------------------------------------------------------

  statistics(): ArmyStatistics {
    return { ...this.s.statistics };
  }

  recordBattleFought(): void {
    this.s.statistics.battlesFought += 1;
  }

  recordBattleWon(): void {
    this.s.statistics.battlesWon += 1;
  }

  recordCasualtiesInflicted(troops: number): void {
    if (troops <= 0) return;
    this.s.statistics.casualtiesInflicted += troops;
  }

  recordTilesCaptured(tiles: number): void {
    if (tiles <= 0) return;
    this.s.statistics.tilesCaptured += tiles;
  }

  starvingTicks(): number {
    return this.s.starvingTicks;
  }

  setStarvingTicks(ticks: number): void {
    this.s.starvingTicks = Math.max(0, ticks);
  }

  /**
   * Contributes to the game's state hash, so two clients that disagree about
   * an army's state desync exactly as they would over a unit. Integer-only
   * arithmetic, like PlayerImpl.hash.
   */
  hash(): number {
    const s = this.s;
    return (
      simpleHash(String(s.id)) +
      s.ownerID +
      s.tile +
      (s.strength | 0) +
      (s.manpower | 0) +
      (s.xp | 0) +
      (s.organization | 0) +
      (s.supply | 0) +
      s.statistics.battlesFought +
      s.statistics.battlesWon +
      s.statistics.tilesCaptured +
      (s.statistics.casualtiesInflicted | 0) +
      (s.statistics.casualtiesTaken | 0) +
      (s.composition.infantry +
        s.composition.armor * 3 +
        s.composition.artillery * 7 +
        s.composition.support * 11)
    );
  }

  /** Disband. The state block is kept so the final update still has a record. */
  delete(): void {
    this.s.isActive = false;
    this.s.order = { type: "stop" };
    this.s.combatState = "none";
    this.s.movementState = "idle";
  }

  // --- wire ---------------------------------------------------------------

  toUpdate(): ArmyUpdate {
    const s = this.s;
    return {
      type: GameUpdateType.Army,
      id: s.id,
      ownerID: s.ownerID,
      name: s.name,
      tile: s.tile,
      frontId: s.frontId,
      strength: s.strength,
      manpower: s.manpower,
      composition: { ...s.composition },
      tier: this.tier(),
      xp: s.xp,
      organization: s.organization,
      supply: s.supply,
      supplyStatus: this.supplyStatus(),
      order: { ...s.order },
      combatState: s.combatState,
      movementState: s.movementState,
      createdAt: s.createdAt,
      statistics: { ...s.statistics },
      isActive: s.isActive,
    };
  }

  // --- snapshot -----------------------------------------------------------

  /** The raw state block. Read by GameImpl.snapshotState and nothing else. */
  state(): ArmyState {
    return this.s;
  }

  /** Fills a prototype-only shell; see RestorableExecution.restoreSnapshot. */
  restoreSnapshot(s: ArmyState, owner: Player): void {
    this.s = s;
    this._owner = owner;
  }
}

export const ArmyStateSchema = z.object({
  id: zInt(),
  ownerID: zInt(),
  name: z.string(),
  tile: zTile(),
  frontId: zInt().nullable(),
  battlePlanId: zInt().nullable(),
  strength: zNum(),
  manpower: zNum(),
  composition: z.object({
    infantry: zInt(),
    armor: zInt(),
    artillery: zInt(),
    support: zInt(),
  }),
  xp: zNum(),
  organization: zNum(),
  supply: zNum(),
  order: z.discriminatedUnion("type", [
    z.object({ type: z.literal("hold") }),
    z.object({ type: z.literal("stop") }),
    z.object({ type: z.literal("move"), tile: zTile() }),
    z.object({ type: z.literal("attack"), tile: zTile() }),
    z.object({ type: z.literal("createFront"), tile: zTile() }),
    z.object({ type: z.literal("reinforce"), troops: zNum() }),
  ]),
  combatState: z.enum(["none", "attacking"]),
  movementState: z.enum(["idle", "moving", "holding", "engaging"]),
  createdAt: zInt(),
  statistics: z.object({
    battlesFought: zInt(),
    battlesWon: zInt(),
    casualtiesInflicted: zNum(),
    casualtiesTaken: zNum(),
    tilesCaptured: zInt(),
  }),
  isActive: z.boolean(),
  starvingTicks: zInt(),
});

export const ArmySnapshot = snapshotType({
  name: "Army",
  version: 1,
  schema: ArmyStateSchema,
});
