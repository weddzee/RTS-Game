// Lightweight developer diagnostics for the pacing model (Prompt 2.5).
//
// Pure reads over the game state — no third-party analytics, no network,
// no simulation effect. Used by the acceptance sim, dev scripts and (in a
// later pass) a dev-only overlay. All shares are diagnostic floats; the
// simulation itself keeps its integer rules in VictoryRules.
//
// Two documented proxies (there is no player-XP system yet):
// - playerLevel: the highest structure level a player owns (0 when they
//   own nothing upgraded). Contact-phase play shows levels 2-3; the
//   acceptance sim proves late levels are reachable.
// - armyStrength: troops plus 10 per military unit (warships, SAMs,
//   defense posts, missile silos). "Armies form early" means human army
//   strength clears the Opening threshold below.

import { escalationLevelForGame } from "./Escalation";
import type { Game, Player } from "./game/Game";
import { PlayerType, UnitType } from "./game/Game";
import {
  MatchPhase,
  expectedMatchTicks,
  matchProgress,
  phaseForTick,
} from "./MatchPhase";
import { GOLD_INDEX_TRAIN_OTHER, GOLD_INDEX_TRAIN_SELF } from "./StatsSchemas";

const MILITARY_UNIT_TYPES: readonly UnitType[] = [
  UnitType.Warship,
  UnitType.SAMLauncher,
  UnitType.DefensePost,
  UnitType.MissileSilo,
];

function statGold(playerStats: { gold?: unknown } | null | undefined): number {
  const gold = (playerStats as { gold?: unknown[] } | null | undefined)?.gold;
  if (!Array.isArray(gold)) return 0;
  const at = (i: number): number => Number(gold[i] ?? 0);
  return at(GOLD_INDEX_TRAIN_SELF) + at(GOLD_INDEX_TRAIN_OTHER);
}

/** Highest owned structure level; 0 when nothing is built or upgraded. */
export function playerLevel(player: Player): number {
  let best = 0;
  for (const unit of player.units()) {
    const level = unit.level();
    if (level > best) best = level;
  }
  return best;
}

/** Troops plus 10 per military unit. */
export function armyStrength(player: Player): number {
  let units = 0;
  for (const type of MILITARY_UNIT_TYPES) {
    units += player.units(type).length;
  }
  return player.troops() + units * 10;
}

export interface MatchDiagnostics {
  elapsedTicks: number;
  elapsedSeconds: number;
  /** Normalized progress; may exceed 1 in overtime. */
  progress: number;
  phase: MatchPhase;
  escalationLevel: number;
  alivePlayers: number;
  aliveHumans: number;
  /** Leader's land share, percent. */
  leaderSharePercent: number;
  totalTroops: number;
  totalFactories: number;
  avgFactoriesPerPlayer: number;
  averagePlayerLevel: number;
  /** Alive players with at least one outgoing attack. */
  activeWars: number;
  /** Train-trade gold recorded across all players. */
  trainTradeGold: number;
}

export function matchDiagnostics(game: Game): MatchDiagnostics {
  const elapsedTicks = game.ticks();
  const expectedTicks = expectedMatchTicks(game.config().gameConfig());
  const progress = matchProgress(elapsedTicks, expectedTicks);
  const alive = game.players();

  let leaderTiles = 0;
  let totalTroops = 0;
  let totalFactories = 0;
  let levelSum = 0;
  let wars = 0;
  let trainGold = 0;
  for (const player of alive) {
    if (player.numTilesOwned() > leaderTiles) {
      leaderTiles = player.numTilesOwned();
    }
    totalTroops += player.troops();
    totalFactories += player.units(UnitType.Factory).length;
    levelSum += playerLevel(player);
    if (player.outgoingAttacks().length > 0) wars++;
    trainGold += statGold(game.stats().getPlayerStats(player));
  }

  const landTiles = game.numLandTiles();
  return {
    elapsedTicks,
    elapsedSeconds: game.elapsedGameSeconds(),
    progress,
    phase: phaseForTick(elapsedTicks, expectedTicks),
    escalationLevel: escalationLevelForGame(game),
    alivePlayers: alive.length,
    aliveHumans: alive.filter((p) => p.type() === PlayerType.Human).length,
    leaderSharePercent: landTiles > 0 ? (leaderTiles / landTiles) * 100 : 0,
    totalTroops,
    totalFactories,
    avgFactoriesPerPlayer: alive.length > 0 ? totalFactories / alive.length : 0,
    averagePlayerLevel: alive.length > 0 ? levelSum / alive.length : 0,
    activeWars: wars,
    trainTradeGold: trainGold,
  };
}
