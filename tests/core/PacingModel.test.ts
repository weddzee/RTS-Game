// Prompt 2 unit tests: phases, balance layer, escalation math, victory
// rules and diagnostics queries. The full-length bot sim lives in
// tests/core/MatchPacingSim.test.ts.
import { describe, expect, it } from "vitest";
import {
  DOMAIN_MULTIPLIERS,
  UNLOCK_SCHEDULE,
  balanceFor,
  isSystemUnlocked,
  unlockedSystems,
} from "../../src/core/Balance";
import {
  escalatedAttackerLoss,
  escalatedConquestCost,
  escalatedDefenderLoss,
  escalatedFortificationBonus,
  escalatedFortificationSpeed,
  escalatedProduction,
  escalatedTrainSpeedBonus,
  escalationEnabled,
  escalationLevel,
  escalationLevelForConfig,
  escalationLevelForGame,
} from "../../src/core/Escalation";
import {
  armyStrength,
  matchDiagnostics,
  playerLevel,
} from "../../src/core/MatchDiagnostics";
import {
  STANDARD_MATCH_TICKS,
  expectedMatchTicks,
  matchProgress,
  phaseForProgress,
  phaseForTick,
} from "../../src/core/MatchPhase";
import type { GameConfig } from "../../src/core/Schemas";
import { StandardVictoryRules } from "../../src/core/VictoryRules";
import { PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { playerInfo, setup } from "../util/Setup";

const cfg = (overrides: Partial<GameConfig>): GameConfig =>
  overrides as GameConfig;

describe("match phases", () => {
  it("splits progress into opening/contact/midgame/endgame", () => {
    expect(phaseForProgress(0)).toBe("opening");
    expect(phaseForProgress(0.199)).toBe("opening");
    expect(phaseForProgress(0.2)).toBe("contact");
    expect(phaseForProgress(0.399)).toBe("contact");
    expect(phaseForProgress(0.4)).toBe("midgame");
    expect(phaseForProgress(0.699)).toBe("midgame");
    expect(phaseForProgress(0.7)).toBe("endgame");
    expect(phaseForProgress(1.5)).toBe("endgame");
  });

  it("measures progress as elapsed / expected without clamping above", () => {
    expect(matchProgress(1800, 9000)).toBeCloseTo(0.2, 10);
    expect(matchProgress(9000, 9000)).toBe(1);
    expect(matchProgress(9900, 9000)).toBeCloseTo(1.1, 10);
    expect(matchProgress(0, 9000)).toBe(0);
    expect(matchProgress(100, 0)).toBe(0);
  });

  it("derives expected ticks from the lobby timer, standard when untimed", () => {
    expect(expectedMatchTicks(cfg({ maxTimerValue: 10 }))).toBe(10 * 60 * 10);
    expect(expectedMatchTicks(cfg({ maxTimerValue: null }))).toBe(
      STANDARD_MATCH_TICKS,
    );
    expect(expectedMatchTicks(cfg({}))).toBe(STANDARD_MATCH_TICKS);
    expect(STANDARD_MATCH_TICKS).toBe(9000);
  });

  it("maps ticks to phases for a standard match", () => {
    expect(phaseForTick(0, 9000)).toBe("opening");
    expect(phaseForTick(1800, 9000)).toBe("contact");
    expect(phaseForTick(3600, 9000)).toBe("midgame");
    expect(phaseForTick(6300, 9000)).toBe("endgame");
  });
});

describe("balance layer", () => {
  it("keeps standard at 1.0 and documents rapid/extended pacing", () => {
    for (const domain of Object.keys(DOMAIN_MULTIPLIERS.standard)) {
      expect(
        DOMAIN_MULTIPLIERS.standard[
          domain as keyof typeof DOMAIN_MULTIPLIERS.standard
        ],
      ).toBe(1.0);
    }
    expect(DOMAIN_MULTIPLIERS.rapid.economy).toBe(1.5);
    expect(DOMAIN_MULTIPLIERS.extended.economy).toBeLessThan(1.0);
    expect(balanceFor("rapid").economy).toBe(1.5);
    expect(balanceFor("nope").preset).toBe("standard");
  });

  it("fires the unlock schedule in order", () => {
    expect(unlockedSystems(0)).toEqual([]);
    expect(unlockedSystems(0.2)).toEqual(["battlePlans", "armies"]);
    expect(unlockedSystems(0.5)).toEqual([
      "battlePlans",
      "armies",
      "aircraft",
      "supply",
    ]);
    expect(unlockedSystems(1.0).length).toBe(UNLOCK_SCHEDULE.length);
    expect(isSystemUnlocked("aircraft", 0.39)).toBe(false);
    expect(isSystemUnlocked("aircraft", 0.4)).toBe(true);
    expect(isSystemUnlocked("unknown", 1.0)).toBe(false);
  });
});

describe("escalation", () => {
  it("stays off before the deadline and steps up after", () => {
    expect(escalationLevel(9000, 9000)).toBe(0);
    expect(escalationLevel(9001, 9000)).toBe(1);
    expect(escalationLevel(9900, 9000)).toBe(2);
    expect(escalationLevel(10_000_000, 9000)).toBe(8);
    expect(escalationLevel(5000, 0)).toBe(0);
  });

  it("is disabled for untimed matches", () => {
    expect(escalationEnabled(cfg({ maxTimerValue: 15 }))).toBe(true);
    expect(escalationEnabled(cfg({ maxTimerValue: null }))).toBe(false);
    expect(escalationEnabled(cfg({}))).toBe(false);
  });

  it("never escalates an untimed match, however long it runs", () => {
    // The gate is the deadline: a sandbox has none, so it must not drift
    // into late-game pressure (regression: it used to measure against the
    // Standard 15-minute default and escalated from minute 15 on).
    expect(escalationLevelForConfig(cfg({ maxTimerValue: null }), 20_000)).toBe(
      0,
    );
    expect(escalationLevelForConfig(cfg({}), 10_000_000)).toBe(0);
    // Timed matches still escalate past their own deadline: 15 min =
    // 9000 expected ticks, +900 (90 s) per level.
    expect(escalationLevelForConfig(cfg({ maxTimerValue: 15 }), 10_800)).toBe(
      3,
    );
    expect(escalationLevelForConfig(cfg({ maxTimerValue: 15 }), 9_000)).toBe(0);
  });

  it("reports no escalation for a live untimed game", async () => {
    const game = await setup("plains", {}, [
      playerInfo("ann", PlayerType.Human),
    ]);
    // Past the Standard deadline in tick terms, but the match is untimed.
    expect(game.ticks()).toBe(0);
    expect(escalationLevelForGame(game)).toBe(0);
    expect(escalationLevelForConfig(game.config().gameConfig(), 20_000)).toBe(
      0,
    );
  });

  it("scales pressure monotonically with floors", () => {
    expect(escalatedAttackerLoss(100, 0)).toBe(100);
    expect(escalatedAttackerLoss(100, 1)).toBe(95);
    const atMax = escalatedAttackerLoss(100, 8);
    expect(atMax).toBeLessThan(escalatedAttackerLoss(100, 7));
    expect(atMax).toBeGreaterThanOrEqual(60);
    expect(escalatedDefenderLoss(100, 2)).toBe(110);
    expect(escalatedConquestCost(100, 4)).toBe(88);
    expect(escalatedProduction(100, 3)).toBe(124);
  });

  it("decays fortifications to no bonus and caps train speed", () => {
    expect(escalatedFortificationBonus(5, 0)).toBe(5);
    expect(escalatedFortificationBonus(5, 8)).toBe(1);
    expect(escalatedFortificationSpeed(3, 0)).toBe(3);
    expect(escalatedFortificationSpeed(3, 8)).toBe(1);
    expect(escalatedTrainSpeedBonus(0)).toBe(0);
    expect(escalatedTrainSpeedBonus(2)).toBe(0);
    expect(escalatedTrainSpeedBonus(3)).toBe(1);
    expect(escalatedTrainSpeedBonus(8)).toBe(2);
  });
});

describe("victory rules", () => {
  it("requires strictly more than the share of clean land", () => {
    const rules = new StandardVictoryRules(null as never);
    expect(rules.hasTerritorialWin(81, 100, 0, 80)).toBe(true);
    expect(rules.hasTerritorialWin(80, 100, 0, 80)).toBe(false);
    // Fallout shrinks the denominator: 73 of 90 clean tiles at 80%.
    expect(rules.hasTerritorialWin(73, 100, 10, 80)).toBe(true);
    expect(rules.hasTerritorialWin(72, 100, 10, 80)).toBe(false);
  });

  it("wins on the lobby timer and the hard limit", () => {
    const rules = new StandardVictoryRules(null as never);
    expect(rules.hasTimerWin(900, 15)).toBe(true);
    expect(rules.hasTimerWin(899, 15)).toBe(false);
    expect(rules.hasTimerWin(10_000, null)).toBe(false);
    expect(
      rules.hasTimerWin(StandardVictoryRules.HARD_TIME_LIMIT_SECONDS, null),
    ).toBe(true);
  });

  it("honours a configured share override", () => {
    const rules = new StandardVictoryRules(null as never, 50);
    expect(rules.requiredSharePercent(0)).toBe(50);
    expect(rules.hasTerritorialWin(51, 100, 0, 50)).toBe(true);
  });
});

describe("match diagnostics", () => {
  it("reads a fresh lobby without touching the sim", async () => {
    const game = await setup("plains", { maxTimerValue: 15 }, [
      playerInfo("ann", PlayerType.Human),
      playerInfo("bob", PlayerType.Human),
    ]);
    const ann = game.player("ann");
    const bob = game.player("bob");
    ann.conquer(game.ref(50, 50));
    bob.conquer(game.ref(52, 52));

    const d = matchDiagnostics(game);
    expect(d.elapsedTicks).toBe(game.ticks());
    expect(d.progress).toBe(0);
    expect(d.phase).toBe("opening");
    expect(d.escalationLevel).toBe(0);
    expect(d.aliveHumans).toBe(2);
    expect(d.totalTroops).toBe(ann.troops() + bob.troops());
    expect(d.leaderSharePercent).toBeCloseTo(
      (1 / game.numLandTiles()) * 100,
      10,
    );
    expect(d.totalFactories).toBe(0);
    expect(d.activeWars).toBe(0);
    expect(d.averagePlayerLevel).toBe(0);
    expect(d.trainTradeGold).toBe(0);
  });

  it("scores army strength from troops and military units", async () => {
    const game = await setup("plains", { maxTimerValue: 15 }, [
      playerInfo("ann", PlayerType.Human),
    ]);
    const ann = game.player("ann");
    ann.conquer(game.ref(50, 50));
    // No structures and no attacks: level 0, strength equals troops.
    expect(playerLevel(ann)).toBe(0);
    expect(armyStrength(ann)).toBe(ann.troops());
    expect(new PlayerInfo("x", PlayerType.Human, null, "x")).toBeDefined();
  });
});
