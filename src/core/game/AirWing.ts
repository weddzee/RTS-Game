// The Air Wing entity (Prompt 7.2).
//
// A wing is a *count of aircraft plus a mission*, not a squadron of sprites.
// It has no position on the map — it has a region, which is a strategic
// abstraction — so there is nothing for it to path, nothing for it to render as
// a moving object, and nothing for two clients to disagree about.
//
// The field set is the spec's: id, displayName, owner, aircraftType,
// aircraftCount, experience, assignedRegion, mission, effectiveness, losses.
// All of them live in one plain `AirWingState` record (see Aircraft.ts) so the
// snapshot is a single object write and a restore is a single assignment.
//
// Naming deliberately reuses the army naming subsystem (`validateArmyName`):
// one safe-name implementation for every named thing in the game, rather than a
// second one that is subtly more permissive.

import type {
  AircraftType,
  AirMission,
  AirWingStatistics,
  AirWingState,
} from "./Aircraft";
import type { Player, Tick } from "./Game";
import type { AirWingUpdate } from "./GameUpdates";

export function isAirWing(value: unknown): value is AirWing {
  return (
    typeof value === "object" &&
    value !== null &&
    "isAirWing" in value &&
    typeof (value as AirWing).isAirWing === "function" &&
    (value as AirWing).isAirWing()
  );
}

/**
 * Read-only view of one air wing.
 *
 * Same discipline as `Army`: every accessor is total and side-effect free, the
 * few mutators a player can reach validate and return a boolean, and the rest
 * are called only by the air executions after they have validated the request.
 */
export interface AirWing {
  isAirWing(): this is AirWing;

  id(): number;
  owner(): Player;
  /** The custom name. Never empty: a generated default is assigned at creation. */
  displayName(): string;
  aircraftType(): AircraftType;
  createdAt(): Tick;
  isActive(): boolean;

  /** Aircraft currently in the wing. */
  aircraftCount(): number;
  /** Cumulative aircraft this wing has lost. */
  losses(): number;
  experience(): number;
  /** Air region this wing flies in, or null while unassigned. */
  assignedRegionId(): number | null;
  mission(): AirMission;
  /** 0..100, how hard this wing is fighting right now. See wingEffectiveness. */
  effectiveness(): number;
  statistics(): AirWingStatistics;

  toUpdate(): AirWingUpdate;
  hash(): number;

  // --- mutation (core executions only) ----------------------------------

  /** Validates through the army naming rules; false on anything unsafe. */
  rename(name: unknown): boolean;
  addAircraft(count: number): number;
  /** Losses plus the matching experience dilution, in one step. */
  applyLosses(count: number): number;
  addExperience(gained: number): void;
  setAssignedRegionId(id: number | null): void;
  /** Validates the mission against this wing's aircraft type. */
  setMission(mission: AirMission): boolean;
  recordEngagement(): void;
  recordAircraftDestroyed(count: number): void;
  recordAircraftLost(count: number): void;
  recordStrikeLanded(damage: number): void;
  /** Disband: the state block survives so a final update can still be sent. */
  delete(): void;
}