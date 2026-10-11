// AirWingImpl — the mutable air-wing entity plus its snapshot.
//
// Same shape as ArmyImpl: all state lives in one plain `AirWingState` record,
// so the snapshot is one object write and the restore is one assignment, and
// every accessor is a trivial read.
//
// Mutators a player could abuse (rename, setMission) validate and return a
// boolean. The rest are called only by the air executions, which have already
// validated the request.

import { z } from "zod";
import { snapshotType, zInt, zNum } from "../snapshot/SnapshotType";
import { simpleHash } from "../Util";
import {
  type AircraftType,
  AIR_MISSION_TYPES,
  type AirMission,
  type AirWingState,
  type AirWingStatistics,
  BOMBER_TARGET_CATEGORIES,
  EFFECTIVENESS_MAX,
  EFFECTIVENESS_MIN,
  WING_MAX_AIRCRAFT,
  validateAirMission,
  wingEffectiveness,
} from "./Aircraft";
import { defaultArmyName, validateArmyName } from "./ArmyName";
import type { AirWing } from "./AirWing";
import type { Player } from "./Game";
import { GameUpdateType } from "./GameUpdates";
import type { AirWingUpdate } from "./GameUpdates";

export class AirWingImpl implements AirWing {
  private s: AirWingState;

  constructor(
    state: AirWingState,
    private _owner: Player,
  ) {
    this.s = state;
  }

  isAirWing(): this is AirWing {
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
   * Rename in place, through the army naming rules.
   *
   * Wings are named things and armies are named things, so they share one
   * validator rather than each having a near-identical one that drifts. The
   * intent execution runs it first; this re-checks so no other caller can put
   * an unvalidated string on a wing.
   */
  rename(name: unknown): boolean {
    const result = validateArmyName(name);
    if (!result.ok) return false;
    this.s.name = result.name;
    return true;
  }

  aircraftType(): AircraftType {
    return this.s.aircraftType;
  }

  createdAt(): number {
    return this.s.createdAt;
  }

  isActive(): boolean {
    return this.s.isActive;
  }

  // --- aircraft -----------------------------------------------------------

  aircraftCount(): number {
    return this.s.aircraftCount;
  }

  /** Add aircraft, clamped to the wing's ceiling. Returns what was added. */
  addAircraft(count: number): number {
    if (count <= 0) return 0;
    const room = WING_MAX_AIRCRAFT - this.s.aircraftCount;
    const added = Math.min(room, Math.floor(count));
    if (added <= 0) return 0;
    this.s.aircraftCount += added;
    return added;
  }

  /**
   * Apply losses to the wing and to the cumulative loss ledger in one call, so
   * the two can never disagree — a wing cannot quietly lose aircraft without
   * the player seeing it in the record.
   */
  applyLosses(count: number): number {
    if (count <= 0) return 0;
    const removed = Math.min(this.s.aircraftCount, Math.floor(count));
    if (removed <= 0) return 0;
    this.s.aircraftCount -= removed;
    this.s.losses += removed;
    return removed;
  }

  losses(): number {
    return this.s.losses;
  }

  experience(): number {
    return this.s.experience;
  }

  addExperience(gained: number): void {
    if (gained <= 0) return;
    this.s.experience += Math.floor(gained);
  }

  // --- assignment ---------------------------------------------------------

  assignedRegionId(): number | null {
    return this.s.regionId;
  }

  setAssignedRegionId(id: number | null): void {
    this.s.regionId = id;
  }

  /** A copy: callers must not mutate a wing by holding the returned object. */
  mission(): AirMission {
    return { ...this.s.mission } as AirMission;
  }

  /**
   * Replace the mission. Refuses anything the aircraft type may not fly — a
   * fighter cannot be sent to strike, and a bomber cannot be put on patrol —
   * so a wing is never in a state the air war has no branch for.
   */
  setMission(mission: AirMission): boolean {
    const validated = validateAirMission(mission, this.s.aircraftType);
    if (validated === null) return false;
    this.s.mission = validated;
    return true;
  }

  effectiveness(): number {
    return Math.min(
      EFFECTIVENESS_MAX,
      Math.max(EFFECTIVENESS_MIN, wingEffectiveness(this.s)),
    );
  }

  // --- statistics ---------------------------------------------------------

  statistics(): AirWingStatistics {
    return { ...this.s.statistics };
  }

  recordEngagement(): void {
    this.s.statistics.engagements += 1;
  }

  recordAircraftDestroyed(count: number): void {
    if (count <= 0) return;
    this.s.statistics.aircraftDestroyed += Math.floor(count);
  }

  recordAircraftLost(count: number): void {
    if (count <= 0) return;
    this.s.statistics.aircraftLost += Math.floor(count);
  }

  recordStrikeLanded(damage: number): void {
    if (damage <= 0) return;
    this.s.statistics.strikesLanded += 1;
    this.s.statistics.damageDealt += Math.floor(damage);
  }

  /**
   * Disband. The state block is kept so the final `isActive: false` update can
   * still be emitted, exactly as ArmyImpl.delete does.
   */
  delete(): void {
    this.s.isActive = false;
    this.s.regionId = null;
    this.s.aircraftCount = 0;
  }

  // --- desync -------------------------------------------------------------

  /**
   * Contributes to the game's state hash, so two clients that disagree about a
   * wing desync exactly as they would over an army. Integer-only, like
   * ArmyImpl.hash.
   */
  hash(): number {
    const s = this.s;
    return (
      simpleHash(String(s.id)) +
      s.ownerID +
      s.aircraftCount +
      s.losses +
      (s.experience | 0) +
      (s.regionId ?? -1) +
      airMissionHash(s.mission) +
      s.statistics.engagements +
      s.statistics.aircraftDestroyed +
      s.statistics.aircraftLost +
      s.statistics.strikesLanded +
      (s.statistics.damageDealt | 0)
    );
  }

  // --- wire ---------------------------------------------------------------

  toUpdate(): AirWingUpdate {
    const s = this.s;
    return {
      type: GameUpdateType.AirWing,
      id: s.id,
      ownerID: s.ownerID,
      name: s.name,
      aircraftType: s.aircraftType,
      aircraftCount: s.aircraftCount,
      losses: s.losses,
      experience: s.experience,
      effectiveness: this.effectiveness(),
      regionId: s.regionId,
      mission: { ...s.mission } as AirMission,
      createdAt: s.createdAt,
      statistics: { ...s.statistics },
      isActive: s.isActive,
    };
  }

  // --- snapshot -----------------------------------------------------------

  /** The raw state block. Read by GameImpl.snapshotState and nothing else. */
  state(): AirWingState {
    return this.s;
  }

  /** Fills a prototype-only shell; see RestorableExecution.restoreSnapshot. */
  restoreSnapshot(
    s: z.infer<typeof AirWingStateSchema>,
    owner: Player,
  ): void {
    this.s = s as AirWingState;
    this._owner = owner;
  }
}

/**
 * The mission as a small integer, for the desync hash.
 *
 * A wing's mission is a discriminated union and `hash()` has to reduce it to a
 * number. The mission type's position plus the target category's position keeps
 * two different missions from ever colliding: the type occupies the tens, the
 * category the units.
 */
export function airMissionHash(mission: AirMission): number {
  const base = (AIR_MISSION_TYPES.indexOf(mission.type) + 1) * 10;
  if (mission.type !== "strike") return base;
  return base + (BOMBER_TARGET_CATEGORIES.indexOf(mission.target) + 1);
}

/** A wing's generated default name, when the player did not name it. */
export function defaultAirWingName(existing: number): string {
  return defaultArmyName(existing).replace("Army", "Wing");
}

export const AirWingStateSchema = z.object({
  id: zInt(),
  ownerID: zInt(),
  name: z.string(),
  aircraftType: z.enum(["Fighter", "Bomber", "Helicopter"]),
  aircraftCount: zInt(),
  losses: zInt(),
  experience: zNum(),
  regionId: zInt().nullable(),
  mission: z.discriminatedUnion("type", [
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
  createdAt: zInt(),
  statistics: z.object({
    engagements: zInt(),
    aircraftDestroyed: zInt(),
    aircraftLost: zInt(),
    strikesLanded: zInt(),
    damageDealt: zNum(),
  }),
  isActive: z.boolean(),
  // Prompt 8.2: optional army attachment for helicopter wings
  attachedArmyId: zInt().nullable(),
});

export const AirWingSnapshot = snapshotType({
  name: "AirWing",
  version: 1,
  schema: AirWingStateSchema,
});