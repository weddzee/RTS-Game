// Prompt 2.6 acceptance: a bot-driven full match under Standard pacing
// proves the school-break arc — armies form early, levels reach late
// tiers, factories move the economy, unlocks fire, and escalation engages
// past the deadline. Uses the deterministic scripted driver (seeded, same
// every run); thresholds carry 2x+ margin under observed values.
import { describe, expect, it } from "vitest";
import { UNLOCK_SCHEDULE, unlockedSystems } from "../../src/core/Balance";
import {
  matchDiagnostics,
  type MatchDiagnostics,
} from "../../src/core/MatchDiagnostics";
import { matchPacingGameConfigPatch } from "../../src/core/MatchPacing";
import { STANDARD_MATCH_TICKS } from "../../src/core/MatchPhase";
import {
  createScriptedRunner,
  scriptedGameStart,
  stepScripted,
} from "../util/ScriptedGame";

describe("standard pacing full-match sim", () => {
  it("plays the arc: early armies, late levels, factories, unlocks, pressure", async () => {
    const patch = matchPacingGameConfigPatch("standard");
    expect(patch).toEqual({ maxTimerValue: 15, goldMultiplier: 1 });

    const runner = await createScriptedRunner(
      "world",
      scriptedGameStart({
        maxTimerValue: patch.maxTimerValue ?? undefined,
        goldMultiplier: patch.goldMultiplier,
        doomsdayClock: { enabled: false },
      }),
    );

    const seenPhases = new Set<string>();
    let opening: MatchDiagnostics | null = null;
    while (runner.game.ticks() < STANDARD_MATCH_TICKS + 1000) {
      stepScripted(runner);
      const tick = runner.game.ticks();
      if (tick === 1000) opening = matchDiagnostics(runner.game);
      if (tick % 1000 === 0) {
        seenPhases.add(matchDiagnostics(runner.game).phase);
      }
    }
    expect(opening).not.toBeNull();

    // Armies form early: million-plus troops and real wars in the opening.
    expect(opening!.totalTroops).toBeGreaterThan(1_000_000);
    expect(opening!.activeWars).toBeGreaterThanOrEqual(1);

    const end = matchDiagnostics(runner.game);
    // Level progression reaches late tiers.
    expect(end.averagePlayerLevel).toBeGreaterThanOrEqual(3);
    // Factories meaningfully influence the match: built and trading.
    expect(end.totalFactories).toBeGreaterThanOrEqual(10);
    expect(end.trainTradeGold).toBeGreaterThan(0);
    // The full phase arc was visited and every scheduled system unlocked.
    expect(seenPhases).toEqual(
      new Set(["opening", "contact", "midgame", "endgame"]),
    );
    expect(unlockedSystems(end.progress).length).toBe(UNLOCK_SCHEDULE.length);
    // Late-game pressure engaged past the deadline (no instant death:
    // the sim kept running and trading).
    expect(end.escalationLevel).toBeGreaterThanOrEqual(1);
    // The timer victory fires under pacing (no stall).
    expect(runner.game.getWinner()).not.toBeNull();
  }, 240_000);
});
