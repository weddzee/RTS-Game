// Air regions (Prompt 7.4).
//
// The spec's hard requirement is that aircraft must NOT need continuous
// pathfinding across every map pixel, and that if the map has no region data we
// create "a lightweight region assignment mechanism". This is that mechanism,
// and it is deliberately the lightest thing that works:
//
//   The map is cut into a fixed grid of rectangular sectors. That is the whole
//   partition. No flood fill, no connected components, no per-tile storage, no
//   allocation per tile, no pathfinding at all.
//
// Why a grid is the right answer here rather than something cleverer:
//
//   - A wing is a *count*, not a position. It never has to travel to its target,
//     so the only thing a region has to answer is "which bucket is this tile
//     in", and that is one multiply and a mask.
//   - Air regions are a commander's abstraction over a huge map, not a
//     geographic fact. A rectangular sector is exactly what an air command
//     would call a sector, and it is what the overlay draws.
//   - It is identical on every client by construction: it is derived from the
//     map dimensions, which are part of the game start info.
//
// Everything is integer arithmetic on tile coordinates, so the sim stays
// deterministic with no floating point anywhere.

import type { GameMap } from "./GameMap";
import type { TileRef } from "./GameMap";

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Roughly how many tiles an air region should cover. Chosen so a Standard map
 * lands in the low tens of regions: few enough that a wing's effect is local
 * and meaningful, many enough that the map is not one blob.
 */
export const AIR_REGION_TARGET_TILES = 4096;

/** Never fewer than this on an axis, so a sliver map is not one thin column. */
const MIN_AXIS_REGIONS = 1;

/** Upper bound on regions per axis, so a pathological map cannot explode. */
export const MAX_AXIS_REGIONS = 32;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * Excel-style column letters: A..Z, then AA, AB, ... so a 32-wide grid stays
 * readable ("AA7" rather than "column 27, row 7"). Unbounded by design — the
 * axis cap means it never runs past "AF".
 */
export function airRegionColumnLabel(column: number): string {
  let n = column + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

// ---------------------------------------------------------------------------
// The partition
// ---------------------------------------------------------------------------

export interface AirRegionLayout {
  /** Regions per row. */
  cols: number;
  /** Regions per column. */
  rows: number;
  /** Tile width of one region. */
  regionWidth: number;
  /** Tile height of one region. */
  regionHeight: number;
  /** Total regions, `cols * rows`. */
  count: number;
}

/**
 * The partition for a map of this size. Pure, so both sides derive the same one.
 *
 * Squares the map first (so a 4:1 map does not get four times as many regions
 * as it needs), then rounds the column count and derives the row count from it,
 * which guarantees every cell has the same width and the whole map is covered
 * exactly — no partial edge regions, no gaps.
 */
export function airRegionLayoutFor(
  mapWidth: number,
  mapHeight: number,
): AirRegionLayout {
  const width = Math.max(1, Math.floor(mapWidth));
  const height = Math.max(1, Math.floor(mapHeight));
  const aspect = width / height;
  let cols = Math.round(Math.sqrt((width * height) / AIR_REGION_TARGET_TILES) * aspect);
  let rows = Math.round((width * height) / (AIR_REGION_TARGET_TILES * cols));
  cols = clampAxis(cols);
  rows = clampAxis(rows);
  return {
    cols,
    rows,
    regionWidth: Math.ceil(width / cols),
    regionHeight: Math.ceil(height / rows),
    count: cols * rows,
  };
}

function clampAxis(n: number): number {
  if (!Number.isFinite(n)) return MIN_AXIS_REGIONS;
  return Math.min(MAX_AXIS_REGIONS, Math.max(MIN_AXIS_REGIONS, Math.floor(n)));
}

export function isValidAirRegionId(
  layout: AirRegionLayout,
  id: unknown,
): id is number {
  return (
    typeof id === "number" &&
    Number.isInteger(id) &&
    id >= 0 &&
    id < layout.count
  );
}

/**
 * The region containing a tile coordinate, or -1 for a coordinate off the map.
 *
 * Clamps rather than rejecting the edge: a region must always be able to name
 * its own rectangle, and the last row/column is clipped to the map's real
 * extent. Callers that pass a validated TileRef never hit the -1.
 */
export function airRegionIndexAt(
  layout: AirRegionLayout,
  x: number,
  y: number,
): number {
  const col = Math.min(
    layout.cols - 1,
    Math.max(0, Math.floor(x / layout.regionWidth)),
  );
  const row = Math.min(
    layout.rows - 1,
    Math.max(0, Math.floor(y / layout.regionHeight)),
  );
  return row * layout.cols + col;
}

/** Tile rectangle a region covers, clipped to the map. */
export function airRegionBounds(
  layout: AirRegionLayout,
  id: number,
): { x: number; y: number; width: number; height: number } {
  const col = id % layout.cols;
  const row = Math.floor(id / layout.cols);
  const x = col * layout.regionWidth;
  const y = row * layout.regionHeight;
  return {
    x,
    y,
    width: Math.min(layout.regionWidth, layout.cols * layout.regionWidth - x),
    height: Math.min(
      layout.regionHeight,
      layout.rows * layout.regionHeight - y,
    ),
  };
}

/** Centre of a region in tile coordinates — what the overlay draws its label at. */
export function airRegionCenter(
  layout: AirRegionLayout,
  id: number,
): { x: number; y: number } {
  const b = airRegionBounds(layout, id);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Human label for a region, e.g. "C7". Stable for a given layout. */
export function airRegionLabel(layout: AirRegionLayout, id: number): string {
  const col = id % layout.cols;
  const row = Math.floor(id / layout.cols);
  return `${airRegionColumnLabel(col)}${row + 1}`;
}

// ---------------------------------------------------------------------------
// The map-bound helper
// ---------------------------------------------------------------------------

/**
 * A region lookup bound to one map, so callers do not pass a layout around.
 *
 * `Game` builds one of these once at construction and hands it to the air
 * executions, the panel and the map overlay. It holds no per-tile state, so it
 * needs no snapshot: the layout is a pure function of the map dimensions, which
 * are already part of the game start info every client has.
 */
export class AirRegions {
  readonly layout: AirRegionLayout;

  constructor(private map: GameMap) {
    this.layout = airRegionLayoutFor(map.width(), map.height());
  }

  get count(): number {
    return this.layout.count;
  }

  /** Region containing a TileRef, or -1 if the tile is off the map. */
  at(tile: TileRef): number {
    if (!this.map.isValidRef(tile)) return -1;
    return airRegionIndexAt(
      this.layout,
      this.map.x(tile),
      this.map.y(tile),
    );
  }

  /** Region containing a coordinate, or -1 if it is off the map. */
  atCoord(x: number, y: number): number {
    return airRegionIndexAt(this.layout, x, y);
  }

  bounds(id: number): { x: number; y: number; width: number; height: number } {
    return airRegionBounds(this.layout, id);
  }

  center(id: number): { x: number; y: number } {
    return airRegionCenter(this.layout, id);
  }

  label(id: number): string {
    return airRegionLabel(this.layout, id);
  }

  /** True when `id` names a real region of this map. */
  isValid(id: unknown): id is number {
    return isValidAirRegionId(this.layout, id);
  }
}