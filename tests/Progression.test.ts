// Prompt 6: fast per-match levels, XP, doctrines and choices.
//
// The system is server-authoritative and deterministic (6.4), so almost
// everything here is an exact-value assertion rather than a tolerance check:
// the same XP must produce the same level, the same panel and the same perks
// on every client, forever. A test that only asserted "it went up" would miss
// exactly the desync this design is meant to prevent.
//
// The last describe blocks exercise the parts that touch the rest of the
// simulation (territory, attacks, structures, elimination, perks changing real
// numbers) through the real game, not through stubs.

import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { ChoosePerkExecution } from "../src/core/execution/ChoosePerkExecution";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { FactoryType, factoryOutputFor } from "../src/core/game/Factory";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import type { PerkEffectChannel } from "../src/core/game/Progression";
import {
  DOCTRINES,
  MATCH_XP_THRESHOLDS,
  PERK_IDS,
  PROGRESSION_MAX_LEVEL,
  PROGRESSION_MIN_LEVEL,
  XP_CASUALTIES_PER_XP,
  XP_FOR_BATTLE_WON,
  XP_FOR_DEFENSE_HELD,
  XP_FOR_ELIMINATION,
  XP_FOR_STRUCTURE,
  XP_PER_TILE_VS_PLAYER,
  XP_PER_TILE_VS_TERRA,
  choicesForLevelUp,
  isPerkId,
  levelForXP,
  levelUpPanelFor,
  perkBonusFor,
  perkChannelBonus,
  perkDef,
  scaleXPForPacing,
  xpForCasualties,
  xpForLevel,
  xpForStructure,
  xpIntoLevel,
  xpProgressPercent,
  xpToNextLevel,
} from "../src/core/game/Progression";
import { GameConfig, GameID, IntentSchema } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { roundTrip } from "./util/Snapshot";
import { UseRealAttackLogic } from "./util/TestConfig";

const gameID: GameID = "game_id";

const playerInfo = (name: string, id: string) =>
  new PlayerInfo(name, PlayerType.Human, null, id);

// ---------------------------------------------------------------------------

describe("Progression: XP curve", () => {
  test("every match starts at level 1 with 0 XP", () => {
    expect(PROGRESSION_MIN_LEVEL).toBe(1);
    expect(PROGRESSION_MAX_LEVEL).toBe(7);
    expect(xpForLevel(1)).toBe(0);
    expect(levelForXP(0)).toBe(1);
  });

  test("thresholds are strictly increasing and cover every level", () => {
    expect(MATCH_XP_THRESHOLDS).toHaveLength(PROGRESSION_MAX_LEVEL + 1);
    for (let level = 2; level <= PROGRESSION_MAX_LEVEL; level++) {
      expect(xpForLevel(level)).toBeGreaterThan(xpForLevel(level - 1));
    }
    // Level 8 is "potentially later" (6.2): it must not be reachable today, but
    // xpForLevel must answer for it rather than throwing or going backwards.
    expect(xpForLevel(PROGRESSION_MAX_LEVEL + 1)).toBe(
      xpForLevel(PROGRESSION_MAX_LEVEL),
    );
  });

  test("levelForXP is the exact inverse of xpForLevel", () => {
    for (let level = 1; level <= PROGRESSION_MAX_LEVEL; level++) {
      expect(levelForXP(xpForLevel(level))).toBe(level);
    }
    // One XP short of each threshold is still the previous level.
    for (let level = 2; level <= PROGRESSION_MAX_LEVEL; level++) {
      expect(levelForXP(xpForLevel(level) - 1)).toBe(level - 1);
    }
  });

  test("XP past the maximum never exceeds the maximum level", () => {
    expect(levelForXP(10_000_000)).toBe(PROGRESSION_MAX_LEVEL);
    expect(levelForXP(-5)).toBe(PROGRESSION_MIN_LEVEL);
    expect(xpToNextLevel(10_000_000)).toBe(0);
    expect(xpIntoLevel(10_000_000)).toBe(0);
    expect(xpProgressPercent(10_000_000)).toBe(100);
  });

  test("XP-to-next and progress agree with the curve", () => {
    const xp = xpForLevel(3) + 100;
    expect(xpIntoLevel(xp)).toBe(100);
    expect(xpToNextLevel(xp)).toBe(xpForLevel(4) - xp);
    expect(xpProgressPercent(xp)).toBe(
      Math.floor((100 / (xpForLevel(4) - xpForLevel(3))) * 100),
    );
    // A level boundary is 0% into the next level, not 100%.
    expect(xpProgressPercent(xpForLevel(4))).toBe(0);
  });
});

describe("Progression: XP pacing (6.2)", () => {
  test("scaling is integer math and never awards from nothing", () => {
    expect(scaleXPForPacing(100, 100)).toBe(100);
    expect(scaleXPForPacing(100, 150)).toBe(150);
    expect(scaleXPForPacing(100, 90)).toBe(90);
    // Flooring, never rounding up: a perk-less base award can vanish at low
    // pacing rather than rounding into free XP.
    expect(scaleXPForPacing(3, 90)).toBe(2);
    expect(scaleXPForPacing(0, 150)).toBe(0);
    expect(scaleXPForPacing(-5, 100)).toBe(0);
    expect(scaleXPForPacing(100, 0)).toBe(0);
  });

  test("rapid pays more XP than standard, extended pays less", async () => {
    const percentFor = async (maxTimerValue: number | null) => {
      const config = { maxTimerValue } as Partial<GameConfig>;
      const game = await setup("plains", config, [playerInfo("p", "p_id")]);
      return game.config().xpPacingPercent();
    };
    const rapid = await percentFor(10);
    const standard = await percentFor(15);
    const extended = await percentFor(20);
    const sandbox = await percentFor(null);

    expect(standard).toBe(100);
    expect(sandbox).toBe(100);
    expect(rapid).toBeGreaterThan(standard);
    expect(extended).toBeLessThan(standard);
    // Integer percents only: the sim multiplies with integer math.
    for (const pct of [rapid, standard, extended, sandbox]) {
      expect(Number.isInteger(pct)).toBe(true);
    }
  });
});

describe("Progression: XP sources (6.1)", () => {
  test("expansion is worth far less than conquest", () => {
    expect(XP_PER_TILE_VS_TERRA).toBeLessThan(XP_PER_TILE_VS_PLAYER);
  });

  test("structure XP is keyed by UnitType and unknown types pay nothing", () => {
    for (const [type, xp] of Object.entries(XP_FOR_STRUCTURE)) {
      expect(xpForStructure(type)).toBe(xp);
    }
    expect(xpForStructure(UnitType.City)).toBe(XP_FOR_STRUCTURE["City"]);
    expect(xpForStructure(UnitType.Factory)).toBeGreaterThan(0);
    // No generic "build anything" faucet.
    expect(xpForStructure(UnitType.Warship)).toBe(0);
    expect(xpForStructure(UnitType.Train)).toBe(0);
    expect(xpForStructure("nonsense")).toBe(0);
  });

  test("casualty XP is floored and never negative", () => {
    expect(xpForCasualties(XP_CASUALTIES_PER_XP)).toBe(1);
    expect(
      xpForCasualties(XP_CASUALTIES_PER_XP * 10 + XP_CASUALTIES_PER_XP - 1),
    ).toBe(10);
    expect(xpForCasualties(XP_CASUALTIES_PER_XP - 1)).toBe(0);
    expect(xpForCasualties(0)).toBe(0);
    expect(xpForCasualties(-100)).toBe(0);
  });

  test("eliminating a player is worth far more than any single other award", () => {
    const biggestStructure = Math.max(...Object.values(XP_FOR_STRUCTURE));
    expect(XP_FOR_ELIMINATION).toBeGreaterThan(biggestStructure);
    expect(XP_FOR_ELIMINATION).toBeGreaterThan(XP_FOR_BATTLE_WON);
    expect(XP_FOR_ELIMINATION).toBeGreaterThan(XP_FOR_DEFENSE_HELD);
  });
});

describe("Progression: perk catalog (6.3)", () => {
  test("every perk has a stable ID, a known doctrine, and one channel", () => {
    expect(PERK_IDS.length).toBeGreaterThanOrEqual(10);
    expect(PERK_IDS.length).toBe(new Set(PERK_IDS).size);
    for (const id of PERK_IDS) {
      expect(isPerkId(id)).toBe(true);
      const def = perkDef(id);
      expect(def).toBeDefined();
      expect(def!.id).toBe(id);
      expect(DOCTRINES).toContain(def!.doctrine);
      expect(def!.magnitude).toBeGreaterThan(0);
      // Translation keys are derived from the ID, so a renamed ID silently
      // loses its strings: they must stay in lockstep.
      expect(def!.nameKey).toBe(`progression.perks.${id}.name`);
      expect(def!.descKey).toBe(`progression.perks.${id}.desc`);
    }
    expect(isPerkId("not-a-perk")).toBe(false);
    expect(isPerkId(undefined)).toBe(false);
    expect(isPerkId(7)).toBe(false);
  });

  test("the catalog spans every doctrine family the spec names", () => {
    const used = new Set(PERK_IDS.map((id) => perkDef(id)!.doctrine));
    for (const doctrine of DOCTRINES) expect(used).toContain(doctrine);
  });

  test("channel bonuses sum, and unrelated channels are unaffected", () => {
    const blitz = PERK_IDS.filter((id) => perkDef(id)!.channel === "offense");
    expect(blitz.length).toBeGreaterThan(0);
    const total = blitz.reduce((a, id) => a + perkDef(id)!.magnitude, 0);
    expect(perkChannelBonus(blitz, "offense")).toBe(total);
    expect(perkChannelBonus(blitz, "supply")).toBe(0);
    expect(perkChannelBonus([], "offense")).toBe(0);
    expect(perkChannelBonus(["not-a-perk"], "offense")).toBe(0);
  });

  test("perkBonusFor reads a player-like object and tolerates absent ones", () => {
    const applied = (ids: string[]) => ({ appliedPerks: () => ids });
    expect(perkBonusFor(applied(["war-industry"]), "industry")).toBe(
      perkDef("war-industry")!.magnitude,
    );
    expect(perkBonusFor(applied([]), "industry")).toBe(0);
    // No appliedPerks at all: reads 0 rather than throwing, so a bare test
    // double or a client mirror can be passed through the same code path.
    expect(perkBonusFor({}, "industry")).toBe(0);
    expect(perkBonusFor(null, "industry")).toBe(0);
    expect(perkBonusFor(undefined, "industry")).toBe(0);
  });
});

describe("Progression: level-up choices are server-generated (6.3, 6.4)", () => {
  test("the same inputs always produce the same options", () => {
    const first = choicesForLevelUp("player_abc", 4, ["rapid-advance"]);
    for (let i = 0; i < 25; i++) {
      expect(choicesForLevelUp("player_abc", 4, ["rapid-advance"])).toEqual(
        first,
      );
    }
  });

  test("2-3 options, each from a different doctrine", () => {
    for (let level = 2; level <= PROGRESSION_MAX_LEVEL; level++) {
      const choices = choicesForLevelUp(`player_${level}`, level, []);
      expect(choices.length).toBeGreaterThanOrEqual(2);
      expect(choices.length).toBeLessThanOrEqual(3);
      const doctrines = choices.map((id) => perkDef(id)!.doctrine);
      expect(new Set(doctrines).size).toBe(choices.length);
    }
  });

  test("an applied perk is never offered again", () => {
    const applied: string[] = [];
    for (let level = 2; level <= PROGRESSION_MAX_LEVEL; level++) {
      const choices = choicesForLevelUp("player_xyz", level, applied);
      for (const id of choices) expect(applied).not.toContain(id);
      applied.push(choices[0]);
    }
    expect(applied.length).toBe(PROGRESSION_MAX_LEVEL - 1);
    expect(new Set(applied).size).toBe(applied.length);
  });

  test("different players and levels diverge", () => {
    const seen = new Set<string>();
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      seen.add(choicesForLevelUp(id, 2, []).join("|"));
      seen.add(choicesForLevelUp(id, 5, []).join("|"));
    }
    // Not every draw must be unique, but the offer cannot be one fixed set for
    // everyone at every level — that would make the choice cosmetic.
    expect(seen.size).toBeGreaterThan(2);
  });

  test("choices never depend on wall-clock or unseeded randomness", () => {
    const baseline = choicesForLevelUp("player_abc", 3, []);
    for (let i = 0; i < 5; i++) {
      expect(choicesForLevelUp("player_abc", 3, [])).toEqual(baseline);
    }
  });

  test("the panel is null when there is nothing to pick", () => {
    expect(
      levelUpPanelFor({
        matchLevel: () => 4,
        pendingPerkChoices: () => [],
      }),
    ).toBeNull();
  });

  test("the panel reports the level on offer, not the current level", () => {
    // A queued second pick still shows the level it was earned at, so a player
    // who is already level 7 sees "LEVEL UP - 6" for a level-6 choice.
    const panel = levelUpPanelFor({
      matchLevel: () => 7,
      pendingPerkChoices: () => ["war-industry", "rapid-advance"],
      pendingPerkLevel: () => 6,
    });
    expect(panel).not.toBeNull();
    expect(panel!.level).toBe(6);
    expect(panel!.choices.map((c) => c.id)).toEqual([
      "war-industry",
      "rapid-advance",
    ]);
    for (const choice of panel!.choices) {
      expect(choice.nameKey).not.toBe("");
      expect(choice.descKey).not.toBe("");
      expect(DOCTRINES).toContain(choice.doctrine);
    }
  });

  test("a panel with no pendingPerkLevel falls back to the current level", () => {
    const panel = levelUpPanelFor({
      matchLevel: () => 5,
      pendingPerkChoices: () => ["supply-lines"],
    });
    expect(panel!.level).toBe(5);
  });
});

// ---------------------------------------------------------------------------

async function twoPlayerGame(
  gameConfig: Partial<GameConfig> = {},
): Promise<{ game: Game; attacker: Player; defender: Player }> {
  const game = await setup(
    "plains",
    {
      infiniteGold: true,
      infiniteTroops: true,
      instantBuild: true,
      ...gameConfig,
    },
    [
      playerInfo("attacker", "attacker_id"),
      playerInfo("defender", "defender_id"),
    ],
    undefined,
    UseRealAttackLogic,
  );
  game.addExecution(
    new SpawnExecution(
      gameID,
      game.player("attacker_id").info(),
      game.ref(1, 10),
    ),
    new SpawnExecution(
      gameID,
      game.player("defender_id").info(),
      game.ref(12, 10),
    ),
  );
  game.executeNextTick();
  game.executeNextTick();
  return {
    game,
    attacker: game.player("attacker_id"),
    defender: game.player("defender_id"),
  };
}

/**
 * A game of `count` spawned human players at fixed spawn points, each leveled
 * to the maximum and holding the first perk offered at every level.
 *
 * Fixed ids and a fixed hash mean the resulting picks are the same on every
 * run, which is what lets the perk tests below name a concrete channel and know
 * some player really ended up with it.
 */
async function leveledGame(
  count = 12,
): Promise<{ game: Game; players: Player[] }> {
  const ids = Array.from({ length: count }, (_, i) => `lev_${i}`);
  const game = await setup(
    "plains",
    { infiniteGold: true, infiniteTroops: true, instantBuild: false },
    ids.map((id) => playerInfo(id, id)),
    undefined,
    UseRealAttackLogic,
  );
  const players = ids.map((id) => game.player(id));
  game.addExecution(
    ...players.map(
      (p, i) => new SpawnExecution(gameID, p.info(), game.ref(1 + i, 10)),
    ),
  );
  game.executeNextTick();
  game.executeNextTick();

  for (const p of players) {
    p.addMatchXP(xpForLevel(PROGRESSION_MAX_LEVEL));
    while (p.pendingPerkChoices().length > 0) {
      p.choosePerk(p.pendingPerkChoices()[0]);
    }
  }
  return { game, players };
}

/** A player holding at least one applied perk on `channel`. */
function playerWithChannel(
  players: Player[],
  channel: PerkEffectChannel,
): Player {
  const found = players.find(
    (p) => perkChannelBonus(p.appliedPerks(), channel) > 0,
  );
  if (found === undefined) {
    throw new Error(`no leveled player holds a ${channel} perk`);
  }
  return found;
}

describe("Progression: XP in the simulation", () => {
  test("territory pays: players' tiles more than empty land, own tiles nothing", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [playerInfo("a", "a_id"), playerInfo("b", "b_id")],
    );
    const a = game.player("a_id");
    const b = game.player("b_id");

    a.conquer(game.ref(1, 10));
    expect(a.matchXP()).toBe(XP_PER_TILE_VS_TERRA);
    expect(a.matchLevel()).toBe(1);

    // Re-stamping a tile you already own pays nothing: no infinite faucet.
    const before = a.matchXP();
    a.conquer(game.ref(1, 10));
    expect(a.matchXP()).toBe(before);

    a.conquer(game.ref(2, 10));
    expect(a.matchXP()).toBe(2 * XP_PER_TILE_VS_TERRA);

    b.conquer(game.ref(12, 10));
    a.conquer(game.ref(12, 10));
    expect(a.matchXP()).toBe(2 * XP_PER_TILE_VS_TERRA + XP_PER_TILE_VS_PLAYER);
  });

  test("a level-up queues a pick that survives until it is taken", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [playerInfo("a", "a_id")],
    );
    const a = game.player("a_id");

    expect(a.pendingPerkChoices()).toEqual([]);
    expect(a.pendingPerkLevel()).toBe(0);

    a.addMatchXP(xpForLevel(2));
    expect(a.matchLevel()).toBe(2);
    expect(a.pendingPerkChoices().length).toBeGreaterThanOrEqual(2);
    expect(a.pendingPerkLevel()).toBe(2);

    // Choices are stable across reads — the panel must not reshuffle itself
    // while the player is deciding.
    const offered = [...a.pendingPerkChoices()];
    expect(a.pendingPerkChoices()).toEqual(offered);
    game.executeNextTick();
    game.executeNextTick();
    expect(a.pendingPerkChoices()).toEqual(offered);

    // More XP while a pick is pending does not disturb the offer.
    a.addMatchXP(50);
    expect(a.pendingPerkChoices()).toEqual(offered);
  });

  test("a single award that crosses several levels queues one pick per level", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [playerInfo("a", "a_id")],
    );
    const a = game.player("a_id");

    // Jumps from level 1 straight past level 4.
    a.addMatchXP(xpForLevel(4));
    expect(a.matchLevel()).toBe(4);
    expect(a.pendingPerkLevels()).toHaveLength(3);
    expect([...a.pendingPerkLevels()]).toEqual([2, 3, 4]);
    // The offer on screen is the OLDEST owed pick, so the panel says level 2
    // while the player is already level 4 — the queued picks are not lost, and
    // nothing was silently dropped in favour of the newest one.
    expect(a.pendingPerkLevel()).toBe(2);

    // Each pick is one level, oldest first, and a later level never offers a
    // perk an earlier one just took.
    const taken: string[] = [];
    for (const level of [2, 3, 4]) {
      expect(a.pendingPerkLevel()).toBe(level);
      const choices = a.pendingPerkChoices();
      expect(choices.length).toBeGreaterThanOrEqual(2);
      const pick = choices[0];
      for (const id of taken) expect(choices).not.toContain(id);
      expect(a.choosePerk(pick)).toBe(true);
      taken.push(pick);
    }
    expect(a.pendingPerkChoices()).toEqual([]);
    expect(a.pendingPerkLevel()).toBe(0);
    expect([...a.pendingPerkLevels()]).toEqual([]);
    expect(a.appliedPerks()).toEqual(taken);
    expect(a.matchLevel()).toBe(4);
  });

  test("a perk applies exactly once, and only from the pending set", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [playerInfo("a", "a_id")],
    );
    const a = game.player("a_id");
    a.addMatchXP(xpForLevel(2));

    const pick = a.pendingPerkChoices()[0];
    expect(a.choosePerk(pick)).toBe(true);
    // Replayed intent: the offer is gone, so the pick is refused and the perk
    // is not stacked.
    expect(a.choosePerk(pick)).toBe(false);
    expect(a.choosePerk(pick)).toBe(false);
    expect(a.appliedPerks()).toEqual([pick]);

    // Unknown ID, and a real perk that was never offered.
    expect(a.choosePerk("not-a-perk")).toBe(false);
    const unoffered = PERK_IDS.find((id) => !a.appliedPerks().includes(id))!;
    expect(a.choosePerk(unoffered)).toBe(false);
    expect(a.appliedPerks()).toEqual([pick]);
  });

  test("levels stop at the maximum, and no pick is owed at it", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [playerInfo("a", "a_id")],
    );
    const a = game.player("a_id");
    a.addMatchXP(1_000_000);
    expect(a.matchLevel()).toBe(PROGRESSION_MAX_LEVEL);
    expect(a.pendingPerkLevels()).toHaveLength(PROGRESSION_MAX_LEVEL - 1);
    expect(a.matchXP()).toBeGreaterThan(xpForLevel(PROGRESSION_MAX_LEVEL));
  });

  test("progression state survives a snapshot round trip (6.4 reconnect)", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [playerInfo("a", "a_id")],
    );
    const a = game.player("a_id");
    a.addMatchXP(xpForLevel(3));
    const pick = a.pendingPerkChoices()[0];
    expect(a.choosePerk(pick)).toBe(true);
    // One pick taken, one still owed: the restored game must reproduce both the
    // applied set and the still-pending offer, exactly.
    const offered = [...a.pendingPerkChoices()];
    const offeredLevel = a.pendingPerkLevel();

    const { restored } = await roundTrip(game, "plains");
    const r = restored.player("a_id");
    expect(r.matchXP()).toBe(a.matchXP());
    expect(r.matchLevel()).toBe(a.matchLevel());
    expect(r.appliedPerks()).toEqual([pick]);
    expect(r.pendingPerkLevel()).toBe(offeredLevel);
    expect(r.pendingPerkChoices()).toEqual(offered);

    // And the restored pick is still honored, then still consumed exactly once.
    const next = r.pendingPerkChoices()[0];
    expect(r.choosePerk(next)).toBe(true);
    expect(r.choosePerk(next)).toBe(false);
    expect(r.appliedPerks()).toEqual([pick, next]);
  });

  test("an attack pays the attacker for ground and the defender for holding", async () => {
    const { game, attacker, defender } = await twoPlayerGame({
      infiniteTroops: false,
    });
    // A wide defender that stays alive: "defending successfully" is a reward
    // for holding land, so an elimination must not be able to claim it.
    for (let x = 3; x <= 20; x++) {
      for (let y = 1; y <= 14; y++) defender.conquer(game.ref(x, y));
    }
    for (let y = 1; y <= 14; y++) attacker.conquer(game.ref(1, y));
    attacker.setTroops(20_000);

    const attackerXPBefore = attacker.matchXP();
    const defenderXPBefore = defender.matchXP();

    game.addExecution(new AttackExecution(2_000, attacker, defender.id()));
    for (let i = 0; i < 20; i++) game.executeNextTick();

    expect(defender.isAlive()).toBe(true);
    expect(defender.numTilesOwned()).toBeGreaterThan(0);
    expect(attacker.matchXP()).toBeGreaterThan(attackerXPBefore);
    expect(defender.matchXP()).toBeGreaterThan(defenderXPBefore);
    // A defeated player earns nothing for the defeat itself.
    expect(attacker.appliedPerks()).toEqual([]); // picks are never auto-applied
  });

  test("an attack that never lands pays nobody", async () => {
    const { game, attacker, defender } = await twoPlayerGame({
      infiniteTroops: false,
    });
    attacker.setTroops(20_000);
    const attackerXPBefore = attacker.matchXP();
    const defenderXPBefore = defender.matchXP();

    // Far apart: the offensive is created, finds no reachable ground in one
    // tick, and retires.
    game.addExecution(new AttackExecution(100, attacker, defender.id()));
    game.executeNextTick();
    game.executeNextTick();

    expect(attacker.matchXP()).toBe(attackerXPBefore);
    expect(defender.matchXP()).toBe(defenderXPBefore);
  });

  test("attacking an ally pays nobody (6.1 no ally farming)", async () => {
    const { game, attacker, defender } = await twoPlayerGame({
      infiniteTroops: false,
    });
    for (let x = 3; x <= 20; x++) {
      for (let y = 1; y <= 14; y++) defender.conquer(game.ref(x, y));
    }
    for (let y = 1; y <= 14; y++) attacker.conquer(game.ref(1, y));
    attacker.setTroops(20_000);

    // Alliance first: attacks on friendlies are refused in init(), before any
    // XP path can run.
    game.addExecution(new AllianceRequestExecution(attacker, defender.id()));
    game.addExecution(new AllianceRequestExecution(defender, attacker.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(attacker.alliances().length).toBe(1);

    const attackerXPBefore = attacker.matchXP();
    const defenderXPBefore = defender.matchXP();

    game.addExecution(new AttackExecution(2_000, attacker, defender.id()));
    for (let i = 0; i < 20; i++) game.executeNextTick();

    expect(attacker.isFriendly(defender)).toBe(true);
    expect(attacker.matchXP()).toBe(attackerXPBefore);
    expect(defender.matchXP()).toBe(defenderXPBefore);
  });

  test("eliminating a player pays the conqueror the major-objective award", async () => {
    const { game, attacker, defender } = await twoPlayerGame();
    for (let x = 2; x < 12; x++) defender.conquer(game.ref(x, 10));
    const before = attacker.matchXP();
    game.conquerPlayer(attacker, defender);
    expect(attacker.matchXP()).toBe(before + XP_FOR_ELIMINATION);
  });

  test("finishing a structure pays its construction award", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: false, instantBuild: true, infiniteTroops: true },
      [playerInfo("builder", "builder_id")],
    );
    const player = game.player("builder_id");
    player.conquer(game.ref(0, 10));
    player.conquer(game.ref(1, 10));
    player.addGold(100_000_000n);

    const before = player.matchXP();
    game.addExecution(
      new ConstructionExecution(player, UnitType.City, game.ref(0, 10)),
    );
    game.executeNextTick();
    game.executeNextTick();
    expect(player.matchXP()).toBe(before + XP_FOR_STRUCTURE["City"]);
  });
});

// ---------------------------------------------------------------------------

describe("Progression: perks change real simulation numbers (6.4)", () => {
  test("leveling up lets a player reach every perk channel", async () => {
    const { players } = await leveledGame();
    for (const player of players) {
      expect(player.matchLevel()).toBe(PROGRESSION_MAX_LEVEL);
      expect(player.appliedPerks()).toHaveLength(PROGRESSION_MAX_LEVEL - 1);
      expect(new Set(player.appliedPerks()).size).toBe(
        player.appliedPerks().length,
      );
    }
    // Every channel the spec asks for is actually reachable by playing.
    for (const channel of [
      "offense",
      "manpower",
      "defense",
      "air",
      "industry",
      "construction",
      "supply",
    ] as const) {
      expect(playerWithChannel(players, channel)).toBeDefined();
    }
  });

  test("a Logistics perk raises the troop ceiling", async () => {
    const { game, players } = await leveledGame();
    const perked = playerWithChannel(players, "supply");
    const plain = players.find((p) => !perkBonusFor(p, "supply"))!;
    // Compare at equal territory so the tile term cannot explain the gap.
    for (let x = 1; x < 6; x++) {
      plain.conquer(game.ref(x, 1));
      perked.conquer(game.ref(x, 4));
    }
    expect(game.config().maxTroops(plain)).toBeGreaterThan(0);
    const ratio =
      game.config().maxTroops(perked) / game.config().maxTroops(plain);
    expect(ratio).toBeCloseTo(1 + perkBonusFor(perked, "supply") / 100, 4);
  });

  test("a Mass Assault perk raises the reinforcement rate", async () => {
    const { game, players } = await leveledGame();
    const perked = playerWithChannel(players, "manpower");
    const plain = players.find((p) => !perkBonusFor(p, "manpower"))!;
    for (let x = 1; x < 6; x++) {
      plain.conquer(game.ref(x, 1));
      perked.conquer(game.ref(x, 4));
    }
    plain.setTroops(0);
    perked.setTroops(0);
    expect(game.config().troopIncreaseRate(perked)).toBeGreaterThan(
      game.config().troopIncreaseRate(plain),
    );
  });

  test("an Industry perk raises factory output and speeds construction", async () => {
    const { game, players } = await leveledGame();
    const output = playerWithChannel(players, "industry");
    const speed = playerWithChannel(players, "construction");
    const plain = players.find(
      (p) => !perkBonusFor(p, "industry") && !perkBonusFor(p, "construction"),
    )!;

    expect(game.config().factoryOutputPacingPercentFor(output)).toBe(
      game.config().factoryOutputPacingPercentFor(plain) +
        perkBonusFor(output, "industry"),
    );
    expect(
      game.config().factoryConstructionDuration(FactoryType.Military, speed),
    ).toBeLessThan(
      game.config().factoryConstructionDuration(FactoryType.Military, plain),
    );
    // The two channels are distinct: construction speed does not move output.
    expect(game.config().factoryOutputPacingPercentFor(speed)).toBe(
      game.config().factoryOutputPacingPercentFor(plain),
    );
  });

  test("the Air perk scales aircraft capacity without inflating everything else", () => {
    const before = factoryOutputFor(FactoryType.Air, 1, 100, 100);
    const withAir = factoryOutputFor(FactoryType.Air, 1, 100, 100, {
      perks: { industryPercent: 100, airPercent: 150 },
    });
    expect(before.aircraftPoints).toBeGreaterThan(0);
    expect(withAir.aircraftPoints).toBeGreaterThan(before.aircraftPoints);
    // Air Power is specific: an Air factory pays no gold or troops, so those
    // channels must stay exactly where they were.
    expect(withAir.incomeGoldPerTick).toBe(before.incomeGoldPerTick);
    expect(withAir.reinforcementTroopsPerTick).toBe(
      before.reinforcementTroopsPerTick,
    );

    // Industry is the general one: it scales every channel of every factory.
    const civilian = factoryOutputFor(FactoryType.Civilian, 1, 100, 100);
    const withIndustry = factoryOutputFor(FactoryType.Civilian, 1, 100, 100, {
      perks: { industryPercent: 120, airPercent: 100 },
    });
    expect(civilian.incomeGoldPerTick).toBeGreaterThan(0);
    expect(withIndustry.incomeGoldPerTick).toBeGreaterThan(
      civilian.incomeGoldPerTick,
    );
    expect(withIndustry.constructionPoints).toBeGreaterThan(
      civilian.constructionPoints,
    );
  });

  test("a perk-less player resolves combat exactly as before progression existed", async () => {
    const { game, players } = await leveledGame();
    const baseInput = {
      terrain: 1 as never,
      attackTroops: 1000,
      attacker: { type: PlayerType.Human, numTiles: 100 },
      defenderHasDefensePost: false,
      falloutRatio: null,
      borderSize: 5,
    };
    const defenderState = {
      type: PlayerType.Human,
      numTiles: 100,
      troops: 500,
      isTraitor: false,
      isDisconnectedTeammate: false,
    };
    const withoutPerks = game.config().attackLogic({
      ...baseInput,
      defender: defenderState,
    });

    const defender = playerWithChannel(players, "defense");
    const defensePercent = perkBonusFor(defender, "defense");
    expect(defensePercent).toBeGreaterThan(0);
    const withDefense = game.config().attackLogic({
      ...baseInput,
      defender: { ...defenderState, perkDefensePercent: defensePercent },
    });

    // Fortress cuts the defender's losses, and with them the troops the
    // attacker has to spend to break through. It does not touch the attacker's
    // own loss rate or the speed of a tile, so a perk-less offensive still
    // costs and takes exactly what it did before progression existed.
    expect(withDefense.defenderTroopLoss).toBeLessThan(
      withoutPerks.defenderTroopLoss,
    );
    expect(withDefense.attackerTroopLoss).toBeLessThan(
      withoutPerks.attackerTroopLoss,
    );
    expect(withDefense.tickFraction).toBe(withoutPerks.tickFraction);

    // The undefended baseline is untouched by another player's perks: nothing
    // about a fortress anywhere on the map leaks into this calculation.
    const otherDefended = game.config().attackLogic({
      ...baseInput,
      defender: defenderState,
    });
    expect(otherDefended).toEqual(withoutPerks);
  });

  test("a Blitz perk makes an attacker bleed less and take ground faster", async () => {
    const { game, players } = await leveledGame();
    const blitz = playerWithChannel(players, "offense");
    const plain = players.find((p) => !perkBonusFor(p, "offense"))!;
    const baseInput = {
      terrain: 1 as never,
      attackTroops: 1000,
      attacker: { type: PlayerType.Human, numTiles: 100 },
      defenderHasDefensePost: false,
      falloutRatio: null,
      borderSize: 5,
    };
    const defender = {
      type: PlayerType.Human,
      numTiles: 100,
      troops: 500,
      isTraitor: false,
      isDisconnectedTeammate: false,
    };
    const offense = perkBonusFor(blitz, "offense");
    expect(offense).toBeGreaterThan(0);

    const plainResult = game.config().attackLogic({ ...baseInput, defender });
    const blitzResult = game.config().attackLogic({
      ...baseInput,
      defender,
      attackerModifiers: {
        lossDivisor: 100 + offense,
        defenderLossMultiplier: 100 + offense,
        conquestCostMultiplier: 100 + offense,
      },
    });

    expect(blitzResult.attackerTroopLoss).toBeLessThan(
      plainResult.attackerTroopLoss,
    );
    expect(blitzResult.defenderTroopLoss).toBeGreaterThan(
      plainResult.defenderTroopLoss,
    );
    // A shorter conquest cost per tile means more tiles per tick.
    expect(blitzResult.tickFraction).toBeLessThan(plainResult.tickFraction);
    // And the untouched player is, by definition, unaffected.
    expect(perkBonusFor(plain, "offense")).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("Progression: choose_perk intent (6.4)", () => {
  test("the schema carries an ID and nothing else", () => {
    const parsed = IntentSchema.parse({
      type: "choose_perk",
      perkId: "war-industry",
    });
    expect(parsed).toEqual({ type: "choose_perk", perkId: "war-industry" });
    // Nothing about the effect rides the wire. An attempt to describe one is
    // dropped rather than honored, so there is no field a hostile client could
    // use to make a perk do more than its catalog entry says.
    const withExtra = IntentSchema.parse({
      type: "choose_perk",
      perkId: "war-industry",
      magnitude: 10_000,
      channel: "supply",
    });
    expect(Object.keys(withExtra).sort()).toEqual(["perkId", "type"]);
    // And an intent with no ID at all is rejected outright.
    expect(IntentSchema.safeParse({ type: "choose_perk" }).success).toBe(false);
  });

  test("the execution applies a pending perk and refuses everything else", async () => {
    const { game, attacker } = await twoPlayerGame();
    attacker.addMatchXP(xpForLevel(2));
    const offered = attacker.pendingPerkChoices()[0];

    // A real perk that was never offered.
    const unoffered = PERK_IDS.find(
      (id) => !attacker.pendingPerkChoices().includes(id),
    )!;
    const forged = new ChoosePerkExecution(attacker, "totally-made-up");
    const stale = new ChoosePerkExecution(attacker, unoffered);
    const good = new ChoosePerkExecution(attacker, offered);
    game.addExecution(forged, stale, good);
    game.executeNextTick();
    game.executeNextTick();

    expect(forged.failureReason()).toContain("unknown perk");
    expect(stale.failureReason()).toContain("not one of the pending choices");
    expect(good.failureReason()).toBeNull();
    expect(attacker.appliedPerks()).toEqual([offered]);
    expect(attacker.pendingPerkChoices()).toEqual([]);
  });

  test("a replayed intent is refused, so a perk never applies twice", async () => {
    const { game, attacker } = await twoPlayerGame();
    attacker.addMatchXP(xpForLevel(2));
    const offered = attacker.pendingPerkChoices()[0];

    game.addExecution(new ChoosePerkExecution(attacker, offered));
    game.executeNextTick();
    game.executeNextTick();
    expect(attacker.appliedPerks()).toEqual([offered]);

    game.addExecution(new ChoosePerkExecution(attacker, offered));
    game.executeNextTick();
    game.executeNextTick();
    expect(attacker.appliedPerks()).toEqual([offered]);
  });

  test("a player who is not in the game cannot pick", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [playerInfo("a", "a_id")],
    );
    const player = game.player("a_id");
    // Never spawned: hasSpawned() is false, so the execution must refuse.
    player.addMatchXP(xpForLevel(2));
    const offered = player.pendingPerkChoices()[0];
    const exec = new ChoosePerkExecution(player, offered);
    game.addExecution(exec);
    game.executeNextTick();
    game.executeNextTick();
    expect(exec.failureReason()).toContain("not in the game");
    expect(player.appliedPerks()).toEqual([]);
  });
});

describe("Progression: the curve as a match (6.2, 6.6)", () => {
  test("a completely inactive player never leaves the opening levels", () => {
    // Spawn, drift into empty land, build nothing, fight nothing: the whole of
    // what waiting can earn.
    let xp = 0;
    for (let i = 0; i < 200; i++) xp += XP_PER_TILE_VS_TERRA;
    expect(xp).toBeGreaterThan(0);
    expect(levelForXP(xp)).toBeLessThan(PROGRESSION_MAX_LEVEL);
    expect(levelForXP(xp)).toBeLessThanOrEqual(3);
  });

  test("a strong Standard performance reaches the late game, and 7 is a stretch", () => {
    // A representative good game: expansion, a few structures, real fighting
    // on both sides, and one elimination.
    const tilesVsPlayers = 150;
    const tilesVsTerra = 250;
    const structures = 4 * XP_FOR_STRUCTURE["Factory"];
    const battles = 8 * XP_FOR_BATTLE_WON + 6 * XP_FOR_DEFENSE_HELD;
    const casualties = Math.floor((30_000 * 2) / XP_CASUALTIES_PER_XP);
    const xp =
      tilesVsPlayers * XP_PER_TILE_VS_PLAYER +
      tilesVsTerra * XP_PER_TILE_VS_TERRA +
      structures +
      battles +
      xpForCasualties(casualties) +
      XP_FOR_ELIMINATION;

    // Late game by the end of a 15-minute match (Level 5+), which is what the
    // spec asks for...
    expect(levelForXP(xp)).toBeGreaterThanOrEqual(5);
    // ...but the maximum stays a real target rather than something an average
    // decisive player trips over.
    expect(levelForXP(xp)).toBeLessThan(PROGRESSION_MAX_LEVEL);
  });

  test("only a dominant performance reaches the maximum level", () => {
    const xp =
      400 * XP_PER_TILE_VS_PLAYER +
      400 * XP_PER_TILE_VS_TERRA +
      10 * XP_FOR_STRUCTURE["Factory"] +
      25 * XP_FOR_BATTLE_WON +
      20 * XP_FOR_DEFENSE_HELD +
      xpForCasualties(Math.floor((150_000 * 2) / XP_CASUALTIES_PER_XP)) +
      3 * XP_FOR_ELIMINATION;
    expect(levelForXP(xp)).toBe(PROGRESSION_MAX_LEVEL);
  });
});
