// AirWingView — the client-side read model for one air wing (Prompt 7).
//
// The simulation sends a complete AirWingUpdate on a fixed cadence (see
// GameImpl.executeNextTick), so this is a thin wrapper: it holds one long-lived
// record that GameView mutates in place and exposes the few derived values the
// panel and the map overlay need.
//
// Like ArmyView, this is a view, not a model — actions go out as intents. It
// has no position and no aircraft list, because a wing has neither: it is a
// count of aircraft flying a mission over a region.

import {
  AircraftType,
  type AirMission,
  type AirMissionType,
  type BomberTargetCategory,
} from "../../core/game/Aircraft";
import { aircraftDef } from "../../core/game/Aircraft";
import type { AirWingUpdate } from "../../core/game/GameUpdates";
import type { GameView } from "./GameView";

export interface AirWingViewState {
  ownerID: number;
  name: string;
  aircraftType: AircraftType;
  aircraftCount: number;
  losses: number;
  experience: number;
  effectiveness: number;
  regionId: number | null;
  mission: AirMission;
  createdAt: number;
  statistics: AirWingUpdate["statistics"];
  isActive: boolean;
}

function emptyState(): AirWingViewState {
  return {
    ownerID: 0,
    name: "",
    aircraftType: AircraftType.Fighter,
    aircraftCount: 0,
    losses: 0,
    experience: 0,
    effectiveness: 0,
    regionId: null,
    mission: { type: "airSuperiority" },
    createdAt: 0,
    statistics: {
      engagements: 0,
      aircraftDestroyed: 0,
      aircraftLost: 0,
      strikesLanded: 0,
      damageDealt: 0,
    },
    isActive: true,
  };
}

export class AirWingView {
  /** Long-lived and mutated in place; the overlay may hold a reference. */
  public readonly state: AirWingViewState;

  constructor(public readonly id: number) {
    this.state = emptyState();
  }

  /** Applies a complete wing record. Every field is always present. */
  applyUpdate(u: AirWingUpdate): void {
    const s = this.state;
    s.ownerID = u.ownerID;
    s.name = u.name;
    s.aircraftType = u.aircraftType;
    s.aircraftCount = u.aircraftCount;
    s.losses = u.losses;
    s.experience = u.experience;
    s.effectiveness = u.effectiveness;
    s.regionId = u.regionId;
    s.mission = { ...u.mission } as AirMission;
    s.createdAt = u.createdAt;
    s.statistics = { ...u.statistics };
    s.isActive = u.isActive;
  }

  ownerSmallID(): number {
    return this.state.ownerID;
  }

  displayName(): string {
    return this.state.name;
  }

  aircraftType(): AircraftType {
    return this.state.aircraftType;
  }

  aircraftCount(): number {
    return this.state.aircraftCount;
  }

  losses(): number {
    return this.state.losses;
  }

  experience(): number {
    return this.state.experience;
  }

  effectiveness(): number {
    return this.state.effectiveness;
  }

  regionId(): number | null {
    return this.state.regionId;
  }

  isAssigned(): boolean {
    return this.state.regionId !== null;
  }

  mission(): AirMission {
    return { ...this.state.mission } as AirMission;
  }

  /** The bomber strike's target category, or null for any other mission. */
  strikeTarget(): BomberTargetCategory | null {
    const m = this.state.mission;
    return m.type === "strike" ? m.target : null;
  }

  createdAt(): number {
    return this.state.createdAt;
  }

  statistics(): AirWingUpdate["statistics"] {
    return { ...this.state.statistics };
  }

  /** Missions this wing's aircraft type may be assigned. */
  availableMissions(): readonly AirMissionType[] {
    return aircraftDef(this.state.aircraftType).missions;
  }

  /** Convenience for the overlay: is this one of the local player's wings? */
  isMine(game: GameView): boolean {
    const me = game.myPlayer();
    return me !== null && this.state.ownerID === me.smallID();
  }
}