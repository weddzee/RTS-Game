// Geometry the battle-plan renderer draws (Prompt 4.3).
//
// One type: a polyline with per-point validity. A frontline, an offensive arrow
// and a fallback line are all this shape — the difference is a style flag, not a
// different buffer layout, which is why one pass draws all of them.
//
// Coordinates are tile-space floats: tile (x, y)'s centre is (x + 0.5,
// y + 0.5). The pass adds the half-tile offset in the vertex shader, so a
// controller can hand over raw tile coordinates from `GameView.ref()` without
// thinking about it.

/**
 * How a stroke is drawn. Not decoration: each of these is one of the six order
 * types in 4.1, and the player has to be able to tell at a glance which they
 * drew.
 */
export type BattlePlanStrokeStyle =
  /** A front being held: solid serrated band, teeth facing the enemy. */
  | "frontline"
  /** An offensive arrow: dashed core with a solid arrow head. */
  | "arrow"
  /** A spearhead: same as arrow, drawn narrower so the commitment is legible. */
  | "spearhead"
  /** A defensive line the player draws in their own territory. */
  | "fallback"
  /** A drawn line with no fighting on it. */
  | "move";

export interface BattlePlanStroke {
  /** `[x, y]` per point, tile coordinates. Length is at least `count * 2`. */
  points: Float32Array;
  /** Valid point count; `points` may have spare capacity beyond it. */
  count: number;
  /**
   * One flag per point: 1 where the section is legal, 0 where it is not.
   *
   * Only the in-progress gesture sets any of these to 0 — a canonical plan has
   * already been through the validator, so everything in it is legal by
   * construction. Invalid sections are drawn in the invalid colour so the
   * player sees the crossing before letting go rather than after.
   */
  valid: Uint8Array;
  style: BattlePlanStrokeStyle;
  /** Owner colour, 0..1 rgb. */
  color: readonly [number, number, number];
  alpha: number;
  /** Drawn brighter and slightly thicker: the plan under the pointer. */
  hovered: boolean;
  /** The selected plan. Outranks `hovered` visually. */
  selected: boolean;
}

/** Fraction of the ribbon occupied by the solid core; the rest is outline. */
export const BATTLE_PLAN_CORE_FRACTION = 0.62;

/**
 * Screen-pixel half-widths, before the settings pass multiplies them. Kept here
 * so the controller's hit-testing can use the same number the renderer draws
 * with — a plan that cannot be clicked where it is visible is a bug the player
 * experiences as "the game ignored my click".
 */
export const BATTLE_PLAN_HIT_HALF_WIDTH_PX = 10;

/** How close, in tiles, a drawn point must be to the previous to be kept. */
export const BATTLE_PLAN_DRAW_MIN_STEP_TILES = 0.6;

/** How far the pointer may stray and still count as "on" the drawn line. */
export const BATTLE_PLAN_DRAW_SNAP_TILES = 1.5;

/**
 * How near a tile has to be to a drawn plan for a click to select it.
 *
 * Generous, because a plan is a long thin thing and the player is trying to grab
 * it, not pixel-hunt it. Measured on a plan's *canonical* geometry, which is
 * smoother and coarser than the gesture that drew it.
 */
export const BATTLE_PLAN_PICK_RADIUS_TILES = 3;
