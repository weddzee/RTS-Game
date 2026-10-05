// Turning a drawn gesture into validated map entities (Prompt 4.2, 4.4, 4.5).
//
// This is the boundary. A client draws a line across its border and an arrow
// into enemy ground; both arrive as a bag of tile refs, and a bag of tile refs
// is a *claim*, not a fact. Nothing here trusts the claim. Every tile is
// re-derived from map state:
//
//  - A frontier tile is kept only if the owner actually holds it *and* it
//    actually borders something the owner does not hold. A client cannot draw
//    a front through its own interior, and cannot claim a front in land it does
//    not own, because both fail the same two checks.
//  - A route is never taken from the drawn path. The drawn path is read only for
//    where the player was pointing; the route is then searched for over
//    passable land with integer step costs. A client that draws a path straight
//    across an ocean gets a plan that walks around the coast, and a client that
//    draws a path through a mountain gets a plan that goes over the pass.
//
// Determinism is the other constraint. Every ordering here is a total order over
// integer keys, so the same plan state plus the same map state produces the same
// plan on every client — the requirement in 4.11. Nothing here uses a random
// number generator and nothing uses floating point.

import {
  BATTLE_PLAN_ALIGNMENT_WEIGHT,
  BATTLE_PLAN_FRONT_WIDTH_WEIGHT,
  BATTLE_PLAN_MAX_FRONTIER_TILES,
  BATTLE_PLAN_MAX_ROUTE_STEPS,
  BATTLE_PLAN_MAX_WAYPOINT_GAP_TILES,
  BATTLE_PLAN_MIN_FRONTIER_SEGMENT,
  BATTLE_PLAN_ROUTE_COST_ENEMY,
  BATTLE_PLAN_ROUTE_COST_NEUTRAL,
  BATTLE_PLAN_ROUTE_COST_OWN,
  BATTLE_PLAN_ROUTE_SEARCH_LIMIT,
  BATTLE_PLAN_SPEARHEAD_LANE_HALF_WIDTH,
  BATTLE_PLAN_TERRAIN_WEIGHT,
} from "../configuration/BattlePlanBalance";
import type { BattlePlanOrder } from "./BattlePlan";
import type { Game, Player } from "./Game";
import type { TileRef } from "./GameMap";

/** Reusable 8-neighbor buffer; these functions run per tile. */
const AROUND: TileRef[] = new Array(8).fill(0) as TileRef[];

// --- frontier --------------------------------------------------------------

/**
 * Canonical frontier for a drawn frontline gesture.
 *
 * The proposal is filtered to tiles the owner holds that border ground they do
 * not, split into 8-connected runs, and the result is every run long enough to
 * be a line. Short runs are dropped rather than kept: a one-tile "front" is a
 * click, and rendering it as a front the player then has to defend is worse than
 * not drawing it at all.
 */
export function validateFrontier(
  mg: Game,
  owner: Player,
  proposed: readonly TileRef[],
): TileRef[] {
  const claimed: TileRef[] = [];
  for (const tile of proposed) {
    if (!mg.isValidRef(tile)) continue;
    if (mg.owner(tile) !== owner) continue;
    if (!mg.isBorder(tile)) continue;
    claimed.push(tile);
  }
  if (claimed.length === 0) return [];

  const runs = connectedRuns(mg.width(), claimed);
  const kept: TileRef[] = [];
  for (const run of runs) {
    if (run.tiles.length >= BATTLE_PLAN_MIN_FRONTIER_SEGMENT) {
      kept.push(...run.tiles);
    }
  }
  // Every run was a stray click: keep the largest so a one-tile front is still
  // expressible rather than silently discarded.
  if (kept.length === 0) kept.push(...runs[0].tiles);

  kept.sort((a, b) => a - b);
  return kept.slice(0, BATTLE_PLAN_MAX_FRONTIER_TILES);
}

/**
 * Canonical defensive line for a fallback gesture.
 *
 * The mirror image of validateFrontier: a fallback line is drawn *inside* the
 * player's own ground, so the filter is "a tile the owner holds" and nothing
 * else. No connectivity requirement — a player may want two separate lines to
 * fall back to.
 */
export function validateFallbackLine(
  mg: Game,
  owner: Player,
  proposed: readonly TileRef[],
): TileRef[] {
  const kept: TileRef[] = [];
  const seen = new Set<TileRef>();
  for (const tile of proposed) {
    if (seen.has(tile)) continue;
    if (!mg.isValidRef(tile)) continue;
    if (mg.owner(tile) !== owner) continue;
    seen.add(tile);
    kept.push(tile);
  }
  kept.sort((a, b) => a - b);
  return kept.slice(0, BATTLE_PLAN_MAX_FRONTIER_TILES);
}

// --- offensive route -------------------------------------------------------

/**
 * Canonical arrow: the ordered strategic waypoints for a drawn offensive.
 *
 * `hint` is the client's simplified and smoothed path. It is read for exactly
 * one thing — which tiles the player was pointing at — and even that is only a
 * hint about *direction*: the endpoint has to be a legal attackable tile the
 * frontier can actually reach to be adopted at all.
 *
 * Returns the waypoint chain, or an empty array when there is no reachable
 * destination. An empty route is not a failure: the plan degrades to manning the
 * frontier it was given, which is what a player who drew into the ocean meant by
 * accident and a perfectly good outcome to show them.
 */
export function deriveOffensiveRoute(
  mg: Game,
  owner: Player,
  frontier: readonly TileRef[],
  hint: readonly TileRef[],
): TileRef[] {
  if (frontier.length === 0) return [];
  const destination = chooseDestination(mg, owner, frontier, hint);
  if (destination === null) return [];

  const path = searchRoute(mg, owner, frontier, destination);
  if (path === null) return [];
  return toWaypoints(mg, path);
}

/**
 * The tile the drawn arrow was pointing at.
 *
 * Scans the hint from the tip backwards and adopts the first tile that could be
 * the end of a legal offensive: real, passable land, not already the owner's,
 * and reachable from the frontier. Scanning backwards matters — a drag's last
 * samples are where the player was actually pointing, and the first samples are
 * just where they started drawing, which is on top of their own territory.
 */
function chooseDestination(
  mg: Game,
  owner: Player,
  frontier: readonly TileRef[],
  hint: readonly TileRef[],
): TileRef | null {
  for (let i = hint.length - 1; i >= 0; i--) {
    const tile = hint[i];
    if (!mg.isValidRef(tile)) continue;
    if (!mg.isLand(tile) || mg.isImpassable(tile)) continue;
    if (mg.owner(tile) === owner) continue;
    if (!isReachableFrom(mg, frontier, tile)) continue;
    return tile;
  }
  return null;
}

/**
 * Bounded reachability sweep over passable land from the frontier.
 *
 * Exists to answer "could a legal route ever end here", so it is a plain BFS
 * with the search limit applied rather than a cost search: an unreachable
 * destination must be rejected before paying for the Dijkstra below.
 */
function isReachableFrom(
  mg: Game,
  frontier: readonly TileRef[],
  destination: TileRef,
): boolean {
  const seen = new Set<TileRef>();
  let open: TileRef[] = [];
  for (const tile of frontier) {
    if (!mg.isValidRef(tile)) continue;
    if (!mg.isLand(tile) || mg.isImpassable(tile)) continue;
    if (seen.has(tile)) continue;
    seen.add(tile);
    open.push(tile);
  }
  let expanded = 0;
  while (open.length > 0 && expanded < BATTLE_PLAN_ROUTE_SEARCH_LIMIT) {
    const next: TileRef[] = [];
    for (const tile of open) {
      if (tile === destination) return true;
      const count = mg.neighbors8(tile, AROUND);
      for (let i = 0; i < count; i++) {
        const n = AROUND[i];
        if (seen.has(n)) continue;
        if (!mg.isLand(n) || mg.isImpassable(n)) continue;
        seen.add(n);
        next.push(n);
        expanded++;
      }
    }
    open = next;
  }
  return false;
}

/**
 * Integer-cost Dijkstra from the frontier to the destination.
 *
 * Costs are `ownership multiplier × GameMap.cost(tile)`, all integers (see
 * BattlePlanBalance). Ties are broken by tile ref: the queue key packs cost and
 * ref into one number, so the heap's natural numeric order *is* the (cost, ref)
 * order. The shortest path found is therefore a function of the map alone, not
 * of insertion order.
 *
 * Water and impassable terrain are not nodes at all. That is the whole of the
 * "naval restrictions" in 4.4: there is no boat branch here, so a plan simply
 * cannot route across a strait. An army that wanted one uses a boat, and a boat
 * is not a battle plan.
 */
function searchRoute(
  mg: Game,
  owner: Player,
  frontier: readonly TileRef[],
  destination: TileRef,
): TileRef[] | null {
  const tileCount = mg.width() * mg.height();
  // key = cost * keyStride + ref, so the heap's numeric order is exactly
  // (cost, ref): a total order over the map alone, with the tie-break built in.
  // Cost is bounded by the search limit times the most expensive step, so the
  // largest key stays far below 2^53 and both the multiply and the `% keyStride`
  // that recovers the ref are exact.
  const keyStride = tileCount + 1;

  const cost = new Float64Array(tileCount).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(tileCount).fill(-1);
  const closed = new Uint8Array(tileCount);

  const queue = new IntHeap();
  for (const tile of frontier) {
    if (!mg.isValidRef(tile)) continue;
    if (!mg.isLand(tile) || mg.isImpassable(tile)) continue;
    cost[tile] = 0;
    queue.push(tile);
  }

  let expanded = 0;
  let found = false;
  while (queue.size > 0 && expanded < BATTLE_PLAN_ROUTE_SEARCH_LIMIT) {
    const key = queue.pop();
    const current = key % keyStride;
    if (closed[current] === 1) continue;
    closed[current] = 1;
    expanded++;
    if (current === destination) {
      found = true;
      break;
    }

    const base = cost[current];
    const count = mg.neighbors8(current, AROUND);
    for (let i = 0; i < count; i++) {
      const n = AROUND[i];
      if (closed[n] === 1) continue;
      if (!mg.isLand(n) || mg.isImpassable(n)) continue;
      const next = base + stepCost(mg, owner, n);
      if (next < cost[n]) {
        cost[n] = next;
        cameFrom[n] = current;
        queue.push(next * keyStride + n);
      }
    }
  }
  if (!found) return null;

  const path: TileRef[] = [];
  let walk = destination;
  while (walk !== -1) {
    path.push(walk);
    walk = cameFrom[walk];
  }
  path.reverse();
  return path;
}

/** Per-step cost in tenths of a tile, by who holds the tile. */
function stepCost(mg: Game, owner: Player, tile: TileRef): number {
  const holder = mg.owner(tile);
  const multiplier =
    holder === owner
      ? BATTLE_PLAN_ROUTE_COST_OWN
      : holder.isPlayer()
        ? BATTLE_PLAN_ROUTE_COST_ENEMY
        : BATTLE_PLAN_ROUTE_COST_NEUTRAL;
  return multiplier * mg.cost(tile);
}

/**
 * Compress a full search path into the strategic waypoints an army steps to.
 *
 * Every corner is kept, because a corner is where the drawn arrow changed its
 * mind and losing it would redraw the plan as something the player did not ask
 * for. Straight runs between corners are subdivided so no waypoint gap exceeds
 * `BATTLE_PLAN_MAX_WAYPOINT_GAP_TILES`, which is what gives the plan a waypoint
 * cursor worth advancing.
 *
 * If the result is still over the cap, it is thinned evenly — but the first and
 * last entries always survive, so the route still starts at the front and still
 * ends at the drawn destination.
 */
function toWaypoints(mg: Game, path: readonly TileRef[]): TileRef[] {
  if (path.length <= 2) return [...path];
  const out: TileRef[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    out.push(path[i]);
    const here = path[i];
    const next = path[i + 1];
    const incoming = direction(mg, path[Math.max(0, i - 1)], here);
    const outgoing = direction(mg, here, next);
    // Only subdivide a run that is going straight and long enough to matter.
    if (incoming === outgoing) {
      const run = Math.max(
        Math.abs(mg.x(next) - mg.x(here)),
        Math.abs(mg.y(next) - mg.y(here)),
      );
      if (run > BATTLE_PLAN_MAX_WAYPOINT_GAP_TILES) {
        for (let s = 1; s < run; s++) {
          out.push(interpolate(mg, here, next, s, run));
        }
      }
    }
  }
  out.push(path[path.length - 1]);

  if (out.length <= BATTLE_PLAN_MAX_ROUTE_STEPS) return out;
  const thinned: TileRef[] = [];
  const stride = (out.length - 1) / (BATTLE_PLAN_MAX_ROUTE_STEPS - 1);
  for (let i = 0; i < BATTLE_PLAN_MAX_ROUTE_STEPS; i++) {
    thinned.push(out[Math.round(i * stride)]);
  }
  thinned[BATTLE_PLAN_MAX_ROUTE_STEPS - 1] = out[out.length - 1];
  return thinned;
}

/**
 * The tile `part` of the way in `parts` between two tiles, walked along the
 * straight line between them.
 *
 * Rounded, so consecutive interpolated tiles are always exactly one 8-neighbour
 * step apart and the waypoint chain stays walkable end to end.
 */
function interpolate(
  mg: Game,
  from: TileRef,
  to: TileRef,
  part: number,
  parts: number,
): TileRef {
  const x = mg.x(from) + ((mg.x(to) - mg.x(from)) * part) / parts;
  const y = mg.y(from) + ((mg.y(to) - mg.y(from)) * part) / parts;
  return mg.ref(Math.round(x), Math.round(y));
}

/** Quantised step direction, so "same direction" is an exact integer compare. */
function direction(mg: Game, from: TileRef, to: TileRef): number {
  const dx = sign(mg.x(to) - mg.x(from));
  const dy = sign(mg.y(to) - mg.y(from));
  return (dy + 1) * 3 + (dx + 1);
}

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

// --- progressive target selection -----------------------------------------

/**
 * The tile the plan attacks next.
 *
 * Never a tile from the drawn arrow and never a distant coordinate: candidates
 * are only the hostile and unowned tiles touching the plan's *live* frontier, so
 * an army is always attacking something it is standing next to and can never
 * teleport. Among those it takes the one best aligned with the current waypoint,
 * which is how the plan is "near the desired path" without ever being it.
 *
 * All three score terms are integers and the comparison is a strict `<` over
 * candidates visited in ascending ref order, so the winner is a total order over
 * the map state — deterministic, and identical on every client.
 */
export function chooseAttackTarget(
  mg: Game,
  owner: Player,
  kind: BattlePlanOrder,
  frontier: readonly TileRef[],
  waypoint: TileRef | null,
): TileRef | null {
  const live = liveFrontier(mg, owner, frontier);
  if (live.length === 0) return null;

  const candidates = hostileAdjacent(mg, owner, live);
  if (candidates.length === 0) return null;

  // A spearhead commits to one axis; an offensive may widen. See
  // BattlePlanBalance for why narrower is also riskier.
  const pool =
    kind === "spearhead" && waypoint !== null
      ? laneCandidates(mg, candidates, live, waypoint)
      : candidates;
  const usable = pool.length > 0 ? pool : candidates;

  let best: TileRef | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const tile of usable) {
    const frontSpan = countNewlyExposedFront(mg, owner, tile);
    const score =
      waypoint === null
        ? frontSpan * BATTLE_PLAN_FRONT_WIDTH_WEIGHT
        : mg.manhattanDist(tile, waypoint) * BATTLE_PLAN_ALIGNMENT_WEIGHT +
          mg.magnitude(tile) * BATTLE_PLAN_TERRAIN_WEIGHT +
          frontSpan * BATTLE_PLAN_FRONT_WIDTH_WEIGHT;
    if (score < bestScore) {
      bestScore = score;
      best = tile;
    }
  }
  return best;
}

/**
 * The plan's frontier as it stands *now*.
 *
 * A frontline is drawn once and then follows the territory it was drawn on, so a
 * tile the player has since lost, or that is no longer on any border, leaves the
 * front. This is what "update line after territory changes" means in 4.5, and it
 * is also what stops a plan from ordering attacks at ground it no longer
 * touches.
 */
export function liveFrontier(
  mg: Game,
  owner: Player,
  frontier: readonly TileRef[],
): TileRef[] {
  const out: TileRef[] = [];
  for (const tile of frontier) {
    if (!mg.isValidRef(tile)) continue;
    if (mg.owner(tile) !== owner) continue;
    if (!mg.isBorder(tile)) continue;
    out.push(tile);
  }
  return out;
}

/** Hostile or unowned tiles touching any tile of the frontier. */
export function hostileAdjacent(
  mg: Game,
  owner: Player,
  frontier: readonly TileRef[],
): TileRef[] {
  const out: TileRef[] = [];
  const seen = new Set<TileRef>();
  for (const tile of frontier) {
    const count = mg.neighbors8(tile, AROUND);
    for (let i = 0; i < count; i++) {
      const n = AROUND[i];
      if (seen.has(n)) continue;
      if (!mg.isLand(n) || mg.isImpassable(n)) continue;
      if (mg.owner(n) === owner) continue;
      seen.add(n);
      out.push(n);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Narrow a candidate set to the tiles within the spearhead's lane width of the
 * straight axis from the front toward the waypoint.
 *
 * Integer cross-product distance rather than a normalised one, so "is this tile
 * in the lane" is exact. Perpendicular distance in tiles is `|cross| / |axis|`,
 * so comparing `cross²` against `(halfWidth × |axis|)²` is the same test with no
 * division and no rounding.
 */
function laneCandidates(
  mg: Game,
  candidates: readonly TileRef[],
  frontier: readonly TileRef[],
  waypoint: TileRef,
): TileRef[] {
  const origin = centroid(mg, frontier);
  const ax = mg.x(waypoint) - origin.x;
  const ay = mg.y(waypoint) - origin.y;
  const axisLenSq = ax * ax + ay * ay;
  if (axisLenSq === 0) return [...candidates];

  const bound =
    BATTLE_PLAN_SPEARHEAD_LANE_HALF_WIDTH *
    BATTLE_PLAN_SPEARHEAD_LANE_HALF_WIDTH *
    axisLenSq;
  const out: TileRef[] = [];
  for (const tile of candidates) {
    const px = mg.x(tile) - origin.x;
    const py = mg.y(tile) - origin.y;
    const cross = px * ay - py * ax;
    if (cross * cross <= bound) out.push(tile);
  }
  return out;
}

/** Integer tile-space centroid, floored. Only used to place a lane axis. */
function centroid(
  mg: Game,
  tiles: readonly TileRef[],
): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  for (const tile of tiles) {
    sx += mg.x(tile);
    sy += mg.y(tile);
  }
  return { x: Math.floor(sx / tiles.length), y: Math.floor(sy / tiles.length) };
}

/**
 * How many tiles taking `tile` would newly expose to the enemy.
 *
 * An offensive prefers the target that opens the fewest new tiles to defend; a
 * spearhead weights this to nothing. Counted by how many of the target's
 * neighbours are neither held nor already on the frontier, which is the same
 * thing the frontier is about.
 */
function countNewlyExposedFront(
  mg: Game,
  owner: Player,
  tile: TileRef,
): number {
  let exposed = 0;
  const count = mg.neighbors8(tile, AROUND);
  for (let i = 0; i < count; i++) {
    const n = AROUND[i];
    if (mg.owner(n) === owner) continue;
    if (!mg.isBorder(n)) continue;
    exposed++;
  }
  return exposed;
}

// --- connectivity ----------------------------------------------------------

interface Run {
  tiles: TileRef[];
  /** Lowest ref in the run; the deterministic ordering key. */
  lowest: TileRef;
}

/**
 * 8-connected components of a tile set, ordered by lowest ref.
 *
 * Takes the map width rather than reading a module-level variable: several games
 * can be live in the same worker over the course of a session, and a width left
 * over from the last one would silently weld the two ends of this map together.
 */
export function connectedRuns(width: number, tiles: readonly TileRef[]): Run[] {
  const remaining = new Set<TileRef>(tiles);
  const runs: Run[] = [];
  while (remaining.size > 0) {
    // Deterministic seed choice: always the lowest ref still unvisited.
    let seed = Number.MAX_SAFE_INTEGER;
    for (const tile of remaining) {
      if (tile < seed) seed = tile;
    }
    const component: TileRef[] = [];
    const stack: TileRef[] = [seed];
    remaining.delete(seed);
    while (stack.length > 0) {
      const tile = stack.pop()!;
      component.push(tile);
      const count = neighbors8Raw(width, tile, AROUND);
      for (let i = 0; i < count; i++) {
        const n = AROUND[i];
        if (!remaining.has(n)) continue;
        remaining.delete(n);
        stack.push(n);
      }
    }
    component.sort((a, b) => a - b);
    runs.push({ tiles: component, lowest: component[0] });
  }
  runs.sort((a, b) => a.lowest - b.lowest);
  return runs;
}

/**
 * 8-neighbours by raw ref arithmetic. Ref layout is `ref = y * width + x`, so
 * the diagonals are fixed offsets from the width.
 */
function neighbors8Raw(width: number, tile: TileRef, out: TileRef[]): number {
  const row = Math.floor(tile / width);
  const col = tile - row * width;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const targetRow = row + dy;
    if (targetRow < 0) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const targetCol = col + dx;
      // Horizontal wrap guard: stepping off either end of a row would weld the
      // map's left and right edges together.
      if (targetCol < 0 || targetCol >= width) continue;
      out[n++] = targetRow * width + targetCol;
    }
  }
  return n;
}

/** A min-heap of packed keys. Order is the key, which is the whole point. */
export class IntHeap {
  private items: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(key: number): void {
    const items = this.items;
    items.push(key);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent] <= items[i]) break;
      const swap = items[parent];
      items[parent] = items[i];
      items[i] = swap;
      i = parent;
    }
  }

  pop(): number {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      while (true) {
        const left = (i << 1) + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child =
          right < items.length && items[right] < items[left] ? right : left;
        if (items[i] <= items[child]) break;
        const swap = items[child];
        items[child] = items[i];
        items[i] = swap;
        i = child;
      }
    }
    return top;
  }
}
