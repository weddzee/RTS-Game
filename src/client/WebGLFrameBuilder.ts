import { colord } from "colord";
import { assetUrl } from "../core/AssetUrls";
import {
  type EffectAttributesFor,
  type EffectType,
  findEffectForSlot,
  isNukeExplosionEffect,
  type NukeExplosionAttributes,
  type NukeExplosionType,
} from "../core/CosmeticSchemas";
import {
  WING_MIN_EFFECTIVE_PERCENT,
  WING_START_AIRCRAFT,
} from "../core/game/Aircraft";
import { FactoryType } from "../core/game/Factory";
import { PlayerType, UnitType } from "../core/game/Game";
import { getCachedCosmetics } from "./Cosmetics";
import { buildTerrainRowSpans } from "./render/frame/derive/TerrainRowSpans";
import { uploadFrameData } from "./render/frame/Upload";
// Type-only: a value import would pull GPURenderer and its `.glsl?raw` shader
// imports into any non-Vite consumer (e.g. the Node perf harness).
import type { MapRenderer, PlayerStatic, SpawnCenter } from "./render/gl";
// Type-only: the label shape is plain data; importing the value would drag the
// pass module (and its shaders) into non-Vite consumers.
import type { AttackTroopLabel } from "./render/gl/passes/WorldTextPass";
import {
  DEFAULT_NUKE_EXPLOSION_COLOR,
  MAX_NUKE_EXPLOSION_COLORS,
  type NukeExplosionRenderParams,
} from "./render/types";
import {
  type AirMissionLine,
  type AirRegionOverlay,
  type AirWingMarker,
  packAirWingFlags,
} from "./render/types/AirWingMarker";
import {
  type ArmyMarker,
  packArmyMarkerFlags,
} from "./render/types/ArmyMarker";
// Value import from the leaf module (not the ./render/gl barrel) so non-Vite
// consumers don't pull in GPURenderer and its shaders — see note above.
import {
  EFFECT_PALETTE_BLOCKS,
  MAX_TRAIL_COLORS,
} from "./render/gl/utils/ColorUtils";
import type { PaletteEffectAttributes } from "./render/gl/utils/EffectPalette";
import {
  catalogEffectAttributes,
  PALETTE_SIZE,
  type PaletteEffectType,
  writePaletteEntry,
  writePatternEntry,
  writePlayerEffects,
} from "./render/gl/utils/PlayerPalette";
import {
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV_WARHEAD,
} from "./render/types/UnitType";
import { renderTroops } from "./Utils";
import type { GameView, PlayerView } from "./view";
import type { ArmyView } from "./view/ArmyView";

// A human player counts as "small" (and glows) at or below this fraction of the
// map; the glow is suppressed for a grace window after the game starts.
const SMALL_PLAYER_MAX_MAP_FRACTION = 0.002; // 0.2%
const SMALL_PLAYER_GLOW_GRACE_SECONDS = 60;
// The set is a visual aid, not tick-critical, so rescan ~once a second
// (10 ticks) instead of every tick.
const SMALL_PLAYER_GLOW_RESCAN_TICKS = 10;

// --- Army markers (Prompt 3.6) ---------------------------------------------
// At or above this device-px-per-tile the marker draws its detail ring and
// armies get name + strength labels. Below it a marker is just a colored kite.
const ARMY_MARKER_NEAR_ZOOM = 4.0;
const ARMY_MARKER_BASE_RADIUS = 0.75;
const ARMY_MARKER_RADIUS_BONUS = 0.75;
/** Radians between friendly armies sharing a tile. */
const ARMY_STACK_SPREAD = 1.0472; // 60 degrees
const ARMY_STACK_MAX_RADIUS = 1.6;
/** Strength normalization floor, so a tiny army does not render as a speck. */
const ARMY_STRENGTH_NORM_FLOOR = 0.08;

// --- Air map layer (Prompt 7.8) --------------------------------------------
// The whole air layer is one instanced pass (AirWingPass) fed from this method.
// These are the producer-side half of the layout; the pass owns the rest.
const AIR_WING_MARKER_RADIUS = 6.0;
/** Mission-line shaft half-width, tiles. */
const AIR_WING_LINE_HALF_WIDTH = 1.4;
/** Radians between wing icons sharing one region. */
const AIR_WING_SPREAD_ANGLE = 2.0944; // 120 degrees
/** Tiles a region's extra wing icons are pushed out by. */
const AIR_WING_REGION_SPREAD = 7.0;
/** Device px per tile below which the air layer is dropped entirely. */
const AIR_WING_CULL_ZOOM = 0.35;
/** Below this tile delta an airbase and its target region are the same place. */
const AIR_WING_LINE_MIN_LENGTH = 1.0;

/**
 * Marker size for an army, normalized against its owner's troop ceiling.
 *
 * Divided by a log curve rather than the raw ratio: army sizes span four orders
 * of magnitude over a match, and a linear scale would render every early army as
 * the minimum marker.
 */
function armyStrengthNorm(gameView: GameView, army: ArmyView): number {
  const owner = gameView.playerBySmallID(army.ownerSmallID());
  const ceiling = owner.isPlayer() ? owner.state.troops : 0;
  if (ceiling <= 0) return ARMY_STRENGTH_NORM_FLOOR;
  const raw = Math.min(1, army.strength() / (ceiling * 0.9));
  return Math.max(ARMY_STRENGTH_NORM_FLOOR, Math.log10(1 + raw * 99) / 2);
}

// Attribute → render-param mappings:
//   size      = the ring's final WIDTH (diameter) in world tiles when it fades
//               out — absolute, so maxRadius = size / 2 regardless of bomb type.
//   speed     = world tiles/s the ring's width grows, so the effect lasts
//               size / speed seconds (the pass clamps the duration).
//   thickness = the ring band's thickness in world tiles.
//   transitionSpeed passes through as the palette step rate (colors/s).

// Detonating bomb → nuke-explosion slot.
// Only these unit types produce a shockwave; plain MIRV splits and never detonates.
const UNIT_TYPE_TO_NUKE_TYPE: Readonly<Record<string, NukeExplosionType>> = {
  [UT_ATOM_BOMB]: "atom",
  [UT_HYDROGEN_BOMB]: "hydro",
  [UT_MIRV_WARHEAD]: "mirvWarhead",
};

function toRgb01(s: string): [number, number, number] | null {
  const c = colord(s);
  if (!c.isValid()) return null;
  const { r, g, b } = c.toRgb();
  return [r / 255, g / 255, b / 255];
}

/** Resolve a nuke-explosion cosmetic's catalog attributes into render params. */
export function attributesToExplosionParams(
  attrs: NukeExplosionAttributes,
): NukeExplosionRenderParams {
  // The shader cycles through the whole palette; the instance layout carries
  // at most MAX_NUKE_EXPLOSION_COLORS, extras are dropped.
  const colors = attrs.colors
    .map(toRgb01)
    .filter((c): c is [number, number, number] => c !== null)
    .slice(0, MAX_NUKE_EXPLOSION_COLORS);
  const base = {
    colors: colors.length > 0 ? colors : [DEFAULT_NUKE_EXPLOSION_COLOR],
    maxRadius: attrs.size / 2,
    speed: attrs.speed,
    thickness: attrs.thickness,
    transitionSpeed: attrs.transitionSpeed ?? 0,
  };
  return attrs.type === "sparkles"
    ? { ...base, type: "sparkles", density: attrs.density }
    : attrs.type === "embers"
      ? { ...base, type: "embers", density: attrs.density }
      : { ...base, type: "shockwave" };
}

/**
 * The renderer-side glue between GameView (which already builds the full
 * FrameData each tick) and the WebGL view. Two responsibilities:
 *
 *   1. Palette management — translate PlayerView colors into a Float32Array
 *      the renderer uploads to a 1D texture, and call view.addPlayers() when
 *      new players appear (this is a renderer-side lifecycle event, not part
 *      of FrameData).
 *   2. Per-tick upload — pass the FrameData to the renderer's uploadFrameData
 *      helper, which dispatches to all the view.update*() methods.
 */
export class WebGLFrameBuilder {
  private readonly palette: Float32Array;
  // Per-player effect palette, keyed by smallID. Layout is
  // 4096×(MAX_TRAIL_COLORS·EFFECT_PALETTE_BLOCKS): block 0 (rows 0–7) =
  // transportShipTrail, block 1 (rows 8–15) = nukeTrail, block 2 (rows 16–23)
  // = structures, block 3 (rows 24–31) = warship, block 4 (rows 32–39) =
  // train, block 5 (rows 40–47) = railroad. Consumed by TrailPass (block from
  // the trail tile's nuke bit), StructurePass (block 2), UnitPass (blocks 3
  // and 4), and RailroadPass (block 5).
  private readonly effectPalette: Float32Array;
  private readonly patternMeta: Float32Array;
  private readonly patternData: Uint8Array;

  private readonly knownSmallIDs = new Set<number>();
  /**
   * smallIDs whose trail effect has been resolved into the effect palette.
   * Separate from knownSmallIDs because effect resolution depends on the
   * cosmetics catalog, which may not be loaded the tick a player is first seen
   * — keeping it separate lets us retry next tick instead of skipping forever.
   */
  private readonly effectResolved = new Set<number>();
  /**
   * Effect-editor overrides (debug GUI): catalog-shaped attributes that
   * replace the LOCAL player's equipped effect per type — this client's
   * rendering only. Trail / structures / warship / train / railroad
   * overrides are applied by syncPlayerEffects (the
   * local player is re-resolved on change); the nukeExplosion override is
   * applied per detonation in resolveDeadUnitExplosions.
   */
  private readonly effectOverrides = new Map<
    EffectType,
    EffectAttributesFor<EffectType>
  >();
  /**
   * Set once any override has been applied: the local player then resolves
   * through the override path even after the last override is removed, so
   * the entries it wrote get cleared (also when no catalog is loaded).
   */
  private effectOverridesUsed = false;
  /**
   * Last spawn tile pushed to the renderer per smallID. Players can re-pick
   * spawn during the spawn phase, so this tracks the latest value rather than
   * just first-seen — re-uploads only when the tile actually changes.
   */
  private readonly lastSpawnTile = new Map<number, number>();
  /** Skin atlas allocated once on first syncPlayers — player set is locked at game start. */
  private skinsInitialized = false;
  // The renderer needs to know which player is "me" so affiliation tint,
  // unit colors, and SAM-radius perspective work. Push it once the local
  // player's update arrives (may take several ticks during join).
  private localPlayerSmallID = 0;

  constructor(private readonly view: MapRenderer) {
    this.palette = new Float32Array(PALETTE_SIZE * 2 * 4);
    this.effectPalette = new Float32Array(
      PALETTE_SIZE * MAX_TRAIL_COLORS * EFFECT_PALETTE_BLOCKS * 4,
    );
    this.patternMeta = new Float32Array(PALETTE_SIZE * 4);
    this.patternData = new Uint8Array(PALETTE_SIZE * 1024);
  }

  /** Drop internal caches to force a full re-upload of state on the next update(). */
  clearCaches(): void {
    this.knownSmallIDs.clear();
    this.effectResolved.clear();
    // Effect uploads are change-driven against this mirror; the restored GPU
    // texture starts zeroed, so the mirror must too or nothing re-uploads.
    this.effectPalette.fill(0);
    this.lastSpawnTile.clear();
    this.localPlayerSmallID = 0;
    this.skinsInitialized = false;
  }

  /**
   * Re-write every player's palette entry from their current (possibly re-themed)
   * colors and re-upload just the palette texture. Used after a mid-game theme
   * change (e.g. toggling colorblind mode) so existing territories re-color
   * without re-syncing players, skins, or spawns.
   */
  refreshPalette(gameView: GameView): void {
    for (const p of gameView.players()) {
      writePaletteEntry(
        this.palette,
        p.smallID(),
        p.territoryColor(),
        p.borderColor(),
      );
    }
    this.view.updatePalette(this.palette);
  }

  /**
   * Re-resolve every player's display name (e.g. after toggling the
   * anonymous-names setting) and push it to the renderer so the names drawn on
   * the map switch live, matching the leaderboard.
   */
  refreshNames(gameView: GameView): void {
    const displayNames = new Map<string, string>();
    for (const p of gameView.players()) {
      displayNames.set(p.id(), p.displayName());
    }
    this.view.refreshNames(displayNames);
  }

  /**
   * Set (or clear with null) the effect-editor override for one effect type.
   * Takes effect on the next tick: the local player's effect entries are
   * re-resolved from overrides first, then the catalog.
   */
  setEffectOverride<T extends EffectType>(
    effectType: T,
    attrs: EffectAttributesFor<T> | null,
  ): void {
    if (attrs) this.effectOverrides.set(effectType, attrs);
    else this.effectOverrides.delete(effectType);
    this.effectOverridesUsed = true;
    if (this.localPlayerSmallID !== 0) {
      this.effectResolved.delete(this.localPlayerSmallID);
    }
  }

  private readonly highlightSetBuf = new Uint8Array(PALETTE_SIZE);
  private glowRescanTick = 0;

  update(gameView: GameView): void {
    this.syncPlayers(gameView);
    this.syncPlayerEffects(gameView);
    this.syncPlayerSpawns(gameView);
    this.syncLocalPlayer(gameView);
    this.syncSpawnOverlay(gameView);
    this.syncArmyMarkers(gameView);
    this.syncAirWings(gameView);
    this.syncSmallPlayerGlow(gameView);
    this.syncTerrainDeltas(gameView);
    this.syncNukeImpacts(gameView);
    this.resolveDeadUnitExplosions(gameView);
    uploadFrameData(this.view, gameView.frameData());
  }

  /**
   * Attach the firing player's resolved nuke-explosion cosmetic to each dead
   * nuke event, so every client renders the shockwave in the owner's colors.
   * The effect is per-bomb-type: the detonating unit maps to a nukeType slot
   * (atom / hydro / mirvWarhead) and we resolve the player's selection for THAT
   * slot, so an atom effect only shows on atom bombs, etc. Runs before
   * uploadFrameData so the FX pass sees the params on the event; a player with no
   * selection for that bomb is left undefined (the shockwave falls back to default).
   */
  private resolveDeadUnitExplosions(gameView: GameView): void {
    const deadUnits = gameView.frameData().events.deadUnits;
    if (deadUnits.length === 0) return;
    const override = this.effectOverrides.get("nukeExplosion") as
      | NukeExplosionAttributes
      | undefined;
    const catalog = getCachedCosmetics();
    if (!catalog && !override) return; // Catalog not loaded yet — default FX this frame.
    for (const du of deadUnits) {
      if (!du.reachedTarget) continue; // SAM interceptions have no explosion cosmetic
      const nukeType = UNIT_TYPE_TO_NUKE_TYPE[du.unitType];
      if (!nukeType) continue; // not a shockwave-producing bomb
      // Effect-editor override: the local player's bombs of the edited type.
      if (
        override &&
        override.nukeType === nukeType &&
        du.ownerSmallID === this.localPlayerSmallID
      ) {
        du.explosion = attributesToExplosionParams(override);
        continue;
      }
      if (!catalog) continue;
      // playerBySmallID throws on an unknown smallID; a stale/bad event must
      // not kill the frame builder — skip it (default FX).
      let player: ReturnType<GameView["playerBySmallID"]>;
      try {
        player = gameView.playerBySmallID(du.ownerSmallID);
      } catch {
        continue;
      }
      if (!player.isPlayer()) continue;
      const name = player.cosmetics.effects?.[nukeType]?.name;
      if (!name) continue;
      const effect = findEffectForSlot(catalog, nukeType, name);
      if (!effect || !isNukeExplosionEffect(effect)) continue;
      du.explosion = attributesToExplosionParams(effect.attributes);
    }
  }

  /**
   * Push each player's current spawn tile to the renderer as the skin anchor
   * (image center lines up with this tile). Players re-pick spawn during the
   * spawn phase, so we re-upload whenever the tile changes, not just on first
   * sighting. Once spawn phase ends, spawnTile is locked and this becomes a
   * no-op via the cache check.
   */
  private syncPlayerSpawns(gameView: GameView): void {
    for (const p of gameView.players()) {
      const smallID = p.smallID();
      const spawnTile = p.state.spawnTile;
      if (spawnTile === undefined) continue;
      if (this.lastSpawnTile.get(smallID) === spawnTile) continue;
      this.lastSpawnTile.set(smallID, spawnTile);
      this.view.setPlayerSpawn(
        smallID,
        gameView.x(spawnTile),
        gameView.y(spawnTile),
      );
    }
  }

  /**
   * Water-nuke conversions (land → water) mutate the underlying terrain.
   * Forward this tick's terrain-changed refs to the renderer so it can
   * re-upload those texels in both the RGBA color texture and the R8UI
   * water-detection texture used by railroads/bridges. Refs are batched into
   * per-row spans — a massive bomb changes tens of thousands of tiles, and
   * per-tile 1×1 uploads cost hundreds of ms of GL driver time.
   */
  private syncTerrainDeltas(gameView: GameView): void {
    const refs = gameView.recentlyUpdatedTerrainTiles();
    if (refs.length === 0) return;
    const { rects, bytes } = buildTerrainRowSpans(
      refs,
      gameView.width(),
      (ref) => gameView.terrainByte(ref),
    );
    this.view.applyTerrainRects(rects, bytes);
  }

  /**
   * Mark nukeable layer tiles as destroyed from this tick's nuke impacts.
   * Uses the full blast radius (both land and water tiles), not just the
   * terrain-changed subset.  Batches tile updates per layer for a single
   * GPU texture upload per nukeable layer.
   */
  private syncNukeImpacts(gameView: GameView): void {
    const nukedTiles = gameView.recentlyNukedTiles();
    if (nukedTiles.length === 0) return;
    const layers = gameView.layers();
    for (const layer of layers) {
      if (!layer.nukeable) continue;
      // Filter blast-radius tiles to only those matching this layer's
      // placement.  A water layer only needs water tiles destroyed; land
      // tiles in the blast radius are invisible to it (shader discards).
      const wantLand = layer.placement === "land";
      const tiles = nukedTiles.filter((t) => gameView.isLand(t) === wantLand);
      if (tiles.length === 0) continue;
      this.view.markLayerTilesDestroyed(layer.id, tiles);
    }
  }

  private syncLocalPlayer(gameView: GameView): void {
    const me = gameView.myPlayer();
    const sid = me?.smallID() ?? 0;
    if (sid === this.localPlayerSmallID) return;
    this.localPlayerSmallID = sid;
    this.view.setLocalPlayerID(sid);
    // Overrides set before the local player resolved apply to them now.
    if (sid !== 0 && this.effectOverridesUsed) {
      this.effectResolved.delete(sid);
    }
    // Players resolved before the local player couldn't tell who's a teammate.
    if (gameView.cosmeticVisibility().showFrom === "teammates") {
      this.refreshCosmetics(gameView);
    }
    if (me) {
      const rail = me.railColor().toRgb();
      this.view.setLocalRailColor(rail.r / 255, rail.g / 255, rail.b / 255);
    }
  }

  /**
   * Spawn-phase highlights: each already-spawned human player gets a colored
   * ring + tile glow around their starting territory. Pushed every tick
   * during spawn phase; the pass animates locally from the snapshot.
   */
  private syncSpawnOverlay(gameView: GameView): void {
    const inSpawnPhase = gameView.inSpawnPhase();
    // Past the spawn phase only the local ring can stay up (the tutorial
    // keeps it while a new player finds their territory).
    if (!inSpawnPhase && !gameView.ownSpawnRing()) {
      this.view.updateSpawnOverlay(false, []);
      return;
    }
    const me = gameView.myPlayer();
    const myTeam = me?.team() ?? null;
    const centers: SpawnCenter[] = [];
    for (const p of gameView.players()) {
      if (!p.isPlayer() || p.type() !== PlayerType.Human) continue;
      const spawnTile = p.state.spawnTile;
      if (spawnTile === undefined) continue;
      const isSelf = me !== null && p.smallID() === me.smallID();
      if (!inSpawnPhase && !isSelf) continue;
      // myPlayer's ring pulses white→this color in SpawnOverlayPass: gold
      // when teamless, own territory tint in team games (matches teammates'
      // rings). Everyone else uses their territory tint directly.
      const c = p.territoryColor().toRgb();
      const useGold = isSelf && myTeam === null;
      centers.push({
        // spawnTile tracks the player's currently-selected spawn directly —
        // updates the same tick the player picks a new location (faster than
        // the nameData centroid which only refreshes every 2 ticks).
        x: gameView.x(spawnTile),
        y: gameView.y(spawnTile),
        r: useGold ? 1 : c.r / 255,
        g: useGold ? 0.84 : c.g / 255,
        b: useGold ? 0 : c.b / 255,
        isSelf,
        isTeammate:
          myTeam !== null &&
          p.team() === myTeam &&
          p.smallID() !== me?.smallID(),
      });
    }
    this.view.updateSpawnOverlay(inSpawnPhase, centers);
  }

  /**
   * Army markers and their labels (Prompt 3.6).
   *
   * Both levels of detail are decided here rather than in the pass, so the LOD
   * policy reads in one place:
   *   - zoomed out: one small kite in the owner color, no text at all.
   *   - close zoom: the kite gains its detail ring and a status slash, and the
   *     army's custom name plus its strength get a world-anchored label.
   *
   * Friendly armies sharing a tile are fanned out on a small ring rather than
   * drawn on top of each other. Enemies are never fanned: seeing a pile of
   * enemy markers is the information.
   */
  private syncArmyMarkers(gameView: GameView): void {
    const armies = gameView.armies();
    if (armies.length === 0) {
      this.view.updateArmyMarkers([]);
      this.view.setArmyLabels([]);
      return;
    }
    const me = gameView.myPlayer();
    const zoom = this.view.cameraZoom();
    const isNear = zoom >= ARMY_MARKER_NEAR_ZOOM;

    // Bucket by tile so stacks can be detected without an O(n^2) sweep.
    const byTile = new Map<number, number[]>();
    for (let i = 0; i < armies.length; i++) {
      const tile = armies[i].tile();
      const bucket = byTile.get(tile);
      if (bucket === undefined) byTile.set(tile, [i]);
      else bucket.push(i);
    }

    const markers: ArmyMarker[] = [];
    const labels: AttackTroopLabel[] = [];

    for (let i = 0; i < armies.length; i++) {
      const army = armies[i];
      const owner = gameView.playerBySmallID(army.ownerSmallID());
      const color = owner.isPlayer() ? owner.territoryColor().toRgb() : null;
      const r = color === null ? 1 : color.r / 255;
      const g = color === null ? 0.6 : color.g / 255;
      const b = color === null ? 0.2 : color.b / 255;

      const isOwn = me !== null && army.ownerSmallID() === me.smallID();
      const isFriendly =
        isOwn || (me !== null && owner.isPlayer() && me.isFriendly(owner));

      // Fan out friendly stacks; a lone army does not move at all.
      const stack = byTile.get(army.tile())!;
      let x = gameView.x(army.tile()) + 0.5;
      let y = gameView.y(army.tile()) + 0.5;
      if (stack.length > 1 && isFriendly) {
        const angle =
          (ARMY_STACK_SPREAD * (i - stack.indexOf(i)) * (Math.PI * 2)) /
          Math.max(stack.length, 2);
        const radius = Math.min(ARMY_STACK_MAX_RADIUS, stack.length * 0.25);
        x += Math.cos(angle) * radius;
        y += Math.sin(angle) * radius;
      }

      markers.push({
        x,
        y,
        sizeTiles:
          ARMY_MARKER_BASE_RADIUS +
          ARMY_MARKER_RADIUS_BONUS * armyStrengthNorm(gameView, army),
        flags: packArmyMarkerFlags({
          isOwn,
          isFriendly,
          isSelected: gameView.selectedArmyId() === army.id,
          isMoving: army.movementState() === "moving",
          isEngaging: army.movementState() === "engaging",
          isAttacking: army.combatState() === "attacking",
          isNear,
        }),
        r,
        g,
        b,
      });

      // The custom name is the point of the whole system, so it is what shows
      // at close zoom — ahead of the strength, which the kite size already
      // conveys.
      if (isNear && isFriendly) {
        labels.push({
          x,
          y,
          text: `${army.name()} ${renderTroops(army.strength())}`,
          colorR: r,
          colorG: g,
          colorB: b,
        });
      }
    }

    this.view.updateArmyMarkers(markers);
    this.view.setArmyLabels(labels);
  }

  /**
   * The air map layer (Prompt 7.8): region overlay, wing icons, mission lines.
   *
   * Built entirely from state the client already mirrors — region rectangles and
   * the leader's share arrive in AirRegionUpdate, wings in AirWingUpdate — so
   * this does no simulation. It is a projection: what the sim decided, drawn.
   *
   * Two decisions worth stating, because both are about not lying to the player:
   *
   *  - Only regions the sim reported are drawn. The client never re-derives the
   *    grid, so the overlay shows the same regions the air war is actually
   *    resolving rather than a plausible-looking second opinion.
   *  - The data is pushed whether or not air mode is on; the pass decides
   *    whether to draw. So toggling the overlay is instant and never needs a
   *    resend, and turning it on does not depend on having predicted a toggle.
   */
  private syncAirWings(gameView: GameView): void {
    const regions = gameView.airRegions();
    const wings = gameView.airWings();
    if (regions.length === 0 && wings.length === 0) {
      this.view.updateAirWings({ regions: [], markers: [], lines: [] });
      return;
    }

    const me = gameView.myPlayer();
    const zoom = this.view.cameraZoom();
    // Below the cull zoom the whole grid is sub-pixel; the army-marker precedent
    // is to drop detail rather than shade a continent with hairline borders.
    if (zoom < AIR_WING_CULL_ZOOM) {
      this.view.updateAirWings({ regions: [], markers: [], lines: [] });
      return;
    }

    const meID = me?.smallID() ?? -1;

    const overlays: AirRegionOverlay[] = regions.map((r) => {
      const leaderID = r.leaderSmallID();
      const color = leaderID === null ? null : this.airWingColor(gameView, leaderID);
      return {
        regionId: r.regionId(),
        x: r.x(),
        y: r.y(),
        width: r.width(),
        height: r.height(),
        sharePercent: r.sharePercent(),
        color,
        contested: r.contested(),
      };
    });

    // Each owner's airbase, for mission-line origins. One Air Factory per owner
    // is the normal case; if they have several, the lowest unit id wins, which
    // is stable across clients for the same reason target selection is.
    const airBases = new Map<number, { x: number; y: number }>();
    const factories = gameView.units(UnitType.Factory);
    for (const factory of factories) {
      if (factory.state.factoryType !== FactoryType.Air) continue;
      const ownerID = factory.state.ownerID;
      if (airBases.has(ownerID)) continue;
      airBases.set(ownerID, {
        x: gameView.x(factory.state.pos) + 0.5,
        y: gameView.y(factory.state.pos) + 0.5,
      });
    }

    // Fan out wings sharing a region so two icons in one region are both
    // readable. Only same-region wings collide, so this is a per-region index
    // rather than a map-wide sweep.
    const byRegion = new Map<number, number>();
    const markers: AirWingMarker[] = [];
    const lines: AirMissionLine[] = [];

    for (const wing of wings) {
      const regionID = wing.regionId();
      if (regionID === null) continue;
      const region = gameView.airRegion(regionID);
      // An assigned wing whose region the sim did not report (it was wiped out
      // this wave) has nowhere to fly: skip it rather than inventing a position.
      if (region === undefined) continue;

      const ownerID = wing.ownerSmallID();
      const color = this.airWingColor(gameView, ownerID);
      const isOwn = ownerID === meID;

      // A wing at zero aircraft is drawn hollow and only when it is the local
      // player's, since a rebuild in progress is their problem to see.
      const count = wing.aircraftCount();
      if (count === 0 && !isOwn) continue;

      const index = byRegion.get(regionID) ?? 0;
      byRegion.set(regionID, index + 1);

      const flags = packAirWingFlags({
        isOwn,
        mission: wing.mission().type,
        isDepleted:
          count * 100 <= WING_START_AIRCRAFT * WING_MIN_EFFECTIVE_PERCENT,
        isSelected: gameView.selectedAirWingId() === wing.id,
      });

      const spread = AIR_WING_REGION_SPREAD;
      const angle = index * AIR_WING_SPREAD_ANGLE;
      markers.push({
        wingId: wing.id,
        x: region.centerX() + Math.cos(angle) * spread,
        y: region.centerY() + Math.sin(angle) * spread,
        sizeTiles: AIR_WING_MARKER_RADIUS,
        flags,
        r: color.r,
        g: color.g,
        b: color.b,
      });

      // Mission line: from the wing's airbase to the region it flies in. Only
      // drawn when the owner still has an Air Factory to launch from — without
      // one the wing has no home on the map and a line to nowhere is worse than
      // no line.
      const base = airBases.get(ownerID);
      if (count > 0 && base !== undefined) {
        const toX = region.centerX();
        const toY = region.centerY();
        // Skip a degenerate line (base inside the region it flies) rather than
        // pushing a zero-length segment through the shader.
        if (
          Math.abs(base.x - toX) > AIR_WING_LINE_MIN_LENGTH ||
          Math.abs(base.y - toY) > AIR_WING_LINE_MIN_LENGTH
        ) {
          lines.push({
            fromX: base.x,
            fromY: base.y,
            toX,
            toY,
            widthTiles: AIR_WING_LINE_HALF_WIDTH,
            flags,
            r: color.r,
            g: color.g,
            b: color.b,
          });
        }
      }
    }

    this.view.updateAirWings({ regions: overlays, markers, lines });
  }

  /**
   * An air overlay color from a player's territory color, so the air map and the
   * ground map always agree on who a wing belongs to. Falls back to white for a
   * player the client has not seen a color for yet.
   */
  private airWingColor(
    gameView: GameView,
    smallID: number,
  ): { r: number; g: number; b: number } {
    const owner = gameView.playerBySmallID(smallID);
    if (!owner.isPlayer()) return { r: 1, g: 1, b: 1 };
    const rgb = owner.territoryColor().toRgb();
    return { r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255 };
  }

  /**
   * Small-player glow: when the client "Highlight small players" setting is on,
   * collect the alive human players holding <=0.2% of the map and push their
   * smallIDs so the glow pass radiates around their territory. Skips the first
   * minute of play so everyone's tiny starting territory doesn't glow.
   * Client-only view — toggle it live in the settings.
   */
  private syncSmallPlayerGlow(gameView: GameView): void {
    // Strength (incl. off at 0) is read live in the glow pass; here we only
    // decide who qualifies. Skip spawn + the first minute.
    if (
      gameView.inSpawnPhase() ||
      gameView.elapsedGameSeconds() < SMALL_PLAYER_GLOW_GRACE_SECONDS
    ) {
      this.view.updateSmallPlayerGlow(null);
      return;
    }
    // Throttle the per-player scan + upload; the glow keeps rendering the last
    // set between rescans. The off/spawn/grace checks above run every tick, so
    // toggling off takes effect on the next tick (deferred while the game is
    // paused, since ticks stop; it clears on unpause).
    if (this.glowRescanTick++ % SMALL_PLAYER_GLOW_RESCAN_TICKS !== 0) return;
    // "% of the map" uses the same denominator the leaderboard/win-check use.
    const denom = gameView.numLandTiles() - gameView.numTilesWithFallout();
    if (denom <= 0) {
      this.view.updateSmallPlayerGlow(null);
      return;
    }
    const set = this.highlightSetBuf;
    set.fill(0);
    let any = false;
    for (const p of gameView.players()) {
      if (!p.isPlayer() || p.type() !== PlayerType.Human || !p.isAlive()) {
        continue;
      }
      if (p.numTilesOwned() / denom <= SMALL_PLAYER_MAX_MAP_FRACTION) {
        set[p.smallID()] = 1;
        any = true;
      }
    }
    this.view.updateSmallPlayerGlow(any ? set : null);
  }

  private syncPlayers(gameView: GameView): void {
    if (!this.skinsInitialized) {
      this.skinsInitialized = true;
      // Hidden skins are registered too, so the cosmetics visibility settings
      // can reveal them mid-game.
      const urls = new Set<string>();
      for (const p of gameView.players()) {
        const url = p.equippedCosmetics.skin?.url;
        if (url) urls.add(assetUrl(url));
      }
      this.view.initSkinAtlas([...urls]);
    }
    const newPlayers: PlayerStatic[] = [];
    for (const p of gameView.players()) {
      const smallID = p.smallID();
      if (this.knownSmallIDs.has(smallID)) continue;
      this.knownSmallIDs.add(smallID);
      newPlayers.push(this.writePlayerCosmetics(p));
    }
    if (newPlayers.length > 0) {
      this.view.addPlayers(
        newPlayers,
        this.palette,
        this.patternMeta,
        this.patternData,
      );
    }
  }

  /**
   * Re-apply the cosmetics visibility settings mid-game: re-resolve which
   * cosmetics every player shows, rewrite their colors, skin, pattern, flag
   * and crown, and re-resolve their effects on the next update().
   */
  refreshCosmetics(gameView: GameView): void {
    gameView.refreshPlayerCosmetics();
    const players: PlayerStatic[] = [];
    for (const p of gameView.players()) {
      if (!this.knownSmallIDs.has(p.smallID())) continue;
      players.push(this.writePlayerCosmetics(p));
    }
    this.view.updatePlayerCosmetics(
      players,
      this.palette,
      this.patternMeta,
      this.patternData,
    );
    this.effectResolved.clear();
    // Ticks (and so update()) stop while the game is paused.
    this.syncPlayerEffects(gameView);
  }

  /**
   * Write a player's palette entry, skin and pattern for upload, and return
   * their renderer header. Also clears whatever a now-hidden cosmetic wrote.
   */
  private writePlayerCosmetics(p: PlayerView): PlayerStatic {
    const smallID = p.smallID();
    writePaletteEntry(
      this.palette,
      smallID,
      p.territoryColor(),
      p.borderColor(),
    );

    // p.cosmetics.flag has already been server-resolved to either a full URL
    // or a relative asset path (e.g. "/flags/US.svg" or a CDN URL for a
    // custom flag). assetUrl() passes URLs through and rewrites paths.
    const flagRef = p.cosmetics.flag;
    const flagUrl = flagRef ? assetUrl(flagRef) : undefined;

    // Crown cosmetic: already server-resolved to the catalog image URL.
    const crownRef = p.cosmetics.crown?.url;
    const crownUrl = crownRef ? assetUrl(crownRef) : undefined;

    if (p.equippedCosmetics.skin?.url) {
      const skinUrl = p.cosmetics.skin?.url;
      this.view.setPlayerSkin(smallID, skinUrl ? assetUrl(skinUrl) : null);
    }

    writePatternEntry(
      this.patternMeta,
      this.patternData,
      smallID,
      p.cosmetics.pattern,
    );

    return {
      ...p.static,
      // displayName() honors the anonymous-names setting; static.displayName
      // is always the real name.
      displayName: p.displayName(),
      flag: flagUrl,
      crown: crownUrl,
      verified: p.cosmetics.verified === true,
      color: p.territoryColor().toHex(),
    };
  }

  /**
   * Resolve each player's transport-ship-trail effect into the effect palette.
   * A player's resolved cosmetic is just { name, effectType }; the style and
   * colors live in the catalog, so we look them up via the cached cosmetics.
   * Decoupled from syncPlayers' first-seen guard: if the catalog isn't loaded
   * yet we leave the player unresolved and retry next tick (the trail keeps its
   * territory color meanwhile). Re-uploads the effect texture only when a
   * recognized style was actually written.
   */
  private syncPlayerEffects(gameView: GameView): void {
    const catalog = getCachedCosmetics();
    let dirty = false;
    for (const p of gameView.players()) {
      const smallID = p.smallID();
      if (this.effectResolved.has(smallID)) continue;
      // Effect-editor overrides apply to the local player only and don't need
      // the catalog; everyone else waits for it (retry on a later tick).
      const overrides =
        smallID === this.localPlayerSmallID && this.effectOverridesUsed
          ? this.effectOverrides
          : null;
      if (!catalog && !overrides) continue;
      // An override-only player (catalog still loading) is re-checked each
      // tick so their real cosmetics resolve once the catalog arrives.
      if (catalog) this.effectResolved.add(smallID);

      const attrsFor = (effectType: PaletteEffectType) =>
        (overrides?.get(effectType) as PaletteEffectAttributes | undefined) ??
        (catalog
          ? catalogEffectAttributes(catalog, p.cosmetics.effects, effectType)
          : undefined);
      if (writePlayerEffects(this.effectPalette, smallID, attrsFor, gameView)) {
        dirty = true;
      }
    }
    if (dirty) this.view.updateEffectPalette(this.effectPalette);
  }
}
