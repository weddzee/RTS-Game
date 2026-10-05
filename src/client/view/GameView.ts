import { Config } from "../../core/configuration/Config";
import {
  Cell,
  GameUpdates,
  PlayerID,
  PlayerType,
  Team,
  TerrainType,
  TerraNullius,
  Tick,
  Unit,
  UnitInfo,
  UnitType,
} from "../../core/game/Game";
import { GameMap, TileRef } from "../../core/game/GameMap";
import {
  GameUpdateType,
  GameUpdateViewData,
  SpawnPhaseEndUpdate,
} from "../../core/game/GameUpdates";
import { unpackMotionPlans } from "../../core/game/MotionPlans";
import { TerrainMapData } from "../../core/game/TerrainMapLoader";
import { TerraNulliusImpl } from "../../core/game/TerraNulliusImpl";
import { UnitGrid, UnitPredicate } from "../../core/game/UnitGrid";
import { UserSettings } from "../../core/game/UserSettings";
import { ClientID, GameID, Player, PlayerCosmetics } from "../../core/Schemas";
import { formatPlayerDisplayName } from "../../core/Util";
import { WorkerClient } from "../../core/worker/WorkerClient";
import { computeAllianceClusters } from "../render/frame/derive/AllianceClusters";
import { extractAttackRings } from "../render/frame/derive/AttackRings";
import { extractNukeTelegraphs } from "../render/frame/derive/NukeTelegraphs";
import { computePlayerStatus } from "../render/frame/derive/PlayerStatus";
import {
  buildRelationMatrix,
  isFriendlyIn,
} from "../render/frame/derive/RelationMatrix";
import { RailroadCache } from "../render/frame/RailroadCache";
import type { SpiralParams } from "../render/frame/SpiralTrails";
import { SpiralTrails } from "../render/frame/SpiralTrails";
import { TrailManager } from "../render/frame/TrailManager";
import type { FrameData, NameEntry } from "../render/types";
import { STRUCTURE_TYPES } from "../render/types";
import { TRAIL_TYPES } from "../render/types/UnitType";
import { resolveTeamClanTag } from "../Utils";
import { ArmyView } from "./ArmyView";
import { BattlePlanView } from "./BattlePlanView";
import { BATTLE_PLAN_PICK_RADIUS_TILES } from "../render/types/BattlePlan";
import type { CosmeticVisibility } from "./CosmeticVisibility";
import {
  applyPackedAttackTroops,
  applyPackedPlayerStats,
  embargoSmallIDs,
} from "./EntityState";
import {
  MotionPlanResolver,
  type GridMotionPlan,
  type PlannedUnits,
} from "./MotionPlanResolver";
import { PlayerView } from "./PlayerView";
import { UnitView } from "./UnitView";

function readCosmeticVisibility(): CosmeticVisibility {
  return new UserSettings().graphicsOverrides().cosmetics ?? {};
}

export class GameView implements GameMap {
  private lastUpdate: GameUpdateViewData | null;
  private startTick: Tick | null = null;
  private smallIDToID = new Map<number, PlayerID>();
  private _players = new Map<PlayerID, PlayerView>();
  private _units = new Map<number, UnitView>();
  /**
   * Long-lived state maps (renderer's plain-object shape). Each entry shares
   * its identity with the corresponding PlayerView.state / UnitView.state, so
   * mutations through either path are visible everywhere.
   */
  private _playerStates = new Map<
    number,
    import("../render/types").PlayerState
  >();
  private _unitStates = new Map<number, import("../render/types").UnitState>();
  /** smallID â†’ team, for the renderer's relation matrix (team games). */
  private _teams = new Map<number, string>();
  private _teamClanTags: Map<Team, string | null> | null = null;
  private updatedTiles: TileRef[] = [];
  private updatedTerrainTiles: TileRef[] = [];
  private nukeImpactTiles: TileRef[] = [];
  /**
   * Active units grouped by owner smallID, built lazily at most once per
   * tick. Keeps per-player unit queries (PlayerView.units) at O(own units)
   * instead of O(all units) â€” the leaderboard asks for every player's units
   * in one pass, which is O(players Ă— units) without this.
   */
  private _unitsByOwner = new Map<number, UnitView[]>();
  private _unitsByOwnerStale = true;

  /**
   * Armies, by id (Prompt 3). The simulation sends a complete record for each
   * army on every update, so there is nothing to diff â€” only to add, replace or
   * drop. Disbanded armies arrive once with `isActive: false` and are removed
   * here.
   */
  private _armies = new Map<number, ArmyView>();
  /** Army currently selected for the army panel; null when none. */
  private _selectedArmyId: number | null = null;

  /**
   * Battle plans, by id (Prompt 4). Whole records on every update, exactly like
   * armies: a plan is rare, its geometry is large enough that diffing it would
   * cost more than resending it, and every client needs the canonical result.
   * A deleted plan arrives once with `isActive: false`.
   */
  private _battlePlans = new Map<number, BattlePlanView>();
  /** Plan under the pointer, and the one the panel is showing; may differ. */
  private _hoveredBattlePlanId: number | null = null;
  private _selectedBattlePlanId: number | null = null;

  // â”€â”€ FrameData accumulators (renderer-bound state) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  private trailManager!: TrailManager;
  private spiralTrails!: SpiralTrails;
  private railroadCache!: RailroadCache;
  /** Long-lived NameEntry map for the renderer's NamePass. */
  private _names = new Map<string, NameEntry>();
  /** Reusable scratch buffers for per-tick deltas. */
  private readonly _trailIdsScratch: number[] = [];
  /**
   * The single long-lived FrameData object. Fields are mutated in place each
   * tick by update(). Renderer reads this each frame via frameData().
   */
  private _frame: FrameData;
  private _structuresDirty = false;
  /** True until first populateFrame() â€” controls full-vs-delta tile upload. */
  private _firstPopulate = true;

  private _myPlayer: PlayerView | null = null;

  // â”€â”€ populateFrame dirty flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The derived structures below only depend on rarely-changing player
  // fields, so they're rebuilt only when one of their inputs arrived this
  // tick (PlayerUpdates are partial â€” field presence means "changed").
  /** Names: nameData record applied, or a player was added. */
  private _namesDirty = true;
  /** Relation matrix: allies/embargoes changed, or a player was added. */
  private _relationsDirty = true;
  /** Alliance clusters: allies changed, or a player was added. */
  private _clustersDirty = true;

  private unitGrid: UnitGrid;
  private readonly motion = new MotionPlanResolver();
  /** How the resolver moves this view's units. */
  private readonly plannedUnits: PlannedUnits = {
    tileOf: (id) => {
      const unit = this._units.get(id);
      return unit?.isActive() ? unit.tile() : undefined;
    },
    move: (id, tile) => {
      const unit = this._units.get(id)!;
      unit.applyDerivedPosition(tile as TileRef);
      this.unitGrid.updateUnitCell(unit);
    },
    rest: (id) => this._units.get(id)!.applyDerivedRest(),
  };

  private toDelete = new Set<number>();

  private _cosmetics: Map<string, PlayerCosmetics> = new Map();
  private _cosmeticVisibility: CosmeticVisibility = readCosmeticVisibility();

  private _map: GameMap;

  constructor(
    public worker: WorkerClient,
    private _config: Config,
    private _mapData: TerrainMapData,
    private _myClientID: ClientID | undefined,
    private _myUsername: string,
    private _myClanTag: string | null,
    private _gameID: GameID,
    humans: Player[],
  ) {
    this._map = this._mapData.gameMap;
    this.lastUpdate = null;
    this.unitGrid = new UnitGrid(this._map);
    this._cosmetics = new Map(
      humans.map((h) => [h.clientID, h.cosmetics ?? {}]),
    );

    // Nation-type players carry their own flag on the wire (PlayerUpdate.nationFlag,
    // sourced from the manifest via PlayerInfo) rather than being looked up here by
    // name â€” some maps define multiple nations with the same display name (e.g.
    // India's and Pakistan's "Punjab", split by the 1947 partition), and a name-keyed
    // lookup can't tell those apart. See the Nation-branch in update() below.

    const mapW = this._map.width();
    const mapH = this._map.height();
    this.trailManager = new TrailManager(mapW, mapH);
    this.spiralTrails = new SpiralTrails(mapW);
    this.railroadCache = new RailroadCache(mapW, mapH);

    // Long-lived FrameData. Most fields are mutable references to long-lived
    // buffers (tileState, trailState, etc.); changedTiles points at this
    // tick's updatedTiles. Properties marked `readonly` on FrameData only
    // prevent reassignment, not mutation through the reference.
    // events: fresh arrays we own; cleared and repopulated each tick.
    this._frame = {
      tick: 0,
      inSpawnPhase: true,
      tileState: this._map.tileStateBuffer(),
      trailState: this.trailManager.getTrailState(),
      spiralRibbons: this.spiralTrails.getRibbons(),
      railroadState: this.railroadCache.railroadState,
      units: this._unitStates,
      players: this._playerStates,
      names: this._names,
      events: {
        deadUnits: [],
        conquestEvents: [],
        bonusEvents: [],
      },
      changedTiles: null,
      railroadDirty: false,
      revealedRailTiles: this.railroadCache.revealedRailTiles,
      trailDirtyRowMin: 0,
      trailDirtyRowMax: -1,
      // Derived data â€” populated each tick by populateFrame(). Empty defaults
      // here so the type is satisfied before the first update().
      playerStatus: new Map(),
      relationMatrix: new Uint8Array(0),
      relationSize: 0,
      relationsDirty: false,
      allianceClusters: new Map(),
      nukeTelegraphs: [],
      attackRings: [],
      structuresDirty: false,
    };
  }

  isOnEdgeOfMap(ref: TileRef): boolean {
    return this._map.isOnEdgeOfMap(ref);
  }

  public updatesSinceLastTick(): GameUpdates | null {
    return this.lastUpdate?.updates ?? null;
  }

  public motionPlans(): ReadonlyMap<number, GridMotionPlan> {
    return this.motion.gridPlans();
  }

  public motionPlannedUnitIds(): number[] {
    return this.motion.plannedUnitIds();
  }

  public isCatchingUp(): boolean {
    return (this.lastUpdate?.pendingTurns ?? 0) > 1;
  }

  public update(gu: GameUpdateViewData) {
    // Unit set/ownership changes below; rebuild the owner index on demand.
    this._unitsByOwnerStale = true;

    this.toDelete.forEach((id) => {
      this._units.delete(id);
      this._unitStates.delete(id);
    });
    this.toDelete.clear();

    this.lastUpdate = gu;

    this.applyArmyUpdates(gu);
    this.applyBattlePlanUpdates(gu);

    this.updatedTiles = [];
    this.updatedTerrainTiles = [];
    const packed = this.lastUpdate.packedTileUpdates;
    for (let i = 0; i + 1 < packed.length; i += 2) {
      const tile = packed[i];
      const state = packed[i + 1];
      const terrainChanged = this.updateTile(tile, state);
      this.updatedTiles.push(tile);
      if (terrainChanged) {
        this.updatedTerrainTiles.push(tile);
      }
    }

    // Nuke blast-radius tiles (for nukeable layer destruction).
    const packedNukes = gu.packedNukeImpacts;
    this.nukeImpactTiles = packedNukes ? Array.from(packedNukes) : [];

    if (gu.packedMotionPlans) {
      this.motion.applyRecords(unpackMotionPlans(gu.packedMotionPlans));
    }

    if (gu.updates === null) {
      throw new Error("lastUpdate.updates not initialized");
    }

    const spawnPhaseEndUpdate = gu.updates[GameUpdateType.SpawnPhaseEnd][0] as
      | SpawnPhaseEndUpdate
      | undefined;
    if (spawnPhaseEndUpdate) {
      this.startTick = spawnPhaseEndUpdate.startTick;
    }
    if (gu.updates[GameUpdateType.Win].length > 0) {
      this._gameOver = true;
    }

    const myDisplayName = formatPlayerDisplayName(
      this._myUsername,
      this._myClanTag,
    );

    // Name placements arrive only on ticks where the worker recomputed them
    // (see GameUpdateViewData.playerNameViewData). Apply to existing alive
    // players here; dead players keep their last placement (names freeze at
    // death), and new players get theirs via the PlayerView constructor in
    // pass 1 below.
    if (gu.playerNameViewData !== undefined) {
      for (const id in gu.playerNameViewData) {
        const pv = this._players.get(id);
        if (pv !== undefined && pv.state.isAlive) {
          pv.nameData = gu.playerNameViewData[id];
        }
      }
      this._namesDirty = true;
    }

    // Pass 1: ensure every player exists with up-to-date PlayerState. We need
    // all smallIDs registered before pass 2 can translate embargo PlayerIDs.
    // PlayerUpdate is now partial: only `id` is guaranteed; everything else
    // is present only when its value changed since the last emission.
    gu.updates[GameUpdateType.Player].forEach((pu) => {
      // First-emission (new player) â€” must have all static fields populated.
      // Subsequent emissions for an existing player carry only changed fields.
      const existing = this._players.get(pu.id);

      // Replace the local player's name/displayName with their own stored values.
      // This way the user does not know they are being censored. clientID is
      // static â€” present only on first emission â€” so this branch only runs once.
      if (pu.clientID !== undefined && pu.clientID === this._myClientID) {
        pu.name = this._myUsername;
        pu.displayName = myDisplayName;
        pu.clanTag = this._myClanTag;
      }

      if (pu.smallID !== undefined) {
        this.smallIDToID.set(pu.smallID, pu.id);
      }

      // Derived-data dirty tracking: field presence on a partial update
      // means the field changed this tick.
      if (pu.allies !== undefined) {
        this._relationsDirty = true;
        this._clustersDirty = true;
      }
      if (pu.embargoes !== undefined) {
        this._relationsDirty = true;
      }

      if (existing !== undefined) {
        existing.applyUpdate(pu);
        const nextNameData = gu.playerNameViewData?.[pu.id];
        if (nextNameData !== undefined) {
          existing.nameData = nextNameData;
        }
      } else {
        const player = new PlayerView(
          this,
          pu,
          gu.playerNameViewData?.[pu.id],
          // Humans get cosmetics by clientID. Nations carry their flag
          // directly on the update (see PlayerUpdate.nationFlag) rather than
          // being looked up by name â€” some maps define multiple nations with
          // the same display name (e.g. India's and Pakistan's "Punjab").
          this._cosmetics.get(pu.clientID ?? "") ??
            (pu.playerType === PlayerType.Nation && pu.nationFlag
              ? ({
                  flag: `/flags/${pu.nationFlag}.svg`,
                } satisfies PlayerCosmetics)
              : undefined) ??
            {},
        );
        this._players.set(pu.id, player);
        this._playerStates.set(pu.smallID!, player.state);
        const team = player.team();
        if (team !== null) {
          this._teams.set(pu.smallID!, team);
        }
        this._namesDirty = true;
        this._relationsDirty = true;
        this._clustersDirty = true;
        this._teamClanTags = null;
      }
    });

    // Pass 2: translate engine embargoes (Set<PlayerID>) â†’ renderer-format
    // smallIDs. Only re-translate when embargoes changed (field present);
    // unchanged sets stay at the previously-computed renderer-format list.
    gu.updates[GameUpdateType.Player].forEach((pu) => {
      if (pu.embargoes === undefined) return;
      const player = this._players.get(pu.id);
      if (player === undefined) return;
      const smallIDs = embargoSmallIDs(pu.embargoes, (id) =>
        this._players.get(id)?.smallID(),
      );
      player.setEmbargoSmallIDs(smallIDs);
    });

    // Packed per-player stats and attack troop counts, the per-tick churn
    // that no longer travels in PlayerUpdate objects. Applied after pass 1
    // so first-emission players exist; their stats carry the same values
    // as the full update, so applying both is harmless.
    const stateOf = (smallID: number) => this._playerStates.get(smallID);
    applyPackedPlayerStats(gu.packedPlayerUpdates, stateOf);
    applyPackedAttackTroops(gu.packedAttackUpdates, stateOf);

    if (this._myClientID) {
      this._myPlayer ??= this.playerByClientID(this._myClientID);
    }

    for (const unit of this._units.values()) {
      unit._wasUpdated = false;
      // Only trim when a move appended a position â€” slicing a â‰¤1-element
      // array would allocate an identical array per unit per tick, and most
      // units (structures) never move.
      if (unit.lastPos.length > 1) {
        unit.lastPos = unit.lastPos.slice(-1);
      }
    }
    gu.updates[GameUpdateType.Unit].forEach((update) => {
      let unit = this._units.get(update.id);
      const isStructure = STRUCTURE_TYPES.has(update.unitType);
      if (unit !== undefined) {
        // Structure changes that affect rendering: owner changed (captured),
        // level changed, became inactive, or finished construction
        // (underConstruction â†’ !underConstruction).
        if (
          isStructure &&
          (unit.state.ownerID !== update.ownerID ||
            unit.state.level !== update.level ||
            unit.state.isActive !== update.isActive ||
            (unit.state.underConstruction &&
              !(update.underConstruction ?? false)))
        ) {
          this._structuresDirty = true;
        }
        const hasMotionPlan = this.motion.hasGridPlan(update.id);
        const oldPos = unit.state.pos;
        const oldLastPos = unit.state.lastPos;
        unit.update(update);
        if (hasMotionPlan) {
          unit.state.pos = oldPos;
          unit.state.lastPos = oldLastPos;
          unit.lastPos.pop();
        }
      } else {
        unit = new UnitView(this, update);
        this._units.set(update.id, unit);
        this._unitStates.set(update.id, unit.state);
        this.unitGrid.addUnit(unit);
        if (isStructure) this._structuresDirty = true;
      }
      if (!update.isActive) {
        this.unitGrid.removeUnit(unit);
      } else if (unit.tile() !== unit.lastTile()) {
        this.unitGrid.updateUnitCell(unit);
      }
      if (!unit.isActive()) {
        // Wait until next tick to delete the unit.
        this.toDelete.add(unit.id());
        this.motion.unitRemoved(unit.id());
      }
    });

    this.motion.advance(gu.tick, this.plannedUnits);

    this.populateFrame(gu);
  }

  /**
   * Armies are delivered whole, so this is a straight add/replace/remove pass
   * â€” no diffing. A disbanded army arrives one last time with
   * `isActive: false`; it is dropped here and the selection cleared if it was
   * the selected one, so the panel closes instead of pointing at nothing.
   */
  private applyArmyUpdates(gu: GameUpdateViewData): void {
    const updates = gu.updates[GameUpdateType.Army];
    if (updates.length === 0) return;
    for (const u of updates) {
      const existing = this._armies.get(u.id);
      if (u.isActive) {
        if (existing === undefined) {
          const view = new ArmyView(u.id);
          view.applyUpdate(u);
          this._armies.set(u.id, view);
        } else {
          existing.applyUpdate(u);
        }
      } else {
        this._armies.delete(u.id);
        if (this._selectedArmyId === u.id) this._selectedArmyId = null;
      }
    }
  }

  /**
   * Battle plans, same add/replace/remove shape as armies. A deleted plan
   * arrives once with `isActive: false` and is dropped here, so the panel's
   * selection and the renderer's stroke list both clear without any extra
   * message.
   */
  private applyBattlePlanUpdates(gu: GameUpdateViewData): void {
    const updates = gu.updates[GameUpdateType.BattlePlan];
    if (updates.length === 0) return;
    for (const u of updates) {
      const existing = this._battlePlans.get(u.id);
      if (u.isActive) {
        if (existing === undefined) {
          const view = new BattlePlanView(u.id);
          view.applyUpdate(u, this);
          this._battlePlans.set(u.id, view);
        } else {
          existing.applyUpdate(u, this);
        }
      } else {
        this._battlePlans.delete(u.id);
        if (this._selectedBattlePlanId === u.id) {
          this._selectedBattlePlanId = null;
        }
        if (this._hoveredBattlePlanId === u.id) {
          this._hoveredBattlePlanId = null;
        }
      }
    }
  }

  // â”€â”€ FrameData population â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Populate the long-lived FrameData from this tick's updates and current
   * state. Runs at the end of update() once all engine-driven mutations are
   * complete. Mutates _frame fields in place; never reassigns them.
   */
  private populateFrame(gu: GameUpdateViewData): void {
    // Reset trail dirty markers for this tick. The trailManager.update() pass
    // below repaints rows and re-sets these as it goes.
    this.trailManager.clearDirtyRows();

    // Railroad events accumulate into the cache; revealedRailTiles is cleared
    // at the start of apply().
    this.railroadCache.apply(gu);

    // Trail update: walk active trail-type units and stamp/decay.
    this._trailIdsScratch.length = 0;
    for (const u of this._units.values()) {
      if (u.isActive() && TRAIL_TYPES.has(u.type())) {
        this._trailIdsScratch.push(u.id());
      }
    }
    this.trailManager.update(
      this._unitStates as Map<number, import("../render/types").UnitState>,
      this._trailIdsScratch,
    );
    // Spiral nukeTrail ribbons follow the same tracked units; extends the
    // path of each live spiral-cosmetic nuke and drops dead ones.
    this.spiralTrails.update(
      this._unitStates as Map<number, import("../render/types").UnitState>,
      this._trailIdsScratch,
    );

    // Names map â€” rebuilt only when a placement record arrived or a player
    // was added (nameData values cannot change between those ticks). Entry
    // order is irrelevant for the renderer.
    if (this._namesDirty) {
      this._namesDirty = false;
      this._names.clear();
      for (const p of this._players.values()) {
        this._names.set(p.id(), {
          playerID: p.id(),
          x: p.nameData?.x ?? 0,
          y: p.nameData?.y ?? 0,
          size: p.nameData?.size ?? 0,
        });
      }
    }

    // FrameEvents â€” clear arrays, then re-populate from this tick's updates.
    this.buildFrameEvents(gu);

    // Update FrameData fields. Derived data is computed once per tick and
    // stored directly on _frame (no intermediate copy). The renderer's
    // `readonly` modifier on FrameData is just an external API hint â€”
    // not enforced at runtime; we cast off to assign here.
    const f = this._frame as {
      -readonly [K in keyof FrameData]: FrameData[K];
    };
    f.tick = gu.tick;
    f.inSpawnPhase = this.startTick === null;
    f.railroadDirty = this.railroadCache.railroadDirty;
    f.trailDirtyRowMin = this.trailManager.dirtyRowMin;
    f.trailDirtyRowMax = this.trailManager.dirtyRowMax;

    f.playerStatus = computePlayerStatus(this._playerStates, this._unitStates, {
      localPlayerSmallID: this._myPlayer?.smallID() ?? 0,
      localPlayerID: this._myPlayer?.id() ?? "",
      tileState: this._map.tileStateBuffer(),
      tick: gu.tick,
      allianceDuration: this._config.allianceDuration(),
      isTransitiveTarget: (sid) =>
        (this._markedPlayers?.has(sid) ?? false) ||
        (this._myPlayer?.hasTransitiveTarget(sid) ?? false),
      doomsdayClockWarnTicks:
        this._config.doomsdayClockConfig().warnSeconds * 10,
    });
    // Relations + clusters depend only on allies/embargoes/teams, which
    // change rarely (teams only when a player is added) â€” recompute only
    // when one of those inputs arrived this tick. buildRelationMatrix
    // writes into a reusable module-level buffer, so skipping the call
    // leaves f.relationMatrix's contents intact. f.relationsDirty lets the
    // upload layer skip the GPU push (and the full-map border recompute it
    // triggers) on unchanged ticks.
    if (this._relationsDirty) {
      this._relationsDirty = false;
      const rel = buildRelationMatrix(this._playerStates, this._teams);
      f.relationMatrix = rel.matrix;
      f.relationSize = rel.size;
      f.relationsDirty = true;
    } else {
      f.relationsDirty = false;
    }
    if (this._clustersDirty) {
      this._clustersDirty = false;
      f.allianceClusters = computeAllianceClusters(this._playerStates);
    }
    f.nukeTelegraphs = extractNukeTelegraphs(
      this._unitStates,
      this._map.width(),
      this._myPlayer?.smallID() ?? 0,
      // The latest relation matrix â€” recomputed above when dirty, otherwise
      // carried over on the frame from the last rebuild.
      f.relationMatrix,
      f.relationSize,
      this.motion.gridPlans(),
      gu.tick,
    );
    f.attackRings = this._myPlayer
      ? extractAttackRings(
          this._unitStates,
          this._map.width(),
          this._myPlayer.smallID(),
        )
      : [];
    f.structuresDirty = this._structuresDirty;

    // First populate: signal "full upload required" by nulling changedTiles.
    // uploadFrameData() treats null as "no delta info; do a full tile+trail
    // upload" â€” needed because the renderer's GPU buffers are empty.
    if (this._firstPopulate) {
      f.changedTiles = null;
      f.structuresDirty = true; // force initial structure upload
      this._firstPopulate = false;
    } else {
      // Live reference to this tick's changed refs â€” consumers copy what
      // they keep (TerritoryPass buckets them synchronously in the upload).
      f.changedTiles = this.updatedTiles;
    }

    // Reset transient flags for next tick.
    this.railroadCache.clearDirty();
    this._structuresDirty = false;
  }

  /** Clear and repopulate _frame.events arrays from this tick's gu.updates. */
  private buildFrameEvents(gu: GameUpdateViewData): void {
    const ev = this._frame.events;
    ev.deadUnits.length = 0;
    ev.conquestEvents.length = 0;
    ev.bonusEvents.length = 0;

    for (const u of gu.updates[GameUpdateType.Unit] ?? []) {
      if (u.isActive) continue;
      ev.deadUnits.push({
        unitType: u.unitType,
        pos: u.pos,
        reachedTarget: u.reachedTarget,
        ownerSmallID: u.ownerID,
      });
    }
    const myID = this._myPlayer?.id();
    for (const c of gu.updates[GameUpdateType.ConquestEvent] ?? []) {
      if (c.conquerorId !== myID) continue;
      const conquered = this._players.get(c.conqueredId);
      if (conquered === undefined) continue;
      const loc = conquered.nameLocation();
      if (loc === undefined) continue;
      ev.conquestEvents.push({
        x: loc.x,
        y: loc.y,
        gold: Number(c.gold),
      });
    }
    for (const b of gu.updates[GameUpdateType.BonusEvent] ?? []) {
      const player = this._players.get(b.player);
      if (player === undefined) continue;
      ev.bonusEvents.push({
        playerID: b.player,
        smallID: player.smallID(),
        tile: b.tile,
        gold: Number(b.gold),
        troops: b.troops,
      });
    }
  }

  /** Public accessor: the renderer reads this and uploads to the GPU. */
  frameData(): FrameData {
    return this._frame;
  }

  /**
   * Set a player's spiral nuke-trail geometry (from their nukeTrail
   * cosmetic). Pushed by WebGLFrameBuilder once the player's effect
   * resolves; their nukes then grow helix ribbons (SpiralTrails â†’
   * SpiralRibbonPass) on top of the plain stamped trail.
   */
  setNukeTrailSpiral(smallID: number, params: SpiralParams): void {
    this.spiralTrails.setParams(smallID, params);
  }

  clearNukeTrailSpiral(smallID: number): void {
    this.spiralTrails.clearParams(smallID);
  }

  recentlyUpdatedTiles(): TileRef[] {
    return this.updatedTiles;
  }

  recentlyUpdatedTerrainTiles(): TileRef[] {
    return this.updatedTerrainTiles;
  }
  recentlyNukedTiles(): TileRef[] {
    return this.nukeImpactTiles;
  }

  nearbyUnits(
    tile: TileRef,
    searchRange: number,
    types: UnitType | readonly UnitType[],
    predicate?: UnitPredicate,
  ): Array<{ unit: UnitView; distSquared: number }> {
    return this.unitGrid.nearbyUnits(
      tile,
      searchRange,
      types,
      predicate,
    ) as Array<{
      unit: UnitView;
      distSquared: number;
    }>;
  }

  hasUnitNearby(
    tile: TileRef,
    searchRange: number,
    type: UnitType,
    playerId?: PlayerID,
    includeUnderConstruction?: boolean,
  ) {
    return this.unitGrid.hasUnitNearby(
      tile,
      searchRange,
      type,
      playerId,
      includeUnderConstruction,
    );
  }

  anyUnitNearby(
    tile: TileRef,
    searchRange: number,
    types: readonly UnitType[],
    predicate: (unit: UnitView) => boolean,
    playerId?: PlayerID,
    includeUnderConstruction?: boolean,
  ): boolean {
    return this.unitGrid.anyUnitNearby(
      tile,
      searchRange,
      types,
      predicate as (unit: Unit | UnitView) => boolean,
      playerId,
      includeUnderConstruction,
    );
  }

  myClientID(): ClientID | undefined {
    return this._myClientID;
  }

  myPlayer(): PlayerView | null {
    return this._myPlayer;
  }

  player(id: PlayerID): PlayerView {
    const player = this._players.get(id);
    if (player === undefined) {
      throw Error(`player id ${id} not found`);
    }
    return player;
  }

  players(): PlayerView[] {
    return Array.from(this._players.values());
  }

  teamClanTag(team: Team | null): string | null {
    if (!team) return null;
    if (this._teamClanTags === null) {
      if (this._players.size === 0) return null;
      this._teamClanTags = this.initTeamClanTags();
    }
    return this._teamClanTags.get(team) ?? null;
  }

  invalidateTeamClanTags(): void {
    this._teamClanTags = null;
  }

  private initTeamClanTags(): Map<Team, string | null> {
    const teams = new Map<Team, PlayerView[]>();
    for (const player of this._players.values()) {
      const t = player.team();
      if (t) {
        let list = teams.get(t);
        if (!list) {
          list = [];
          teams.set(t, list);
        }
        list.push(player);
      }
    }
    const result = new Map<Team, string | null>();
    for (const [t, players] of teams.entries()) {
      result.set(t, resolveTeamClanTag(players));
    }
    return result;
  }

  /**
   * Recompute every player's theme-derived colors. Call when the active theme
   * changes mid-game (e.g. toggling colorblind mode) so existing territories
   * re-color; the renderer palette must be refreshed afterwards.
   */
  refreshPlayerColors(): void {
    for (const p of this._players.values()) {
      p.refreshColors();
    }
  }

  cosmeticVisibility(): CosmeticVisibility {
    return this._cosmeticVisibility;
  }

  /**
   * Re-read the cosmetics visibility settings and re-resolve every player's
   * drawn cosmetics and colors; the renderer must be refreshed afterwards.
   */
  refreshPlayerCosmetics(): void {
    this._cosmeticVisibility = readCosmeticVisibility();
    for (const p of this._players.values()) {
      p.refreshCosmetics();
    }
  }

  playerBySmallID(id: number): PlayerView | TerraNullius {
    if (id === 0) {
      return new TerraNulliusImpl();
    }
    const playerId = this.smallIDToID.get(id);
    if (playerId === undefined) {
      throw new Error(`small id ${id} not found`);
    }
    return this.player(playerId);
  }

  playerByClientID(id: ClientID): PlayerView | null {
    const player =
      Array.from(this._players.values()).filter(
        (p) => p.clientID() === id,
      )[0] ?? null;
    if (player === null) {
      return null;
    }
    return player;
  }
  hasPlayer(id: PlayerID): boolean {
    return false;
  }
  playerViews(): PlayerView[] {
    return Array.from(this._players.values());
  }

  owner(tile: TileRef): PlayerView | TerraNullius {
    return this.playerBySmallID(this.ownerID(tile));
  }

  ticks(): Tick {
    if (this.lastUpdate === null) return 0;
    return this.lastUpdate.tick;
  }
  // Set once the sim has decided the game (WinUpdate). Play may go on for
  // those who stay, but the server archives the record at that point.
  private _gameOver = false;
  gameOver(): boolean {
    return this._gameOver;
  }

  inSpawnPhase(): boolean {
    return this.startTick === null;
  }

  isSpawnImmunityActive(): boolean {
    return (
      this.inSpawnPhase() ||
      this.ticksSinceStart() < this._config.spawnImmunityDuration()
    );
  }
  isNationSpawnImmunityActive(): boolean {
    return (
      this.inSpawnPhase() ||
      this.ticksSinceStart() < this._config.nationSpawnImmunityDuration()
    );
  }

  elapsedGameSeconds(): number {
    return this.ticksSinceStart() / 10;
  }

  ticksSinceStart(): Tick {
    if (this.inSpawnPhase()) {
      return 0;
    }

    return Math.max(0, this.ticks() - this.startTick!);
  }
  config(): Config {
    return this._config;
  }
  isSpectator(): boolean {
    return !this.myPlayer()?.isAlive() || this._config.isReplay();
  }
  units(...types: UnitType[]): UnitView[] {
    if (types.length === 0) {
      return Array.from(this._units.values()).filter((u) => u.isActive());
    }
    return Array.from(this._units.values()).filter(
      (u) => u.isActive() && types.includes(u.type()),
    );
  }

  /**
   * Active units owned by the given player (smallID). The grouping is built
   * lazily at most once per tick; the returned array must not be mutated.
   */
  unitsOwnedBy(ownerSmallID: number): readonly UnitView[] {
    if (this._unitsByOwnerStale) {
      this._unitsByOwnerStale = false;
      this._unitsByOwner.clear();
      for (const u of this._units.values()) {
        if (!u.isActive()) continue;
        const sid = u.state.ownerID;
        const arr = this._unitsByOwner.get(sid);
        if (arr === undefined) {
          this._unitsByOwner.set(sid, [u]);
        } else {
          arr.push(u);
        }
      }
    }
    return this._unitsByOwner.get(ownerSmallID) ?? [];
  }
  unit(id: number): UnitView | undefined {
    return this._units.get(id);
  }

  // â”€â”€ Armies (Prompt 3) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Every live army, in creation order. */
  armies(): ArmyView[] {
    return [...this._armies.values()];
  }

  army(id: number): ArmyView | undefined {
    return this._armies.get(id);
  }

  /** The selected player's armies only. */
  myArmies(): ArmyView[] {
    const me = this.myPlayer();
    if (me === null) return [];
    return this.armies().filter((a) => a.ownerSmallID() === me.smallID());
  }

  armiesOf(ownerSmallID: number): ArmyView[] {
    return this.armies().filter((a) => a.ownerSmallID() === ownerSmallID);
  }

  /**
   * The army whose marker is under the given tile, preferring the local
   * player's own armies so a friendly marker on the same tile wins the click.
   * Returns the closest one when several armies share a tile.
   */
  armyAtTile(tile: TileRef): ArmyView | undefined {
    const me = this.myPlayer();
    let best: ArmyView | undefined;
    for (const a of this._armies.values()) {
      if (a.tile() !== tile) continue;
      const isMine = me !== null && a.ownerSmallID() === me.smallID();
      if (best === undefined || isMine) best = a;
      if (isMine) return a;
    }
    return best;
  }

  setSelectedArmy(id: number | null): void {
    this._selectedArmyId = id;
  }

  selectedArmy(): ArmyView | null {
    if (this._selectedArmyId === null) return null;
    const army = this._armies.get(this._selectedArmyId);
    if (army === undefined) {
      this._selectedArmyId = null;
      return null;
    }
    return army;
  }

  selectedArmyId(): number | null {
    return this._selectedArmyId;
  }

  // ─── Battle plans (Prompt 4) ───────────────────────────────────────────────

  /** Every live battle plan visible to this client, in creation order. */
  battlePlans(): BattlePlanView[] {
    return [...this._battlePlans.values()];
  }

  battlePlan(id: number): BattlePlanView | undefined {
    return this._battlePlans.get(id);
  }

  /** The local player's own plans. */
  myBattlePlans(): BattlePlanView[] {
    return this.battlePlans().filter((p) => p.isMine(this));
  }

  setHoveredBattlePlan(id: number | null): void {
    this._hoveredBattlePlanId = id;
  }

  hoveredBattlePlanId(): number | null {
    return this._hoveredBattlePlanId;
  }

  setSelectedBattlePlan(id: number | null): void {
    this._selectedBattlePlanId = id;
  }

  selectedBattlePlan(): BattlePlanView | null {
    if (this._selectedBattlePlanId === null) return null;
    const plan = this._battlePlans.get(this._selectedBattlePlanId);
    if (plan === undefined) {
      this._selectedBattlePlanId = null;
      return null;
    }
    return plan;
  }

  selectedBattlePlanId(): number | null {
    return this._selectedBattlePlanId;
  }

  /**
   * Whether the local player stands on friendly terms with a player.
   *
   * Reads the relation matrix that is already rebuilt each tick rather than
   * re-deriving alliance rules, so every subsystem that asks this question gets
   * the same answer.
   */
  isAlliedWith(otherSmallID: number): boolean {
    const me = this._myPlayer;
    if (me === null) return false;
    if (otherSmallID === me.smallID()) return true;
    return isFriendlyIn(
      this._frame.relationMatrix,
      this._frame.relationSize,
      me.smallID(),
      otherSmallID,
    );
  }

  /**
   * The plan whose drawn line passes under a tile, or null.
   *
   * Nearest-wins rather than first-wins so two plans drawn across the same front
   * both stay clickable: the one the pointer is actually closest to is the one
   * the player meant.
   */
  battlePlanNearTile(tile: TileRef): BattlePlanView | null {
    const x = this.x(tile);
    const y = this.y(tile);
    let best: BattlePlanView | null = null;
    let bestDistance = BATTLE_PLAN_PICK_RADIUS_TILES;
    for (const plan of this.battlePlans()) {
      const points = plan.polyline();
      for (let i = 0; i + 1 < points.length; i += 2) {
        const d =
          (points[i] - x) * (points[i] - x) + (points[i + 1] - y) * (points[i + 1] - y);
        if (d < bestDistance) {
          bestDistance = d;
          best = plan;
        }
      }
    }
    return best;
  }

  unitInfo(type: UnitType): UnitInfo {
    return this._config.unitInfo(type);
  }

  /**
   * Long-lived map of UnitState records, keyed by unit ID. Mutated in place
   * each tick by `update()`. Renderer code reads from this directly â€” the
   * UnitView wrapping each entry shares the same UnitState reference.
   *
   * Includes inactive units; renderer filters by `state.isActive`.
   */
  unitStates(): ReadonlyMap<number, import("../render/types").UnitState> {
    return this._unitStates;
  }

  /**
   * Long-lived map of PlayerState records, keyed by smallID. Mutated in place
   * each tick by `update()`. Renderer code reads from this directly.
   */
  playerStates(): ReadonlyMap<number, import("../render/types").PlayerState> {
    return this._playerStates;
  }

  ref(x: number, y: number): TileRef {
    return this._map.ref(x, y);
  }
  isValidRef(ref: TileRef): boolean {
    return this._map.isValidRef(ref);
  }
  x(ref: TileRef): number {
    return this._map.x(ref);
  }
  y(ref: TileRef): number {
    return this._map.y(ref);
  }
  cell(ref: TileRef): Cell {
    return this._map.cell(ref);
  }
  width(): number {
    return this._map.width();
  }
  height(): number {
    return this._map.height();
  }
  numLandTiles(): number {
    return this._map.numLandTiles();
  }
  waterVersion(): number {
    return this._map.waterVersion();
  }
  /** Map layers defined in the map's info.json, if any. */
  layers(): import("../../core/game/TerrainMapLoader").MapLayer[] {
    return this._mapData.layers ?? [];
  }
  isValidCoord(x: number, y: number): boolean {
    return this._map.isValidCoord(x, y);
  }
  isLand(ref: TileRef): boolean {
    return this._map.isLand(ref);
  }
  isImpassable(ref: TileRef): boolean {
    return this._map.isImpassable(ref);
  }
  isOceanShore(ref: TileRef): boolean {
    return this._map.isOceanShore(ref);
  }
  isOcean(ref: TileRef): boolean {
    return this._map.isOcean(ref);
  }
  isShoreline(ref: TileRef): boolean {
    return this._map.isShoreline(ref);
  }
  magnitude(ref: TileRef): number {
    return this._map.magnitude(ref);
  }
  terrainByte(ref: TileRef): number {
    return this._map.terrainByte(ref);
  }
  setWater(ref: TileRef): void {
    this._map.setWater(ref);
  }
  setShorelineBit(ref: TileRef): void {
    this._map.setShorelineBit(ref);
  }
  clearShorelineBit(ref: TileRef): void {
    this._map.clearShorelineBit(ref);
  }
  setOcean(ref: TileRef): void {
    this._map.setOcean(ref);
  }
  setMagnitude(ref: TileRef, value: number): void {
    this._map.setMagnitude(ref, value);
  }
  ownerID(ref: TileRef): number {
    return this._map.ownerID(ref);
  }
  hasOwner(ref: TileRef): boolean {
    return this._map.hasOwner(ref);
  }
  setOwnerID(ref: TileRef, playerId: number): void {
    return this._map.setOwnerID(ref, playerId);
  }
  hasFallout(ref: TileRef): boolean {
    return this._map.hasFallout(ref);
  }
  setFallout(ref: TileRef, value: boolean): void {
    return this._map.setFallout(ref, value);
  }
  isBorder(ref: TileRef): boolean {
    return this._map.isBorder(ref);
  }
  neighbors(ref: TileRef): TileRef[] {
    return this._map.neighbors(ref);
  }
  forEachNeighbor(ref: TileRef, callback: (neighbor: TileRef) => void): void {
    this._map.forEachNeighbor(ref, callback);
  }
  neighbors4(ref: TileRef, out: TileRef[]): number {
    return this._map.neighbors4(ref, out);
  }
  neighbors8(ref: TileRef, out: TileRef[]): number {
    return this._map.neighbors8(ref, out);
  }
  forEachNeighborWithDiag(
    ref: TileRef,
    callback: (neighbor: TileRef) => void,
  ): void {
    this._map.forEachNeighborWithDiag(ref, callback);
  }
  isWater(ref: TileRef): boolean {
    return this._map.isWater(ref);
  }
  isShore(ref: TileRef): boolean {
    return this._map.isShore(ref);
  }
  cost(ref: TileRef): number {
    return this._map.cost(ref);
  }
  terrainType(ref: TileRef): TerrainType {
    return this._map.terrainType(ref);
  }
  forEachTile(fn: (tile: TileRef) => void): void {
    return this._map.forEachTile(fn);
  }
  manhattanDist(c1: TileRef, c2: TileRef): number {
    return this._map.manhattanDist(c1, c2);
  }
  euclideanDistSquared(c1: TileRef, c2: TileRef): number {
    return this._map.euclideanDistSquared(c1, c2);
  }
  circleSearch(
    tile: TileRef,
    radius: number,
    filter?: (tile: TileRef, d2: number) => boolean,
  ): Set<TileRef> {
    return this._map.circleSearch(tile, radius, filter);
  }
  bfs(
    tile: TileRef,
    filter: (gm: GameMap, tile: TileRef) => boolean,
  ): Set<TileRef> {
    return this._map.bfs(tile, filter);
  }
  tileState(tile: TileRef): number {
    return this._map.tileState(tile);
  }
  tileStateBuffer(): Uint16Array {
    return this._map.tileStateBuffer();
  }
  updateTile(tile: TileRef, state: number): boolean {
    return this._map.updateTile(tile, state);
  }
  numTilesWithFallout(): number {
    return this._map.numTilesWithFallout();
  }
  gameID(): GameID {
    return this._gameID;
  }

  private _markedPlayers: ReadonlySet<number> | null = null;

  focusedPlayer(): PlayerView | null {
    return this.myPlayer();
  }

  /**
   * Extra smallIDs drawn with the target crosshair by the name pass, on top
   * of the player's real transitive targets (e.g. the tutorial pointing at
   * capturable tribes). Null when nothing is requested.
   */
  setMarkedPlayers(ids: ReadonlySet<number> | null): void {
    this._markedPlayers = ids;
  }

  markedPlayers(): ReadonlySet<number> | null {
    return this._markedPlayers;
  }

  private _ownSpawnRing = false;

  /**
   * Keep the local player's spawn-phase ring drawn after the phase ends
   * (the tutorial uses it to show a new player where their territory is).
   */
  setOwnSpawnRing(show: boolean): void {
    this._ownSpawnRing = show;
  }

  ownSpawnRing(): boolean {
    return this._ownSpawnRing;
  }
}
