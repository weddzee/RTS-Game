import { AllPlayersStats, ClientID, Winner } from "../Schemas";
import type {
  ArmyCombatState,
  ArmyMovementState,
  ArmyOrder,
  ArmyStatistics,
} from "./Army";
import type { ArmyComposition, ArmySupplyStatus } from "./ArmyComposition";
import type { ArmyVeterancyTier } from "./ArmyVeterancy";
import type { BattlePlanOrder, BattlePlanStatus } from "./BattlePlan";
import type {
  AircraftType,
  AirMission,
  AirWingStatistics,
} from "./Aircraft";
import type { FactoryType } from "./Factory";
import {
  EmojiMessage,
  GameUpdates,
  Gold,
  MessageType,
  NameViewData,
  NukeState,
  PlayerID,
  PlayerType,
  SamLauncherState,
  Team,
  Tick,
  TrainType,
  TransportShipState,
  UnitType,
  WarshipState,
} from "./Game";
import { TileRef } from "./GameMap";

export interface GameUpdateViewData {
  tick: number;
  updates: GameUpdates;
  /**
   * Packed tile updates as `[tileRef, state]` uint32 pairs.
   *
   * `tileRef` is a `TileRef` (fits in uint32), and `state` is the packed per-tile
   * state (`uint16`) stored in a `uint32` lane.
   */
  packedTileUpdates: Uint32Array;
  /**
   * Optional packed motion plan records.
   *
   * When present, this buffer is expected to be transferred worker -> main
   * (similar to `packedTileUpdates`) to avoid structured-clone copies.
   */
  packedMotionPlans?: Uint32Array;
  /**
   * Packed per-player numeric stats as
   * `[smallID, tilesOwned, gold, troops, goldEarned]`
   * float64 quints — the fields that change for nearly every alive player
   * every tick. They travel here (transferred, not structured-cloned) instead
   * of in `PlayerUpdate` object diffs, which only carry them on a player's
   * first emission. Gold is exact in a float64 (game values stay far below
   * 2^53). Absent when no player's stats changed.
   */
  packedPlayerUpdates?: Float64Array;
  /**
   * Packed attack troop-count changes as
   * `[ownerSmallID, direction, index, troops]` float64 quads, where
   * `direction` is 0 for the owner's outgoingAttacks and 1 for
   * incomingAttacks, and `index` addresses that array. Troop counts change
   * every tick for every active attack, so they travel here instead of
   * re-sending whole attack arrays in PlayerUpdate diffs; the arrays
   * themselves are only resent when membership/order/retreating changes —
   * which also guarantees the receiver's indexes line up (see
   * packAttackTroopDeltas). Absent when no attack troop count changed.
   */
  packedAttackUpdates?: Float64Array;
  /**
   * Name placement per player. Only present on ticks where the worker
   * recomputed placements (spawn ticks, the first ticks, every 30th tick,
   * spawn end) — between those the values wouldn't change, so the record is
   * omitted instead of re-cloned every tick. Consumers keep the last applied
   * values.
   */
  playerNameViewData?: Record<string, NameViewData>;
  tickExecutionDuration?: number;
  pendingTurns?: number;
  /**
   * Packed tile refs that were inside a nuke blast radius this tick.
   * Used by the renderer to mark nukeable layer tiles as destroyed.
   * Absent when no nukes detonated.
   */
  packedNukeImpacts?: Uint32Array;
}

export interface ErrorUpdate {
  errMsg: string;
  stack?: string;
}

export enum GameUpdateType {
  // Tile updates are delivered via `packedTileUpdates` on the outer GameUpdateViewData.
  Tile,
  Unit,
  Player,
  DisplayEvent,
  DisplayChatEvent,
  AllianceRequest,
  AllianceRequestReply,
  BrokeAlliance,
  AllianceExpired,
  AllianceExtension,
  TargetPlayer,
  Emoji,
  Win,
  Hash,
  UnitIncoming,
  BonusEvent,
  RailroadDestructionEvent,
  RailroadConstructionEvent,
  RailroadSnapEvent,
  ConquestEvent,
  EmbargoEvent,
  SpawnPhaseEnd,
  GamePaused,
  DonateEvent,
  Army,
  BattlePlan,
  AirWing,
  AirRegion,
}

export type GameUpdate =
  | UnitUpdate
  | PlayerUpdate
  | AllianceRequestUpdate
  | AllianceRequestReplyUpdate
  | BrokeAllianceUpdate
  | AllianceExpiredUpdate
  | DisplayMessageUpdate
  | DisplayChatMessageUpdate
  | TargetPlayerUpdate
  | EmojiUpdate
  | WinUpdate
  | HashUpdate
  | UnitIncomingUpdate
  | AllianceExtensionUpdate
  | BonusEventUpdate
  | RailroadConstructionUpdate
  | RailroadDestructionUpdate
  | RailroadSnapUpdate
  | ConquestUpdate
  | EmbargoUpdate
  | SpawnPhaseEndUpdate
  | GamePausedUpdate
  | DonateEventUpdate
  | ArmyUpdate
  | BattlePlanUpdate
  | AirWingUpdate
  | AirRegionUpdate;

/**
 * One air wing's full state, worker -> main thread.
 *
 * Whole-record like ArmyUpdate and for the same reasons: wings are few, they
 * change on a slow cadence, and both the panel and the map overlay need the
 * complete record to render without a local merge step.
 *
 * Note what is NOT here: no position, no heading, no per-aircraft list. A wing
 * has a region and a mission, and that is the whole of its authoritative
 * geometry — see game/Aircraft.ts.
 */
export interface AirWingUpdate {
  type: GameUpdateType.AirWing;
  /** Game-wide wing id. Stable for the wing's lifetime. */
  id: number;
  /** Owner's small id. Drives the marker color and friend/enemy filtering. */
  ownerID: number;
  name: string;
  aircraftType: AircraftType;
  /** Live aircraft count. The wing's entire physical presence. */
  aircraftCount: number;
  /** Cumulative aircraft this wing has lost. */
  losses: number;
  experience: number;
  /** 0..100, derived; see wingEffectiveness. */
  effectiveness: number;
  /** Air region the wing is assigned to, or null while unassigned. */
  regionId: number | null;
  mission: AirMission;
  createdAt: Tick;
  statistics: AirWingStatistics;
  isActive: boolean;
}

/**
 * One air region's air picture, worker -> main thread (Prompt 7.8).
 *
 * The region GRID is derived from the map, not stored, so a client cannot
 * reconstruct it — these updates are how a client learns where the regions are
 * and who holds each one's sky. Emitted only for regions that actually have
 * aircraft in them: an overlay over every region of a large map is both a waste
 * of bandwidth and exactly the "flooding" 7.8 forbids.
 *
 * A region that empties simply stops being sent. Each air pass therefore
 * REPLACES the client's region set wholesale rather than merging into it, so a
 * region that just emptied disappears instead of lingering — see GameView.
 */
export interface AirRegionUpdate {
  type: GameUpdateType.AirRegion;
  /** Region id, matching `Game.airRegions()` and `AirWingUpdate.regionId`. */
  regionId: number;
  /** Region origin, in tiles. */
  x: number;
  y: number;
  /** Region size, in tiles. */
  width: number;
  height: number;
  /**
   * Share of this region's air war held by the leading side, 0..100. Exactly 50
   * with no leading side means nobody is flying here.
   */
  sharePercent: number;
  /** Leading side's small id, or null when nobody is flying in the region. */
  leaderSmallID: number | null;
  /** True when aircraft from more than one side are in the region. */
  contested: boolean;
}

/**
 * One army's full state, worker -> main thread.
 *
 * Always complete rather than diffed: an army's updates are rare (an order, a
 * battle tick, an upkeep tick) and the panel needs the whole record to render
 * without a local merge step. Disbanding is `isActive: false`, which the
 * consumer turns into a removal.
 */
export interface ArmyUpdate {
  type: GameUpdateType.Army;
  /** Game-wide army id. Stable for the army's lifetime. */
  id: number;
  /** Owner's small id. Drives the marker color and friend/enemy filtering. */
  ownerID: number;
  name: string;
  tile: TileRef;
  frontId: number | null;
  /** Live troop count. Fractional, like attack stacks. */
  strength: number;
  /** Cumulative troops paid into the army; the reinforce ceiling. */
  manpower: number;
  composition: ArmyComposition;
  tier: ArmyVeterancyTier;
  xp: number;
  organization: number;
  supply: number;
  supplyStatus: ArmySupplyStatus;
  order: ArmyOrder;
  combatState: ArmyCombatState;
  movementState: ArmyMovementState;
  createdAt: Tick;
  statistics: ArmyStatistics;
  isActive: boolean;
}

/**
 * One battle plan's full state, worker -> main thread (Prompt 4).
 *
 * Whole rather than diffed, for the same reason as ArmyUpdate: a plan is few,
 * changes rarely, and every client needs the complete canonical geometry to
 * draw the front line and the arrow. `isActive: false` is the tombstone.
 *
 * `frontier` and `route` are the *canonical* geometry the simulation derived,
 * not the gesture that was drawn. Clients draw these; they never draw what the
 * player scribbled, which is why two clients cannot disagree about where an
 * arrow points.
 */
export interface BattlePlanUpdate {
  type: GameUpdateType.BattlePlan;
  /** Game-wide plan id. Stable for the plan's lifetime. */
  id: number;
  ownerID: number;
  kind: BattlePlanOrder;
  status: BattlePlanStatus;
  /** Owner's border tiles the plan covers. Tiles the owner holds, by construction. */
  frontier: TileRef[];
  /** Ordered strategic waypoints, derived from map topology. */
  route: TileRef[];
  /** Defensive line in owned territory; only meaningful for fallback plans. */
  fallbackLine: TileRef[];
  armyIDs: number[];
  /** Index into `route` the plan is working toward. */
  step: number;
  createdAt: Tick;
  /** Bumped on every canonical change, so the renderer can skip idle redraws. */
  version: number;
  isActive: boolean;
}

export interface BonusEventUpdate {
  type: GameUpdateType.BonusEvent;
  player: PlayerID;
  tile: TileRef;
  gold: number;
  troops: number;
}

export interface RailroadConstructionUpdate {
  type: GameUpdateType.RailroadConstructionEvent;
  id: number;
  tiles: TileRef[];
}

export interface RailroadDestructionUpdate {
  type: GameUpdateType.RailroadDestructionEvent;
  id: number;
}

export interface RailroadSnapUpdate {
  type: GameUpdateType.RailroadSnapEvent;
  originalId: number;
  newId1: number;
  newId2: number;
  tiles1: TileRef[];
  tiles2: TileRef[];
}

export interface ConquestUpdate {
  type: GameUpdateType.ConquestEvent;
  conquerorId: PlayerID;
  conqueredId: PlayerID;
  gold: Gold;
}

export interface DonateEventUpdate {
  type: GameUpdateType.DonateEvent;
  donationType: "troops" | "gold";
  senderId: PlayerID;
  recipientId: PlayerID;
  amount: bigint;
}

export interface UnitUpdate {
  type: GameUpdateType.Unit;
  unitType: UnitType;
  troops: number;
  id: number;
  ownerID: number;
  lastOwnerID?: number;
  // TODO: make these tilerefs
  pos: TileRef;
  lastPos: TileRef;
  isActive: boolean;
  reachedTarget: boolean;
  warshipState?: WarshipState;
  transportShipState?: TransportShipState;
  nukeState?: NukeState;
  targetable: boolean;
  markedForDeletion: number | false;
  targetUnitId?: number; // Only for trade ships
  targetTile?: TileRef; // Only for nukes
  health?: number;
  underConstruction?: boolean;
  missileTimerQueue: number[];
  level: number;
  hasTrainStation: boolean;
  trainType?: TrainType; // Only for trains
  loaded?: boolean; // Only for trains
  samUpgrade?: SamLauncherState;
  // Factories (Prompt 5): compact map + selected-panel representation.
  // Only set for Factory units; omitted otherwise so other units are unchanged.
  factoryType?: FactoryType;
  factoryEfficiency?: number;
  factoryDisabled?: boolean;
}

export interface AttackUpdate {
  attackerID: number;
  targetID: number;
  troops: number;
  id: string;
  retreating: boolean;
}

/**
 * Player snapshot delivered worker -> main thread.
 *
 * Only `type` and `id` are guaranteed. Every other field is omitted when its
 * value matches the previous emission for the same player. The first emission
 * for a player always includes all fields; consumers must handle subsequent
 * partial updates by merging into local state, not overwriting.
 *
 * When adding a field here, also wire it into diffPlayerUpdate() and
 * applyStateUpdate() in GameUpdateUtils.ts — otherwise it is only ever sent on
 * the first emission and later changes are silently dropped.
 */
export interface PlayerUpdate {
  type: GameUpdateType.Player;
  id: PlayerID;
  nameViewData?: NameViewData;
  clientID?: ClientID | null;
  name?: string;
  displayName?: string;
  clanTag?: string | null;
  nationFlag?: string | null;
  team?: Team;
  smallID?: number;
  playerType?: PlayerType;
  isAlive?: boolean;
  isDisconnected?: boolean;
  killedBy?: ClientID | null;
  deathPosition?: number | null;
  tilesOwned?: number;
  gold?: Gold;
  /** Cumulative ship-trade revenue (changes only on arrivals, so it diffs). */
  tradeGold?: Gold;
  /** Cumulative train revenue: own trains + external stops at own stations. */
  trainGold?: Gold;
  /** Cumulative piracy revenue: captured-ship payouts. */
  piracyGold?: Gold;
  /** Cumulative gold received from all sources (workers, trade, ...). */
  goldEarned?: Gold;
  troops?: number;
  allies?: number[];
  embargoes?: Set<PlayerID>;
  isTraitor?: boolean;
  traitorRemainingTicks?: number;
  inDoomsdayClock?: boolean;
  isDecaying?: boolean;
  markedDoomsdayClockTick?: number;
  targets?: number[];
  outgoingEmojis?: EmojiMessage[];
  outgoingAttacks?: AttackUpdate[];
  incomingAttacks?: AttackUpdate[];
  outgoingAllianceRequests?: PlayerID[];
  alliances?: AllianceView[];
  hasSpawned?: boolean;
  spawnTile?: TileRef;
  betrayals?: number;
  lastDeleteUnitTick?: Tick;
  isLobbyCreator?: boolean;
  // Match progression (Prompt 6). Sent for every player, not just the local
  // one — level and applied perks are shown on other players' panels, and the
  // XP bar is cheap to diff (it changes a few times per match at most).
  /** Current match level, 1-7. */
  matchLevel?: number;
  /** Cumulative match XP, already pacing-scaled at award time. */
  matchXP?: number;
  /** Level-up perk options awaiting a pick; empty when nothing is pending. */
  pendingPerks?: string[];
  /** Applied perk IDs, in pick order. */
  appliedPerks?: string[];
  /**
   * Banked aircraft production (Prompt 7.3), in whole aircraft. Drives the
   * air panel's "ready" readout and gates whether a wing can be raised.
   */
  airCapacity?: number;
}

export interface AllianceView {
  id: number;
  other: PlayerID;
  createdAt: Tick;
  expiresAt: Tick;
  hasExtensionRequest: boolean;
}

export interface AllianceRequestUpdate {
  type: GameUpdateType.AllianceRequest;
  requestorID: number;
  recipientID: number;
  createdAt: Tick;
}

export interface AllianceRequestReplyUpdate {
  type: GameUpdateType.AllianceRequestReply;
  request: AllianceRequestUpdate;
  accepted: boolean;
}

export interface BrokeAllianceUpdate {
  type: GameUpdateType.BrokeAlliance;
  traitorID: number;
  betrayedID: number;
  allianceID: number;
}

export interface AllianceExpiredUpdate {
  type: GameUpdateType.AllianceExpired;
  player1ID: number;
  player2ID: number;
}

export interface AllianceExtensionUpdate {
  type: GameUpdateType.AllianceExtension;
  playerID: number;
  allianceID: number;
}

export interface TargetPlayerUpdate {
  type: GameUpdateType.TargetPlayer;
  playerID: number;
  targetID: number;
}

export interface EmojiUpdate {
  type: GameUpdateType.Emoji;
  emoji: EmojiMessage;
}

export interface DisplayMessageUpdate {
  type: GameUpdateType.DisplayEvent;
  message: string;
  messageType: MessageType;
  goldAmount?: bigint;
  playerID: number | null;
  params?: Record<string, string | number>;
  unitID?: number;
  focusPlayerID?: number;
}

export type DisplayChatMessageUpdate = {
  type: GameUpdateType.DisplayChatEvent;
  key: string;
  category: string;
  target: string | undefined;
  playerID: number | null;
  isFrom: boolean;
  recipient: string;
};

export interface WinUpdate {
  type: GameUpdateType.Win;
  allPlayersStats: AllPlayersStats;
  winner: Winner;
}

export interface HashUpdate {
  type: GameUpdateType.Hash;
  tick: Tick;
  hash: number;
}

export interface UnitIncomingUpdate {
  type: GameUpdateType.UnitIncoming;
  unitID: number;
  message: string;
  messageType: MessageType;
  playerID: number;
}

export interface EmbargoUpdate {
  type: GameUpdateType.EmbargoEvent;
  event: "start" | "stop";
  playerID: number;
  embargoedID: number;
}

export interface SpawnPhaseEndUpdate {
  type: GameUpdateType.SpawnPhaseEnd;
  startTick: Tick;
}

export interface GamePausedUpdate {
  type: GameUpdateType.GamePaused;
  paused: boolean;
}
