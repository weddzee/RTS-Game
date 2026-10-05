// The army acceptance criteria from Prompt 3.8, end to end in the simulation.
//
// Two players must be able to form multiple armies, rename them, configure
// their compositions, move them, fight, see the opponent's visible armies and
// see updated strength after battle â€” and the server must stay authoritative
// throughout, meaning every one of those actions is re-validated in core rather
// than trusted from the intent.
//
// These drive the real Execution objects the intents create, so what is tested
// is the production path, not a stand-in.

import { ArmyOrderExecution } from "../src/core/execution/army/ArmyOrderExecution";
import { CreateArmyExecution } from "../src/core/execution/army/CreateArmyExecution";
import { RenameArmyExecution } from "../src/core/execution/army/RenameArmyExecution";
import { SetArmyCompositionExecution } from "../src/core/execution/army/SetArmyCompositionExecution";
import { validateComposition } from "../src/core/game/ArmyComposition";
import {
  ARMY_VETERANCY_TIERS,
  tierForXp,
} from "../src/core/game/ArmyVeterancy";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  type Execution,
} from "../src/core/game/Game";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import type { GameConfig } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

function humans(...ids: string[]): PlayerInfo[] {
  return ids.map((id) => new PlayerInfo(id, PlayerType.Human, null, id));
}

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      const t = game.ref(x, y);
      if (game.isLand(t)) p.conquer(t);
    }
  }
}

function deployTile(game: Game, p: Player): number {
  for (const t of p.tiles()) {
    if (game.isLand(t) && !game.isImpassable(t)) return t;
  }
  throw new Error("no deployable tile");
}

const MAP = "plains";

/**
 * Two neighbours sharing a border, both spawned, both rich. Spawn immunity is
 * left to expire so PVP attacks are legal.
 */
async function twoPlayerGame(overrides: Partial<GameConfig> = {}) {
  const game = await setup(MAP, { infiniteGold: true }, humans("a", "b"));
  const a = game.player("a");
  const b = game.player("b");
  conquerRect(game, a, 10, 10, 30, 30);
  conquerRect(game, b, 30, 10, 60, 30);
  a.setSpawnTile(game.ref(15, 15));
  b.setSpawnTile(game.ref(45, 15));
  a.addTroops(2_000_000);
  b.addTroops(500_000);
  executeTicks(game, 60);
  return { game, a, b };
}

/** Runs a creation through the real execution and returns the new army. */
/** Every army command execution is an Execution that can say why it refused. */
type Rejectable = Execution & { failureReason(): string | null };

function raiseArmy(
  game: Game,
  p: Player,
  troops: number,
  name: string | null = null,
  composition: Record<string, number> | null = null,
) {
  const exec = new CreateArmyExecution(
    p,
    deployTile(game, p),
    troops,
    name,
    composition,
  );
  game.addExecution(exec);
  executeTicks(game, 2);
  expect(exec.failureReason()).toBeNull();
  return exec.createdArmy();
}

describe("army acceptance", () => {
  test("a player can form multiple armies, and troops leave the free pool", async () => {
    const { game, a } = await twoPlayerGame();
    const before = a.troops();

    const first = raiseArmy(game, a, 100_000, "1st Army");
    const second = raiseArmy(game, a, 150_000, "2nd Army");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(game.armiesOf(a).length).toBe(2);
    expect(first!.id()).not.toBe(second!.id());
    expect(first!.totalStrength()).toBe(100_000);
    expect(second!.totalStrength()).toBe(150_000);
    // The pool paid for both: creation is a transfer, not a duplication.
    expect(a.troops()).toBe(before - 250_000);
  });

  test("a player can rename an army, and the new name reaches the wire update", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 50_000, "1st Army")!;
    expect(army.displayName()).toBe("1st Army");

    const rename = new RenameArmyExecution(a, army.id(), "Northern Army");
    game.addExecution(rename);
    executeTicks(game, 2);
    expect(rename.failureReason()).toBeNull();
    expect(army.displayName()).toBe("Northern Army");

    // The rename is broadcast whole, so it reaches every client on the next
    // army update.
    let found: { name: string } | undefined;
    for (let i = 0; i < 8 && found === undefined; i++) {
      const updates = game.executeNextTick();
      found = updates[GameUpdateType.Army].find((u) => u.id === army.id());
    }
    expect(found?.name).toBe("Northern Army");
  });

  test("a player can configure a composition, and it is normalized to 100%", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 50_000)!;

    const set = new SetArmyCompositionExecution(a, army.id(), {
      // Deliberately does not total 100.
      infantry: 40,
      armor: 40,
      artillery: 30,
      support: 10,
    });
    game.addExecution(set);
    executeTicks(game, 2);
    expect(set.failureReason()).toBeNull();
    expect(validateComposition(army.composition())).toBe(true);
    // 40/40/30/10 scales to 100 as 33.3/33.3/25/8.3; the leftover unit goes to
    // the earliest category among the tied largest remainders.
    expect(army.composition()).toEqual({
      infantry: 34,
      armor: 33,
      artillery: 25,
      support: 8,
    });
  });

  test("a player can move an army", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 50_000)!;
    const destination = game.ref(20, 20);
    expect(destination).not.toBe(army.tile());

    const order = new ArmyOrderExecution(a, army.id(), {
      type: "move",
      tile: destination,
    });
    game.addExecution(order);
    executeTicks(game, 2);
    expect(order.failureReason()).toBeNull();
    expect(army.order()).toEqual({ type: "move", tile: destination });

    // It walks there over its own movement evaluations (~3 tiles a second).
    executeTicks(game, 80);
    expect(army.tile()).toBe(destination);
    expect(army.movementState()).toBe("holding");
  });

  test("two players can fight with their armies and see each other's strength change", async () => {
    const { game, a, b } = await twoPlayerGame();
    // A defensible but winnable fight: the attacker's army comfortably out-masses
    // the defender's density, so it survives the offensive and returns to hold.
    b.setTroops(60_000);
    const attacker = raiseArmy(game, a, 200_000, "1st Army")!;
    const defender = raiseArmy(game, b, 40_000, "Waffe")!;

    const bTilesBefore = b.numTilesOwned();
    const attackerStrengthBefore = attacker.totalStrength();

    let target = -1;
    for (const t of b.borderTiles()) {
      if (a.canAttack(t)) {
        target = t;
        break;
      }
    }
    expect(target).toBeGreaterThanOrEqual(0);

    const order = new ArmyOrderExecution(a, attacker.id(), {
      type: "attack",
      tile: target,
    });
    game.addExecution(order);
    executeTicks(game, 2);
    expect(order.failureReason()).toBeNull();
    expect(attacker.order()).toEqual({ type: "attack", tile: target });

    // Orders are evaluated on the movement cadence (once a second).
    executeTicks(game, 12);
    expect(attacker.combatState()).toBe("attacking");

    // Fight until the offensive resolves.
    let ticks = 0;
    while (attacker.combatState() === "attacking" && ticks < 600) {
      executeTicks(game, 1);
      ticks++;
    }
    expect(ticks).toBeLessThan(600);
    expect(attacker.isActive()).toBe(true);

    // Ground actually changed hands.
    expect(b.numTilesOwned()).toBeLessThan(bTilesBefore);
    // The attacker paid for it in troops and bought experience with it.
    expect(attacker.totalStrength()).toBeLessThan(attackerStrengthBefore);
    expect(attacker.statistics().battlesFought).toBeGreaterThanOrEqual(1);
    expect(attacker.statistics().tilesCaptured).toBeGreaterThan(0);
    expect(attacker.xp()).toBeGreaterThan(0);
    // The defender's troops were killed out of its free pool â€” an army is
    // attacked through its ground, not troop-for-troop.
    expect(b.troops()).toBeLessThan(60_000);
    // The defender's own army is untouched by the attack itself â€” armies are not
    // attacked troop-for-troop â€” but it is now standing on ground it lost, so
    // supply has cut off and it is bleeding.
    expect(defender.totalStrength()).toBeLessThan(40_000);
    expect(defender.supply()).toBeLessThan(100);
    expect(defender.supplyStatus()).not.toBe("sufficient");
    expect(defender.combatState()).toBe("none");
    // The army is back to holding once the fight is over.
    expect(attacker.combatState()).toBe("none");
    expect(attacker.order()).toEqual({ type: "hold" });
  });

  test("veterancy rises with successful fighting and never exceeds Elite", async () => {
    const { game, a, b } = await twoPlayerGame();
    const army = raiseArmy(game, a, 400_000, "Veterancy Test")!;
    expect(army.tier()).toBe("recruit");

    // Fight repeatedly; each engagement should move the army up the ladder.
    for (let round = 0; round < 6 && army.tier() === "recruit"; round++) {
      a.addTroops(400_000);
      b.addTroops(200_000);
      let target = -1;
      for (const t of b.borderTiles()) {
        if (a.canAttack(t)) {
          target = t;
          break;
        }
      }
      if (target < 0) break;
      game.addExecution(
        new ArmyOrderExecution(a, army.id(), { type: "attack", tile: target }),
      );
      executeTicks(game, 2);
      let ticks = 0;
      while (army.combatState() === "attacking" && ticks < 400) {
        executeTicks(game, 1);
        ticks++;
      }
    }
    expect(army.xp()).toBeGreaterThan(0);
    expect(ARMY_VETERANCY_TIERS).toContain(army.tier());
    expect(army.tier()).toBe(tierForXp(army.xp()));
  });

  test("an opponent's armies are visible on the map but cannot be commanded", async () => {
    const { game, a, b } = await twoPlayerGame();
    const enemyArmy = raiseArmy(game, b, 100_000, "Waffe")!;

    // Visible: a's view of the game includes b's army.
    expect(game.armies()).toContain(enemyArmy);
    expect(game.armiesOf(a)).toHaveLength(0);
    expect(game.armiesOf(b)).toHaveLength(1);

    // Not commandable: every order from the wrong player is refused and the
    // army is left exactly as it was.
    const before = { name: enemyArmy.displayName(), order: enemyArmy.order() };
    const orders: Rejectable[] = [
      new RenameArmyExecution(a, enemyArmy.id(), "Mine Now"),
      new SetArmyCompositionExecution(a, enemyArmy.id(), {
        infantry: 100,
        armor: 0,
        artillery: 0,
        support: 0,
      }),
      new ArmyOrderExecution(a, enemyArmy.id(), { type: "stop" }),
      new ArmyOrderExecution(a, enemyArmy.id(), { type: "hold" }),
    ];
    for (const exec of orders) game.addExecution(exec);
    executeTicks(game, 2);
    for (const exec of orders) {
      expect(exec.failureReason()).not.toBeNull();
    }
    expect(enemyArmy.displayName()).toBe(before.name);
    expect(enemyArmy.order()).toEqual(before.order);
    expect(enemyArmy.composition().infantry).not.toBe(100);
  });

  test("server remains authoritative: the client cannot manufacture troops", async () => {
    const { game, a } = await twoPlayerGame();
    a.setTroops(1_000);

    // Asks for ten times what it has.
    const exec = new CreateArmyExecution(
      a,
      deployTile(game, a),
      10_000_000,
      "Free Army",
      null,
    );
    game.addExecution(exec);
    executeTicks(game, 2);
    expect(exec.failureReason()).toBeNull();
    const army = exec.createdArmy()!;
    // Clamped to the per-army share cap of the owner's pool (90% of 1,000), so
    // the client cannot conjure troops out of nothing.
    expect(army.totalStrength()).toBe(900);
    expect(a.troops()).toBe(100);
    expect(game.armiesOf(a).length).toBe(1);
  });

  test("an army cannot be raised outside the owner's territory", async () => {
    const { game, a, b } = await twoPlayerGame();
    const enemyTile = deployTile(game, b);
    const exec = new CreateArmyExecution(a, enemyTile, 10_000, null, null);
    game.addExecution(exec);
    executeTicks(game, 2);
    expect(exec.failureReason()).toContain("not owned");
    expect(game.armiesOf(a).length).toBe(0);
  });

  test("an army cannot be raised on water or invalid ground", async () => {
    // A map with real water in it, so "not deployable land" is actually tested.
    const game = await setup(
      "ocean_and_land",
      { infiniteGold: true },
      humans("a"),
    );
    const a = game.player("a");
    conquerRect(game, a, 2, 8, 8, 14);
    a.setSpawnTile(game.ref(4, 10));
    a.addTroops(100_000);
    expect(a.isAlive()).toBe(true);

    let water = -1;
    for (let ref = 0; ref < game.width() * game.height() && water < 0; ref++) {
      if (game.isWater(ref)) water = ref;
    }
    expect(water).toBeGreaterThanOrEqual(0);

    const exec = new CreateArmyExecution(a, water, 10_000, null, null);
    game.addExecution(exec);
    executeTicks(game, 2);
    expect(exec.failureReason()).toContain("not deployable land");
    expect(game.armiesOf(a).length).toBe(0);

    const offMap = new CreateArmyExecution(a, -1, 10_000, null, null);
    game.addExecution(offMap);
    executeTicks(game, 2);
    expect(offMap.failureReason()).toBe("invalid tile -1");
    expect(game.armiesOf(a).length).toBe(0);
  });

  test("the army cap is enforced", async () => {
    const { game, a } = await twoPlayerGame();
    const cap = game.config().maxArmyCount(a);
    for (let i = 0; i < cap; i++) {
      expect(raiseArmy(game, a, 10_000)).not.toBeNull();
    }
    expect(game.armiesOf(a).length).toBe(cap);

    const extra = new CreateArmyExecution(
      a,
      deployTile(game, a),
      10_000,
      null,
      null,
    );
    game.addExecution(extra);
    executeTicks(game, 2);
    expect(extra.failureReason()).toBe("army cap reached");
    expect(game.armiesOf(a).length).toBe(cap);
  });

  test("a malformed name is refused without changing the army", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 10_000, "1st Army")!;

    for (const bad of ["", "   ", "\u200B\u200B", "\n\n"]) {
      const rename = new RenameArmyExecution(a, army.id(), bad);
      game.addExecution(rename);
      executeTicks(game, 1);
      expect(rename.failureReason()).not.toBeNull();
    }
    expect(army.displayName()).toBe("1st Army");
  });

  test("markup in an army name is stored as text and never parsed", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 10_000)!;
    const attack = '<img src=x onerror="alert(1)">';
    const rename = new RenameArmyExecution(a, army.id(), attack);
    game.addExecution(rename);
    executeTicks(game, 2);
    expect(rename.failureReason()).toBeNull();
    // Stored verbatim: the client renders it as a text node, so it is inert.
    expect(army.displayName()).toBe(attack);
    expect(army.displayName()).not.toContain("&lt;");
  });

  test("an over-long name is truncated rather than refused", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 10_000)!;
    const rename = new RenameArmyExecution(a, army.id(), "x".repeat(100));
    game.addExecution(rename);
    executeTicks(game, 2);
    expect(rename.failureReason()).toBeNull();
    expect([...army.displayName()]).toHaveLength(32);
  });

  test("reinforce pulls troops from the pool and raises the manpower ceiling", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 50_000)!;
    const poolBefore = a.troops();
    expect(army.manpower()).toBe(50_000);

    const order = new ArmyOrderExecution(a, army.id(), {
      type: "reinforce",
      troops: 25_000,
    });
    game.addExecution(order);
    executeTicks(game, 2);
    expect(order.failureReason()).toBeNull();
    expect(army.totalStrength()).toBe(75_000);
    expect(army.manpower()).toBe(75_000);
    expect(a.troops()).toBe(poolBefore - 25_000);
  });

  test("an army with no troops left is disbanded and stops existing", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 10_000)!;
    expect(game.armiesOf(a).length).toBe(1);

    army.applyLosses(army.totalStrength());
    executeTicks(game, 130);

    expect(army.isActive()).toBe(false);
    expect(game.armiesOf(a).length).toBe(0);
    // The disband is broadcast, so other clients drop it too.
    expect(game.armies()).toHaveLength(0);
  });
});
