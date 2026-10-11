// Air war tuning (Prompt 7).
//
// Separate from game/AirSuperiority.ts on purpose: that file is the *formula*
// — how power, superiority and losses relate to each other — and is pure with
// no tuning knobs of its own. This file is where the knobs live, in one place,
// so balance changes are one diff and the formula stays readable.
//
// Like ArmyBalance, integer-only and free of floats: every value here feeds
// arithmetic that has to be identical on every client.

/** Ticks between air-superiority resolutions. 10 ticks = 1 second. */
export const AIR_ENGAGEMENT_INTERVAL_TICKS = 10;

/** Ticks between a wing's replacement checks. Half the engagement cadence. */
export const AIR_REPLACEMENT_INTERVAL_TICKS = 5;

/**
 * Ticks an air wing that reached zero aircraft waits before disbanding, so a
 * wing that was wiped out mid-formation is not destroyed by a single bad
 * engagement when its factories are two seconds from a replacement.
 */
export const AIR_EMPTY_WING_GRACE_TICKS = 50;

/**
 * Experience per engagement wave fought, and per enemy aircraft destroyed.
 * Waves are the bigger number on purpose: a wing that keeps flying keeps
 * qualifying, so a long match rewards an established air arm over one that
 * shows up late.
 */
export const AIR_XP_PER_ENGAGEMENT = 12;
export const AIR_XP_PER_AIRCRAFT_DESTROYED = 20;

/** Experience per landed strike, and per point of damage it caused. */
export const AIR_XP_PER_STRIKE = 40;
export const AIR_XP_PER_DAMAGE = 1;

/**
 * Multiplier on a fighter wing's own effectiveness when it is the only thing
 * defending a region from bombers, to stop one patrol from being an absolute
 * wall.
 */
export const AIR_PATROL_ENGAGEMENT_BUDGET_PERCENT = 100;

/**
 * How much of a fighter wing's own aircraft it may engage per wave, as a
 * percentage. Below 100 so a wing cannot shoot down a numerically larger
 * opposing wing in one wave no matter how favourable the arithmetic is.
 */
export const AIR_ENGAGEMENT_BUDGET_PERCENT = 60;

/** Fraction (percent) of a wing's starting size below which it rebuilds. */
export const AIR_REBUILD_FLOOR_PERCENT = 25;

/**
 * Multiplier turning an aircraft count into the fighter damage a wing puts
 * into a region per engagement wave. Unused: the wave formula in
 * game/AirSuperiority.ts works in abstract damage points (airWaveDamage), which
 * is where this knob belongs if it ever needs one.
 */
export const AIR_FIGHTER_DAMAGE_PER_AIRCRAFT = 10;

/** Multiplier turning a bomber wing's aircraft into strike output. */
export const AIR_BOMBER_DAMAGE_PER_AIRCRAFT = 8;

/** Aircraft a bomber wing may commit to a single strike. */
export const AIR_MAX_STRIKE_AIRCRAFT = 12;

/**
 * Aircraft a bomber wing puts into one strike, before the cap above. A strike
 * is a sortie: a wing does not send everything it has to one target, which is
 * what stops one bomber from deleting an entire factory complex in a second.
 */
export const AIR_STRIKE_AIRCRAFT_PER_WAVE = 4;

/** Units the air region pass runs at. See execution/air/AirRegionExecution. */
export const AIR_WING_UPDATE_INTERVAL_TICKS = 2;

/** Helicopter tuning (Prompt 8). */
export const HELICOPTER_CAPACITY = 20;
/** Maximum army size a helicopter can airlift in one trip. */
export const HELICOPTER_LIFT_CAP = 50;
/** Ticks between airlift cooldowns. */
export const HELICOPTER_LIFT_COOLDOWN_TICKS = 100;
/** Helicopter operational range (map tiles). */
export const HELICOPTER_RANGE_TILES = 40;
/** Experience per airlift mission. */
export const HELICOPTER_XP_PER_LIFT = 5;
/** Ground support bonus percent from attached helicopter. */
export const HELICOPTER_GROUND_SUPPORT_BONUS = 15;
/** Maximum stacked ground support bonus (do not stack infinitely). */
export const HELICOPTER_GROUND_SUPPORT_MAX_STACK = 1;