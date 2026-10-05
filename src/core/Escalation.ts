// Late-game pressure for matches that stall past their expected duration
// (Prompt 2.2).
//
// After the deadline passes, Escalation rises one level per step and
// gradually strengthens attacks, production and logistics while fading
// fortifications. There is no random unavoidable instant death: every
// effect is a bounded per-level percentage, and the level caps at
// ESCALATION_TUNING.maxLevel.
//
// Determinism: a pure function of (elapsedTicks, expectedTicks) using
// integer math only. Untimed (sandbox) matches never escalate — without a
// deadline there is nothing to be late for.

import { ESCALATION_TUNING } from "./Balance";
import { Game } from "./game/Game";
import { expectedMatchTicks } from "./MatchPhase";
import { GameConfig } from "./Schemas";

export function escalationLevel(
  elapsedTicks: number,
  expectedTicks: number,
): number {
  if (expectedTicks <= 0 || elapsedTicks <= expectedTicks) return 0;
  const level =
    1 +
    Math.floor((elapsedTicks - expectedTicks) / ESCALATION_TUNING.stepTicks);
  return Math.min(level, ESCALATION_TUNING.maxLevel);
}

/**
 * The single escalation gate. Untimed matches never escalate — without a
 * deadline there is nothing to be late for, so a sandbox run 3 hours long
 * must not drift into late-game pressure.
 *
 * Every caller goes through here (never the bare escalationLevel) so the
 * deadline rule cannot be forgotten at a call site.
 */
export function escalationLevelForConfig(
  gameConfig: GameConfig,
  elapsedTicks: number,
): number {
  if (!escalationEnabled(gameConfig)) return 0;
  return escalationLevel(elapsedTicks, expectedMatchTicks(gameConfig));
}

/** Escalation for a live game: expected ticks come from the lobby timer. */
export function escalationLevelForGame(game: Game): number {
  return escalationLevelForConfig(game.config().gameConfig(), game.ticks());
}

/** Whether this match can escalate at all (timed matches only). */
export function escalationEnabled(gameConfig: GameConfig): boolean {
  const minutes = gameConfig.maxTimerValue;
  return minutes !== undefined && minutes !== null && minutes > 0;
}

/** Multiplies a troop-loss value for the attacker (losses shrink). */
export function escalatedAttackerLoss(loss: number, level: number): number {
  if (level <= 0) return loss;
  const pct = 100 - level * ESCALATION_TUNING.attackerLossReductionPerLevel;
  return (loss * Math.max(60, pct)) / 100;
}

/** Multiplies a troop-loss value for the defender (losses grow). */
export function escalatedDefenderLoss(loss: number, level: number): number {
  if (level <= 0) return loss;
  const pct = 100 + level * ESCALATION_TUNING.defenderLossBonusPerLevel;
  return (loss * pct) / 100;
}

/** Scales a conquest tick-cost down (offensives accelerate). */
export function escalatedConquestCost(cost: number, level: number): number {
  if (level <= 0) return cost;
  const pct = 100 - level * ESCALATION_TUNING.conquestCostReductionPerLevel;
  return (cost * Math.max(75, pct)) / 100;
}

/** Scales a production amount up (troops and gold). */
export function escalatedProduction(amount: number, level: number): number {
  if (level <= 0) return amount;
  const pct = 100 + level * ESCALATION_TUNING.productionBonusPerLevel;
  return (amount * pct) / 100;
}

/** Defense-post loss bonus after fortification decay (base 5). */
export function escalatedFortificationBonus(
  baseBonus: number,
  level: number,
): number {
  if (level <= 0) return baseBonus;
  return Math.max(
    1,
    baseBonus -
      Math.floor(level / ESCALATION_TUNING.fortificationDecayLevelsPerPoint),
  );
}

/** Defense-post speed bonus after fortification decay (base 3). */
export function escalatedFortificationSpeed(
  baseBonus: number,
  level: number,
): number {
  if (level <= 0) return baseBonus;
  return Math.max(
    1,
    baseBonus -
      Math.floor(
        level / ESCALATION_TUNING.fortificationSpeedDecayLevelsPerPoint,
      ),
  );
}

/** Train speed bonus from faster logistics (+1 per 3 levels, capped). */
export function escalatedTrainSpeedBonus(level: number): number {
  if (level <= 0) return 0;
  return Math.min(
    ESCALATION_TUNING.maxTrainSpeedBonus,
    Math.floor(level / ESCALATION_TUNING.trainSpeedBonusEveryNLevels),
  );
}
