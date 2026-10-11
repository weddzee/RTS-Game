// Clean rules interface over the existing victory logic (Prompt 2.2).
//
// The simulation keeps its compatible behavior (territorial dominance at
// the configured share, lobby-timer and hard-limit timer wins); this
// module names the rules so pacing, tests and future modes share one
// vocabulary. Last-player/team-standing lives in the execution layer
// (WinCheckExecution ranked branches), which also delegates its share and
// timer predicates here.
//
// The required share is configurable per rules instance: WinCheck passes
// no override (the lobby threshold + overtime applies); tests and future
// modes pass an explicit percentage.

import type { Config } from "./configuration/Config";

export interface VictoryRules {
  /** Required land share (whole percent) at this match moment. */
  requiredSharePercent(elapsedSeconds: number): number;
  /** Territorial dominance: strictly more than the required share of
   * non-fallout land. Exact integer math, mirroring the execution. */
  hasTerritorialWin(
    tilesOwned: number,
    landTiles: number,
    falloutTiles: number,
    requiredPercent: number,
  ): boolean;
  /** Lobby timer elapsed, or the hard limit reached. */
  hasTimerWin(
    elapsedSeconds: number,
    maxTimerValue: number | null | undefined,
  ): boolean;
}

export class StandardVictoryRules implements VictoryRules {
  // Hard time limit (in seconds) to force a winner before the server's
  // maxGameDuration hard kill. 170mins (10 mins before 3hrs).
  static readonly HARD_TIME_LIMIT_SECONDS = 170 * 60;

  constructor(
    private readonly config: Config,
    private readonly overrideSharePercent?: number,
  ) {}

  requiredSharePercent(elapsedSeconds: number): number {
    return (
      this.overrideSharePercent ??
      this.config.percentageTilesOwnedToWin(elapsedSeconds)
    );
  }

  hasTerritorialWin(
    tilesOwned: number,
    landTiles: number,
    falloutTiles: number,
    requiredPercent: number,
  ): boolean {
    const withoutFallout = landTiles - falloutTiles;
    return tilesOwned * 100 > withoutFallout * requiredPercent;
  }

  hasTimerWin(
    elapsedSeconds: number,
    maxTimerValue: number | null | undefined,
  ): boolean {
    // null (host lobby, timer off) means no timer, same as undefined.
    if (
      maxTimerValue !== undefined &&
      maxTimerValue !== null &&
      elapsedSeconds >= maxTimerValue * 60
    ) {
      return true;
    }
    return elapsedSeconds >= StandardVictoryRules.HARD_TIME_LIMIT_SECONDS;
  }
}
