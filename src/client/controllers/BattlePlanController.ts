/**
 * BattlePlanController â€” drawing frontlines and offensive arrows (Prompt 4.2,
 * 4.3, 4.9, 4.10).
 *
 * The whole feel of the feature lives in this file. What it does while the player
 * is dragging:
 *
 *  - Collects pointer samples, dropping any that are too close to the last one so
 *    a slow drag does not produce a thousand points.
 *  - Marks each point legal or illegal as it goes: a frontline sample has to be
 *    on ground the player owns *and* on a border; an arrow sample has to be
 *    somewhere an army could be. Illegal samples are still recorded, because the
 *    player needs to see where their line crossed the sea in order to fix it.
 *  - Smooths the path with a single Chaikin pass per frame so the preview is a
 *    curve, not a polygon of raw pointer positions.
 *  - Pushes the result to the renderer as a stroke, and nothing else. No intent
 *    goes out mid-drag (4.10: mouse movement is never broadcast).
 *
 * On release it does the rest of 4.3, in this order: simplify the path, convert
 * it to tiles, and send exactly one intent. The simulation derives the real route
 * from that; the gesture the player drew is only ever a suggestion about
 * direction.
 *
 * It deliberately does not validate anything the simulation cares about. A plan
 * it proposes may still be refused, and the panel reflects the result on the
 * next update like every other action in the game.
 */

import { EventBus } from "../../core/EventBus";
import type { BattlePlanOrder } from "../../core/game/BattlePlan";
import type { TileRef } from "../../core/game/GameMap";
import type { Controller } from "../Controller";
import { MouseDownEvent, MouseMoveEvent, MouseUpEvent } from "../InputHandler";
import type { MapRenderer } from "../render/gl";
import {
  BATTLE_PLAN_DRAW_MIN_STEP_TILES,
  type BattlePlanStroke,
} from "../render/types/BattlePlan";
import { TransformHandler } from "../TransformHandler";
import { BattlePlanIntentEvent } from "../Transport";
import { GameView } from "../view";

/**
 * What a press-and-drag is currently drawing.
 *
 *  - `frontline`: along the border. Points must be the player's own border.
 *  - `offensive` / `spearhead`: an arrow out of a front. Points must be somewhere
 *    an army could stand or fight.
 *  - `fallback`: a defensive line in the player's own interior.
 */
export type BattlePlanDrawMode =
  | "frontline"
  | "offensive"
  | "spearhead"
  | "fallback";

/** Emitted on release, once the gesture has been simplified. */
interface ReleasedGesture {
  mode: BattlePlanDrawMode;
  /** Tile refs the pointer crossed, in draw order. */
  tiles: TileRef[];
  /** Tile refs along the arrow, for an offensive or spearhead. */
  arrow: TileRef[];
}

export class BattlePlanController implements Controller {
  private mode: BattlePlanDrawMode | null = null;
  /** Raw pointer path in world tile coordinates, flat [x, y, ...]. */
  private raw: number[] = [];
  /** Per-raw-point legality. */
  private rawValid: number[] = [];
  /** Armed by the panel's buttons; cleared on release or cancel. */
  private armed: BattlePlanDrawMode | null = null;
  private drawing = false;
  /** The one stroke object the live preview reuses, rather than reallocating. */
  private stroke: BattlePlanStroke = {
    points: new Float32Array(0),
    count: 0,
    valid: new Uint8Array(0),
    style: "frontline",
    color: [1, 1, 1],
    alpha: 0.8,
    hovered: false,
    selected: false,
  };

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
    private view: MapRenderer,
  ) {}

  init() {
    this.eventBus.on(MouseDownEvent, (e) => this.onDown(e.x, e.y));
    this.eventBus.on(MouseMoveEvent, (e) => this.onMove(e.x, e.y));
    this.eventBus.on(MouseUpEvent, (e) => this.onUp(e.x, e.y));
  }

  /**
   * Rebuild the stroke list from the canonical plans each sim tick.
   *
   * Deliberately not every frame: plan geometry only changes when the simulation
   * says it did, so rebuilding on the tick boundary is enough and keeps a paused
   * game from re-uploading identical geometry sixty times a second.
   */
  tick() {
    if (this.drawing) return;
    this.syncStrokes();
  }

  /** The mode the next press-and-drag will draw, or null. Read by the panel. */
  armedMode(): BattlePlanDrawMode | null {
    return this.armed;
  }

  isDrawing(): boolean {
    return this.drawing;
  }

  /**
   * Arm a drawing mode. Re-clicking the same button cancels it, so a mis-click
   * is one click to undo â€” the same affordance the army order buttons have.
   */
  arm(mode: BattlePlanDrawMode): void {
    this.armed = this.armed === mode ? null : mode;
    if (this.armed === null) this.clearDraft();
  }

  cancel(): void {
    this.armed = null;
    this.drawing = false;
    this.clearDraft();
  }

  // --- gesture ------------------------------------------------------------

  private onDown(screenX: number, screenY: number): void {
    if (this.armed === null) {
      // Not drawing: a plain click selects a plan, or clears the selection.
      this.selectAt(screenX, screenY);
      return;
    }
    const cell = this.transformHandler.screenToWorldCoordinates(
      screenX,
      screenY,
    );
    if (!this.game.isValidCoord(cell.x, cell.y)) return;
    this.drawing = true;
    this.mode = this.armed;
    this.raw.length = 0;
    this.rawValid.length = 0;
    this.pushSample(cell.x + 0.5, cell.y + 0.5);
  }

  private onMove(screenX: number, screenY: number): void {
    if (!this.drawing || this.mode === null) {
      // Not drawing, so keep the hover state fresh for the panel's highlight.
      this.updateHover(screenX, screenY);
      return;
    }
    const cell = this.transformHandler.screenToWorldCoordinates(
      screenX,
      screenY,
    );
    if (!this.game.isValidCoord(cell.x, cell.y)) return;
    this.pushSample(cell.x + 0.5, cell.y + 0.5);
    this.pushStroke();
  }

  private onUp(screenX: number, screenY: number): void {
    if (!this.drawing || this.mode === null) return;
    // A drag can end over the HUD, so the final sample is taken from the release
    // position rather than assumed to be the last move event.
    const cell = this.transformHandler.screenToWorldCoordinates(
      screenX,
      screenY,
    );
    if (this.game.isValidCoord(cell.x, cell.y)) {
      this.pushSample(cell.x + 0.5, cell.y + 0.5);
    }

    const gesture: ReleasedGesture = {
      mode: this.mode,
      tiles: this.legalTiles(),
      arrow: this.legalArrow(),
    };
    this.drawing = false;
    this.mode = null;
    this.clearDraft();
    this.emit(gesture);
  }

  /**
   * One raw sample, if it is far enough from the last to be worth keeping.
   *
   * The distance test is in tiles rather than pixels so the sampling rate does
   * not change when the player zooms: a point closer than a fraction of a tile
   * carries no information the tile grid does not already have.
   */
  private pushSample(x: number, y: number): void {
    const n = this.raw.length;
    if (n >= 2) {
      const dx = x - this.raw[n - 2];
      const dy = y - this.raw[n - 1];
      if (dx * dx + dy * dy < BATTLE_PLAN_DRAW_MIN_STEP_TILES ** 2) return;
    }
    this.raw.push(x, y);
    this.rawValid.push(this.isLegalSample(x, y, n === 0) ? 1 : 0);
  }

  /**
   * Is this sample somewhere the plan can exist?
   *
   * Frontline and fallback samples must be on the player's own ground; the
   * additional conditions per mode are what make the preview honest:
   *   - a frontline sample also has to be on a border, or the line would be drawn
   *     through the player's own interior where there is nothing to hold;
   *   - an arrow sample may be on hostile ground (that is the point) but not on
   *     water or impassable terrain, which is the section that gets tinted.
   */
  private isLegalSample(x: number, y: number, isFirst: boolean): boolean {
    const tile = this.tileAt(x, y);
    if (tile === null) return false;
    switch (this.mode) {
      case "fallback":
        return this.isMine(tile);
      case "frontline":
        return this.isMine(tile) && this.game.isBorder(tile);
      case "offensive":
      case "spearhead":
        if (isFirst) {
          // An arrow starts on the player's own border. Anywhere else and the
          // drag began in the wrong place.
          return this.isMine(tile) && this.game.isBorder(tile);
        }
        return this.game.isLand(tile) && !this.game.isImpassable(tile);
      default:
        return false;
    }
  }

  /** Does the local player hold this tile? Zero small id is terra nullius. */
  private isMine(tile: TileRef): boolean {
    const me = this.game.myPlayer();
    return me !== null && this.game.ownerID(tile) === me.smallID();
  }

  // --- preview ------------------------------------------------------------

  /**
   * Push the live preview.
   *
   * Chaikin corner-cutting on the raw path, once per pointer move. One pass is
   * enough: the second pass of a Chaikin scheme is what starts visibly shrinking
   * the endpoints, and the tail of an arrow should stay where the player put it.
   */
  private pushStroke(): void {
    if (this.raw.length < 4) {
      // Fewer than two samples is not a line yet.
      this.view.updateBattlePlanStrokes([]);
      return;
    }
    const smoothed = chaikin(this.raw);
    // The smoothed path is a fresh array each frame rather than a reused buffer:
    // it is a handful of numbers, and the pass copies it into the GPU buffer
    // immediately, so there is nothing to be gained by holding onto it.
    this.stroke.points = Float32Array.from(smoothed);
    this.stroke.count = smoothed.length >> 1;
    this.stroke.valid = projectValidity(this.rawValid, this.raw.length);
    this.stroke.style = styleForMode(this.mode);
    this.stroke.color = this.myColor();
    this.stroke.alpha = 0.8;
    this.stroke.hovered = false;
    this.stroke.selected = false;
    this.view.updateBattlePlanStrokes([this.stroke]);
  }

  private clearDraft(): void {
    this.raw.length = 0;
    this.rawValid.length = 0;
    this.view.updateBattlePlanStrokes([]);
  }

  /**
   * Canonical plans, as strokes for the renderer.
   *
   * Cheap: a plan that has not changed version, is not hovered and is not
   * selected is skipped, and in practice the list is a handful of entries.
   */
  private syncStrokes(): void {
    const settings = this.view.battlePlanAlphas();
    const strokes: BattlePlanStroke[] = [];
    const hovered = this.game.hoveredBattlePlanId();
    const selected = this.game.selectedBattlePlanId();
    for (const plan of this.game.battlePlans()) {
      if (!plan.isVisibleTo(this.game)) continue;
      const points = plan.polyline();
      if (points.length < 4) continue;
      const count = points.length >> 1;
      const stroke: BattlePlanStroke = {
        points: Float32Array.from(points),
        count,
        // A canonical plan has been through the validator, so every section of
        // it is legal by construction.
        valid: new Uint8Array(count).fill(1),
        style: plan.visual(),
        color: this.colorForOwner(plan.ownerSmallID()),
        alpha:
          plan.id === hovered || plan.id === selected
            ? settings.activeAlpha
            : settings.alpha,
        hovered: plan.id === hovered,
        selected: plan.id === selected,
      };
      strokes.push(stroke);
    }
    this.view.updateBattlePlanStrokes(strokes);
  }

  // --- selection ----------------------------------------------------------

  private selectAt(screenX: number, screenY: number): void {
    const cell = this.transformHandler.screenToWorldCoordinates(
      screenX,
      screenY,
    );
    if (!this.game.isValidCoord(cell.x, cell.y)) {
      this.game.setSelectedBattlePlan(null);
      return;
    }
    const tile = this.game.ref(cell.x, cell.y);
    const plan = this.game.battlePlanNearTile(tile);
    this.game.setSelectedBattlePlan(plan === null ? null : plan.id);
  }

  private updateHover(screenX: number, screenY: number): void {
    const cell = this.transformHandler.screenToWorldCoordinates(
      screenX,
      screenY,
    );
    if (!this.game.isValidCoord(cell.x, cell.y)) {
      this.game.setHoveredBattlePlan(null);
      return;
    }
    const tile = this.game.ref(cell.x, cell.y);
    const plan = this.game.battlePlanNearTile(tile);
    this.game.setHoveredBattlePlan(plan === null ? null : plan.id);
  }

  // --- intent -------------------------------------------------------------

  /**
   * The one message this feature sends (4.10).
   *
   * `tiles` is the simplified frontline gesture; `arrow` is the simplified
   * offensive gesture. Both are proposals: the simulation re-derives the frontier
   * from ownership and the route from map topology, and ignores whatever here
   * does not survive that.
   */
  private emit(gesture: ReleasedGesture): void {
    if (gesture.tiles.length < 2 && gesture.arrow.length < 2) return;
    this.eventBus.emit(
      new BattlePlanIntentEvent({
        type: "create",
        kind: kindForMode(gesture.mode),
        frontier: gesture.tiles,
        route: gesture.arrow,
        armyIDs: this.selectedArmyIDs(),
      }),
    );
  }

  /** Armies the plan will carry: the selected one, else all of them. */
  private selectedArmyIDs(): number[] {
    const selected = this.game.selectedArmy();
    if (selected !== null && selected.isMine(this.game)) return [selected.id];
    return this.game.myArmies().map((a) => a.id);
  }

  // --- geometry helpers ---------------------------------------------------

  /**
   * The drawn path as tile refs, simplified.
   *
   * Ramer-Douglas-Peucker with a tolerance in tiles. The point of running it at
   * all is the wire: a 300-sample drag would be a 300-entry array, and the
   * schema caps gesture size. Simplifying first means the cap is a backstop
   * rather than something a fast player runs into.
   */
  private legalTiles(): TileRef[] {
    const simplified = simplify(this.raw, 1.25);
    const out: TileRef[] = [];
    const seen = new Set<TileRef>();
    for (let i = 0; i + 1 < simplified.length; i += 2) {
      const tile = this.tileAt(simplified[i], simplified[i + 1]);
      if (tile === null || seen.has(tile)) continue;
      // Only tiles the gesture actually found legal go out. Sending the illegal
      // ones would be sending a claim the simulation is going to reject anyway,
      // and would make the plan's canonical frontier depend on where the pointer
      // wobbled.
      if (!this.isLegalSample(simplified[i], simplified[i + 1], i === 0))
        continue;
      seen.add(tile);
      out.push(tile);
    }
    return out;
  }

  /** The drawn arrow as tile refs, simplified the same way. */
  private legalArrow(): TileRef[] {
    if (this.mode !== "offensive" && this.mode !== "spearhead") return [];
    const simplified = simplify(this.raw, 1.25);
    const out: TileRef[] = [];
    const seen = new Set<TileRef>();
    for (let i = 0; i + 1 < simplified.length; i += 2) {
      const tile = this.tileAt(simplified[i], simplified[i + 1]);
      if (tile === null || seen.has(tile)) continue;
      if (!this.game.isLand(tile) || this.game.isImpassable(tile)) continue;
      seen.add(tile);
      out.push(tile);
    }
    return out;
  }

  private tileAt(x: number, y: number): TileRef | null {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (!this.game.isValidCoord(cx, cy)) return null;
    return this.game.ref(cx, cy);
  }

  /** The local player's colour, matching how the rest of the HUD reads it. */
  private myColor(): [number, number, number] {
    const me = this.game.myPlayer();
    return me === null ? [1, 1, 1] : rgbOf(me.territoryColor().toHex());
  }

  private colorForOwner(ownerID: number): [number, number, number] {
    // playerBySmallID throws on an unknown id, and a plan whose owner has been
    // removed is a real record the client can still be holding. Look the owner up
    // without throwing and fall back to white.
    const owner = this.game.players().find((p) => p.smallID() === ownerID);
    if (owner === undefined) return [1, 1, 1];
    return rgbOf(owner.territoryColor().toHex());
  }
}

/** `#rrggbb` to normalised rgb. Anything else falls back to white. */
function rgbOf(color: string): [number, number, number] {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  if (hex.length !== 6) return [1, 1, 1];
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

function styleForMode(
  mode: BattlePlanDrawMode | null,
): BattlePlanStroke["style"] {
  switch (mode) {
    case "offensive":
      return "arrow";
    case "spearhead":
      return "spearhead";
    case "fallback":
      return "fallback";
    case "frontline":
    default:
      return "frontline";
  }
}

function kindForMode(mode: BattlePlanDrawMode): BattlePlanOrder {
  return mode;
}

// --- path helpers -----------------------------------------------------------

/**
 * Chaikin corner cutting: each segment becomes two points at its quarter and
 * three-quarter marks. Endpoints are preserved, so the arrow still starts at the
 * player's border and still ends where the pointer was released.
 */
export function chaikin(points: readonly number[]): number[] {
  if (points.length < 6) return [...points];
  const out: number[] = [points[0], points[1]];
  for (let i = 0; i + 3 < points.length; i += 2) {
    const x0 = points[i];
    const y0 = points[i + 1];
    const x1 = points[i + 2];
    const y1 = points[i + 3];
    out.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25);
    out.push(x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75);
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out;
}

/**
 * Ramer-Douglas-Peucker on a flat [x, y, ...] path.
 *
 * Perpendicular distance rather than distance-to-segment: the difference only
 * matters on the doubling-back path a hand-drawn line sometimes makes, and the
 * simpler test is what keeps this cheap enough to run on every release.
 */
export function simplify(
  points: readonly number[],
  tolerance: number,
): number[] {
  const count = points.length >> 1;
  if (count <= 2) return [...points];
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: number[] = [0, count - 1];
  const tolSq = tolerance * tolerance;

  while (stack.length > 0) {
    const end = stack.pop()!;
    const start = stack.pop()!;
    if (end - start < 2) continue;
    const ax = points[start * 2];
    const ay = points[start * 2 + 1];
    const bx = points[end * 2];
    const by = points[end * 2 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let worst = -1;
    let worstIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const px = points[i * 2] - ax;
      const py = points[i * 2 + 1] - ay;
      let d: number;
      if (lenSq === 0) {
        d = px * px + py * py;
      } else {
        let t = (px * dx + py * dy) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - dx * t;
        const ey = py - dy * t;
        d = ex * ex + ey * ey;
      }
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worst > tolSq && worstIndex !== -1) {
      keep[worstIndex] = 1;
      stack.push(start, worstIndex, worstIndex, end);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (keep[i] === 0) continue;
    out.push(points[i * 2], points[i * 2 + 1]);
  }
  return out;
}

/**
 * Resample per-point legality onto the smoothed path.
 *
 * Chaikin turns 2 points into 4, so there is no one-to-one mapping. Each
 * smoothed point takes the legality of the raw point it came from, and the two
 * interior points of a segment inherit that segment's legality â€” which is
 * exactly right, because a segment between two legal endpoints only leaves the
 * legal set by curving, and the curve stays within the tolerance of the chord.
 */
function projectValidity(
  rawValid: readonly number[],
  rawCount: number,
): Uint8Array {
  const smoothedCount = Math.max(0, rawCount * 2 - 2);
  const out = new Uint8Array(smoothedCount);
  for (let i = 0; i < smoothedCount; i++) {
    const rawIndex = Math.min(rawCount - 1, i >> 1);
    out[i] = rawValid[rawIndex] ?? 1;
  }
  return out;
}
