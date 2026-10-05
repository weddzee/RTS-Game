// Battle-plan tuning (Prompt 4).
//
// Integer-only, like game/ArmyVeterancy.ts, so the engine and the renderer
// derive identical values and a plan resolves the same way on every client.
// Nothing here reads from game/: this is data, so it can be imported by the
// simulation, the tests and the renderer without an import cycle.
//
// The numbers are deliberately small and round. A battle plan is a *shorthand*
// for orders the player could have clicked one tile at a time, so the levers
// here are about how eagerly a plan commits troops, not about how strong they
// are.

// --- cadence ---------------------------------------------------------------

/**
 * Ticks between strategic re-evaluations of a plan.
 *
 * One second, matching ArmyExecution's movement interval: a plan and the army
 * it commands decide what to do at the same cadence, so an army never spends a
 * second marching on yesterday's order.
 */
export const BATTLE_PLAN_STRATEGY_INTERVAL_TICKS = 10;

/**
 * Ticks between whole-plan broadcasts. Matches the army cadence so a plan and
 * the armies on it reach clients in the same window.
 */
export const BATTLE_PLAN_UPDATE_INTERVAL_TICKS = 2;

// --- gesture limits (adversarial-input caps, also drawn on screen) ---------

/**
 * Most tiles a client may send for one drawn gesture.
 *
 * A drag across a 300-tile front is generous; a 3000-entry array is either a
 * bug or an attempt to make the validator's job expensive. Both are refused
 * before any map work happens.
 */
export const BATTLE_PLAN_MAX_FRONTIER_TILES = 512;

/** Most waypoints one drawn arrow may carry. See BATTLE_PLAN_MAX_FRONTIER_TILES. */
export const BATTLE_PLAN_MAX_ROUTE_STEPS = 64;

/**
 * Longest straight run a route may skip over, in tiles.
 *
 * Corners are always kept; this subdivides the straight runs between them so the
 * plan's waypoint cursor has something to advance through. Without it a plan drawn
 * across open ground would have a two-entry route — start and destination — and
 * would read as "one rush at the far end" instead of the step-by-step advance the
 * feature is for.
 */
export const BATTLE_PLAN_MAX_WAYPOINT_GAP_TILES = 6;

/** Most armies one plan may command. */
export const BATTLE_PLAN_MAX_ARMIES = 8;

/**
 * Shortest connected run of frontier tiles that counts as a drawn front.
 *
 * One tile is a click, not a line. Two is the smallest thing that can be
 * defended as a unit, so a two-tile gesture is accepted rather than rejected
 * for being technically a point.
 */
export const BATTLE_PLAN_MIN_FRONTIER_SEGMENT = 2;

/** Most plans one player may keep alive at once. */
export const BATTLE_PLAN_MAX_PER_PLAYER = 8;

// --- route derivation ------------------------------------------------------

/**
 * Step-cost multipliers by ownership, in tenths of a tile step.
 *
 * The route is an *offensive* route, so enemy ground is the cheapest thing to
 * walk through and friendly ground is expensive: the derived path pushes into
 * the drawn direction instead of looping back through the player's own
 * territory to reach a target that sits beside it.
 *
 * Multiplied by `GameMap.cost(tile)` (1 for open ground, 2 for rough), so the
 * whole search runs on integers.
 */
export const BATTLE_PLAN_ROUTE_COST_ENEMY = 20;
export const BATTLE_PLAN_ROUTE_COST_NEUTRAL = 30;
export const BATTLE_PLAN_ROUTE_COST_OWN = 80;

/**
 * Hard ceiling on route search expansion, in tiles.
 *
 * Derived once when a plan is drawn or redrawn rather than every step, and a
 * front is a local concern: if the drawn destination is further away than this
 * through passable land the plan falls back to holding the line it was given,
 * which is a worse outcome than a bounded search but never a hang.
 */
export const BATTLE_PLAN_ROUTE_SEARCH_LIMIT = 4096;

// --- target selection ------------------------------------------------------

/**
 * Alignment weight in the target score. Dominant by construction: the terrain
 * and front-width terms below cannot outweigh a ten-tile detour.
 *
 * All three are integers so the argmin is exact and reproducible.
 */
export const BATTLE_PLAN_ALIGNMENT_WEIGHT = 64;
/** Terrain magnitude penalty: rough ground is attacked last, at equal alignment. */
export const BATTLE_PLAN_TERRAIN_WEIGHT = 1;
/**
 * Front-width penalty. An offensive prefers the tile that opens the fewest
 * new tiles to defend; a spearhead weights this at zero (below).
 */
export const BATTLE_PLAN_FRONT_WIDTH_WEIGHT = 2;

/**
 * Half-width of a spearhead's lane, in tiles.
 *
 * A spearhead does not care about widening the front: it commits to the one
 * axis toward its destination. Two tiles either side is roughly one tile of
 * slack, which is narrower than an offensive's whole drawn front and therefore
 * easy to encircle from the flanks if the supporting front is not there — which
 * is what the army supply rules already punish.
 */
export const BATTLE_PLAN_SPEARHEAD_LANE_HALF_WIDTH = 2;

// --- fallback --------------------------------------------------------------

/**
 * Supply percent at or below which an army on an active fallback plan starts
 * walking back to the drawn line.
 *
 * Deliberately not "not sufficient": a strained army still has supply and can
 * still fight, and yanking it back the instant it leaves friendly ground would
 * make a fallback plan useless as the first thing you set up on a front. Cut is
 * where it goes; the band between is where the army decides.
 */
export const BATTLE_PLAN_FALLBACK_TRIGGER_SUPPLY = 50;
