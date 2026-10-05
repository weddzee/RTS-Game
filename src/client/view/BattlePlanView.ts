// BattlePlanView — the client-side read model for one drawn plan (Prompt 4).
//
// Like ArmyView, this holds one long-lived state object that GameView mutates in
// place from whole `BattlePlanUpdate` records, so the renderer can hold a
// reference and never be surprised by a swapped object.
//
// Tile refs are resolved to world tile coordinates on the way in, because that is
// what the renderer wants and doing it once per update beats having every
// consumer call `game.x(ref)` in a loop. The packing is `[x, y, x, y, ...]` in
// tile space, so tile (x, y)'s centre is at (x, y) and the pass adds the
// half-tile offset itself.
//
// One thing is deliberately *not* in here: the geometry the player is in the
// middle of drawing. That is cosmetic and stays local until they let go (4.10),
// so it lives in BattlePlanController. What arrives here is only ever the
// canonical geometry the simulation derived.

import type {
  BattlePlanOrder,
  BattlePlanStatus,
} from "../../core/game/BattlePlan";
import type { TileRef } from "../../core/game/GameMap";
import type { BattlePlanUpdate } from "../../core/game/GameUpdates";
import type { GameView } from "./GameView";

/** How a plan is drawn. One value per order type, so the two cannot disagree. */
export type BattlePlanVisual =
  | "frontline"
  | "arrow"
  | "spearhead"
  | "fallback"
  | "move";

export function visualForKind(kind: BattlePlanOrder): BattlePlanVisual {
  switch (kind) {
    case "offensive":
      return "arrow";
    case "spearhead":
      return "spearhead";
    case "fallback":
      return "fallback";
    case "move":
      return "move";
    case "frontline":
    case "hold":
      // `hold` draws as a front because holding a front is what it does; the
      // difference is that it is not pushing.
      return "frontline";
  }
}

export class BattlePlanView {
  public readonly id: number;
  public ownerID = 0;
  public kindValue: BattlePlanOrder = "frontline";
  public statusValue: BattlePlanStatus = "active";
  /** Canonical frontier, packed as world [x, y] tile coordinates. */
  public readonly frontier: number[] = [];
  /** Canonical arrow, packed the same way. */
  public readonly route: number[] = [];
  /** Drawn defensive line, packed the same way. */
  public readonly fallbackLine: number[] = [];
  public armyIDs: number[] = [];
  public step = 0;
  public createdAt = 0;
  public version = 0;

  constructor(id: number) {
    this.id = id;
  }

  /** Applies a complete plan record. Every field is always present. */
  applyUpdate(u: BattlePlanUpdate, game: GameView): void {
    this.ownerID = u.ownerID;
    this.kindValue = u.kind;
    this.statusValue = u.status;
    packTiles(this.frontier, u.frontier, game);
    packTiles(this.route, u.route, game);
    packTiles(this.fallbackLine, u.fallbackLine, game);
    this.armyIDs = [...u.armyIDs];
    this.step = u.step;
    this.createdAt = u.createdAt;
    this.version = u.version;
  }

  ownerSmallID(): number {
    return this.ownerID;
  }

  kind(): BattlePlanOrder {
    return this.kindValue;
  }

  status(): BattlePlanStatus {
    return this.statusValue;
  }

  visual(): BattlePlanVisual {
    return visualForKind(this.kindValue);
  }

  isRunning(): boolean {
    return this.statusValue === "active";
  }

  isMine(game: GameView): boolean {
    const me = game.myPlayer();
    return me !== null && this.ownerID === me.smallID();
  }

  /**
   * Whether this client draws the plan at all.
   *
   * The player's own plans and their allies' plans are shown; an enemy's is not.
   * Every plan is broadcast so every client agrees on the state, but broadcasting
   * is not the same as revealing — drawing an enemy's arrow would hand over
   * exactly the intelligence the game is about withholding.
   */
  isVisibleTo(game: GameView): boolean {
    if (this.isMine(game)) return true;
    return game.isAlliedWith(this.ownerID);
  }

  /**
   * The polyline this plan draws.
   *
   * An offensive's arrow already begins on the player's own border, so route and
   * frontier are one line as far as the renderer is concerned — a plan whose
   * destination turned out to be unreachable falls back to drawing the front on
   * its own, which is what it actually is.
   */
  polyline(): readonly number[] {
    switch (this.kindValue) {
      case "fallback":
        return this.fallbackLine.length > 1 ? this.fallbackLine : this.frontier;
      case "move":
        return this.route.length > 1 ? this.route : this.frontier;
      case "offensive":
      case "spearhead":
        return this.route.length > 1 ? this.route : this.frontier;
      case "frontline":
      case "hold":
        return this.frontier;
    }
  }

  /** Point count of `polyline()`. */
  pointCount(): number {
    return this.polyline().length >> 1;
  }

  /**
   * How far along the arrow this plan is, 0..1, or null when it has no arrow.
   * The renderer uses it to brighten the waypoint the plan is currently working
   * toward, which is the cheapest way to show a plan is progressing.
   */
  progress(): number | null {
    if (this.route.length < 2) return null;
    const points = this.route.length >> 1;
    return Math.min(1, this.step / (points - 1));
  }
}

/**
 * Rewrites `out` in place from a tile-ref list.
 *
 * In place because the renderer holds a reference to these arrays; allocating
 * new ones per update would leave a frame drawing the previous tick's arrow.
 */
function packTiles(
  out: number[],
  tiles: readonly TileRef[],
  game: GameView,
): void {
  let w = 0;
  for (const ref of tiles) {
    // An invalid ref is a broken record, not a crash: skip the point rather
    // than poisoning the whole polyline with a NaN that never renders.
    if (!game.isValidRef(ref)) continue;
    out[w++] = game.x(ref);
    out[w++] = game.y(ref);
  }
  out.length = w;
}
