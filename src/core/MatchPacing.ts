// Match pacing presets for the private-lobby build (Prompt 1).
//
// One centralized table maps a duration preset to every pacing knob the
// game tunes per match: resource generation, construction speed, unit
// movement, troop generation, XP gain and late-game unlock timing.
//
// Nothing here touches the simulation directly. The preset is selected in
// the private-lobby menu, converted to a GameConfig patch by
// matchPacingGameConfigPatch() (maxTimerValue + goldMultiplier — fields the
// wire schema and WinCheckExecution already understand), and stored on the
// room record. The remaining multipliers are authoritative documentation
// for the systems that will consume them in later phases; they must NOT be
// re-implemented as scattered constants elsewhere.

export type MatchPacingPreset = "rapid" | "standard" | "extended" | "sandbox";

export const MATCH_PACING_PRESETS: readonly MatchPacingPreset[] = [
  "rapid",
  "standard",
  "extended",
  "sandbox",
];

export interface MatchPacingConfig {
  preset: MatchPacingPreset;
  /** Match length in minutes. null = unlimited (sandbox). */
  durationMinutes: number | null;
  /** Scales gold and resource generation. */
  resourceMultiplier: number;
  /** Scales construction speed. */
  constructionSpeedMultiplier: number;
  /** Scales unit movement speed. */
  movementSpeedMultiplier: number;
  /** Scales troop generation. */
  troopGenerationMultiplier: number;
  /** Scales XP gain. */
  xpGainMultiplier: number;
  /** Minute mark when late-game unlocks become available. null = never. */
  lateGameUnlockAtMinutes: number | null;
}

export const MATCH_PACING_CONFIGS: Record<
  MatchPacingPreset,
  MatchPacingConfig
> = {
  rapid: {
    preset: "rapid",
    durationMinutes: 10,
    resourceMultiplier: 1.5,
    constructionSpeedMultiplier: 1.5,
    movementSpeedMultiplier: 1.0,
    troopGenerationMultiplier: 1.5,
    xpGainMultiplier: 1.5,
    lateGameUnlockAtMinutes: 6,
  },
  standard: {
    preset: "standard",
    durationMinutes: 15,
    resourceMultiplier: 1.0,
    constructionSpeedMultiplier: 1.0,
    movementSpeedMultiplier: 1.0,
    troopGenerationMultiplier: 1.0,
    xpGainMultiplier: 1.0,
    lateGameUnlockAtMinutes: 10,
  },
  extended: {
    preset: "extended",
    durationMinutes: 20,
    resourceMultiplier: 0.85,
    constructionSpeedMultiplier: 0.9,
    movementSpeedMultiplier: 1.0,
    troopGenerationMultiplier: 0.9,
    // 20 minutes of play produces far more XP opportunity than 15, so XP is
    // paid out more slowly: levels stay spread across the whole match instead
    // of maxing out in the first two thirds. Consumed by Config.xpPacingPercent.
    xpGainMultiplier: 0.9,
    lateGameUnlockAtMinutes: 14,
  },
  sandbox: {
    preset: "sandbox",
    durationMinutes: null,
    resourceMultiplier: 1.0,
    constructionSpeedMultiplier: 1.0,
    movementSpeedMultiplier: 1.0,
    troopGenerationMultiplier: 1.0,
    xpGainMultiplier: 1.0,
    lateGameUnlockAtMinutes: null,
  },
};

export function isMatchPacingPreset(
  value: unknown,
): value is MatchPacingPreset {
  return (
    typeof value === "string" &&
    (MATCH_PACING_PRESETS as readonly string[]).includes(value)
  );
}

/** Unknown/missing presets fall back to standard — never throw on UI input. */
export function matchPacingConfigFor(preset: unknown): MatchPacingConfig {
  if (isMatchPacingPreset(preset)) return MATCH_PACING_CONFIGS[preset];
  return MATCH_PACING_CONFIGS.standard;
}

export interface MatchPacingGameConfigPatch {
  /** Minutes; null = unlimited (sandbox). Mirrors GameConfig.maxTimerValue. */
  maxTimerValue: number | null;
  /** Wired today into GameConfig.goldMultiplier. */
  goldMultiplier: number;
}

/**
 * The portion of a pacing preset the current GameConfig schema can carry.
 * The remaining multipliers have no schema fields; they are recorded on the
 * room and documented here, and each system that needs one reads it from
 * MATCH_PACING_CONFIGS rather than re-deriving it (Config.xpPacingPercent
 * consumes xpGainMultiplier this way).
 */
export function matchPacingGameConfigPatch(
  preset: unknown,
): MatchPacingGameConfigPatch {
  const config = matchPacingConfigFor(preset);
  return {
    maxTimerValue: config.durationMinutes,
    goldMultiplier: config.resourceMultiplier,
  };
}

/**
 * The preset a match duration corresponds to, given the wire-carried
 * GameConfig.maxTimerValue (minutes, null = unlimited).
 *
 * This is the bridge from what the wire carries to the preset tables above:
 * the sim only ever sees `maxTimerValue`, so every multiplier that is not a
 * schema field is resolved through here. A custom duration has no preset and
 * falls back to standard.
 */
export function matchPacingPresetForDuration(
  minutes: number | null | undefined,
): MatchPacingPreset {
  for (const preset of MATCH_PACING_PRESETS) {
    if (MATCH_PACING_CONFIGS[preset].durationMinutes === minutes) return preset;
  }
  return "standard";
}

/** XP gain for a match duration as an integer percent (100 = Standard). */
export function matchPacingXpPercent(
  minutes: number | null | undefined,
): number {
  const config = MATCH_PACING_CONFIGS[matchPacingPresetForDuration(minutes)];
  return Math.round(config.xpGainMultiplier * 100);
}
