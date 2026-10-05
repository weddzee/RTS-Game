// ArmyView — the client-side read model for one army.
//
// The simulation sends a complete ArmyUpdate every time an army changes (see
// GameUpdateType.Army), so this is a thin wrapper: it holds one long-lived
// ArmyState object that GameView mutates in place, and exposes the handful of
// derived values the panel and the markers need.
//
// Like PlayerView and UnitView, this is a view, not a model. Nothing here
// mutates game state — actions go out as intents.

import type { ArmyOrder, ArmyStatistics } from "../../core/game/Army";
import type {
  ArmyComposition,
  ArmySupplyStatus,
} from "../../core/game/ArmyComposition";
import { derivedStats } from "../../core/game/ArmyComposition";
import type { ArmyVeterancyTier } from "../../core/game/ArmyVeterancy";
import type { TileRef } from "../../core/game/GameMap";
import type { ArmyUpdate } from "../../core/game/GameUpdates";
import type { ArmyState } from "../render/types";
import type { GameView } from "./GameView";

export class ArmyView {
  /** Long-lived and mutated in place; passes may hold a reference. */
  public readonly state: ArmyState;

  constructor(public readonly id: number) {
    this.state = emptyArmyState(id);
  }

  /** Applies a complete army record. Every field is always present. */
  applyUpdate(u: ArmyUpdate): void {
    const s = this.state;
    s.ownerID = u.ownerID;
    s.name = u.name;
    s.tile = u.tile;
    s.frontId = u.frontId;
    s.strength = u.strength;
    s.manpower = u.manpower;
    s.composition = {
      infantry: u.composition.infantry,
      armor: u.composition.armor,
      artillery: u.composition.artillery,
      support: u.composition.support,
    };
    s.tier = u.tier;
    s.xp = u.xp;
    s.organization = u.organization;
    s.supply = u.supply;
    s.supplyStatus = u.supplyStatus;
    s.order = { ...u.order };
    s.combatState = u.combatState;
    s.movementState = u.movementState;
    s.createdAt = u.createdAt;
    s.statistics = { ...u.statistics };
    s.isActive = u.isActive;
  }

  ownerSmallID(): number {
    return this.state.ownerID;
  }

  name(): string {
    return this.state.name;
  }

  tile(): TileRef {
    return this.state.tile;
  }

  strength(): number {
    return this.state.strength;
  }

  manpower(): number {
    return this.state.manpower;
  }

  composition(): ArmyComposition {
    return this.state.composition;
  }

  tier(): ArmyVeterancyTier {
    return this.state.tier as ArmyVeterancyTier;
  }

  xp(): number {
    return this.state.xp;
  }

  organization(): number {
    return this.state.organization;
  }

  supply(): number {
    return this.state.supply;
  }

  supplyStatus(): ArmySupplyStatus {
    return this.state.supplyStatus as ArmySupplyStatus;
  }

  order(): ArmyOrder {
    return this.state.order as ArmyOrder;
  }

  combatState(): string {
    return this.state.combatState;
  }

  movementState(): string {
    return this.state.movementState;
  }

  statistics(): ArmyStatistics {
    return this.state.statistics;
  }

  frontId(): number | null {
    return this.state.frontId;
  }

  isActive(): boolean {
    return this.state.isActive;
  }

  isMine(game: GameView): boolean {
    const me = game.myPlayer();
    return me !== null && this.state.ownerID === me.smallID();
  }

  /**
   * The composition's resolved stat axes, recomputed from the mirrored
   * percentages. The client derives these from the same pure function the
   * simulation uses, so the panel can preview a composition change before it
   * is sent without duplicating any numbers.
   */
  derivedStats() {
    return derivedStats(this.state.composition);
  }
}

function emptyArmyState(id: number): ArmyState {
  return {
    id,
    ownerID: 0,
    name: "",
    tile: 0,
    frontId: null,
    strength: 0,
    manpower: 0,
    composition: { infantry: 60, armor: 20, artillery: 15, support: 5 },
    tier: "recruit",
    xp: 0,
    organization: 100,
    supply: 100,
    supplyStatus: "sufficient",
    order: { type: "hold" },
    combatState: "none",
    movementState: "idle",
    createdAt: 0,
    statistics: {
      battlesFought: 0,
      battlesWon: 0,
      casualtiesInflicted: 0,
      casualtiesTaken: 0,
      tilesCaptured: 0,
    },
    isActive: true,
  };
}
