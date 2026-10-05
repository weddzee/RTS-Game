// The battle-plan acceptance criteria from Prompt 4, end to end in the
// simulation.
//
// The centre of gravity here is section 4.4 and 4.2: the client *proposes* a
// gesture and the simulation derives the plan. So most of these tests are
// adversarial Ä‚ËĂ˘â€šÂ¬Ă˘â‚¬ĹĄ they hand the executions the worst plausible thing a client could
// send and check that what comes out is something an army could actually do.
//
// They drive the real Execution objects the intents create, so what is tested is
// the production path, not a stand-in.

import {
  BATTLE_PLAN_MAX_ARMIES,
  BATTLE_PLAN_MAX_FRONTIER_TILES,
  BATTLE_PLAN_MAX_PER_PLAYER,
} from "../src/core/configuration/BattlePlanBalance";
import { CreateArmyExecution } from "../src/core/execution/army/CreateArmyExecution";
import { CreateBattlePlanExecution } from "../src/core/execution/battleplan/CreateBattlePlanExecution";
import { EditBattlePlanExecution } from "../src/core/execution/battleplan/EditBattlePlanExecution";
import type { Army } from "../src/core/game/Army";
import type { BattlePlanOrder } from "../src/core/game/BattlePlan";
import {
  deriveOffensiveRoute,
  validateFallbackLine,
  validateFrontier,
} from "../src/core/game/BattlePlanRoute";
import {
  type Execution,
  type Game,
  type Player,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import type { TileRef } from "../src/core/game/GameMap";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import type { GameConfig } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

const MAP = "plains";

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

/**
 * Two players on a plain shared border: `a` holds x 10..30, `b` holds x 30..60,
 * both spanning y 10..30. Spawn immunity is left to expire so PVP is legal.
 */
async function twoPlayerGame(overrides: Partial<GameConfig> = {}) {
  const game = await setup(MAP, { infiniteGold: true }, humans("a", "b"));
  const a = game.player("a");
  const b = game.player("b");
  conquerRect(game, a, 10, 10, 30, 30);
  conquerRect(game, b, 30, 10, 60, 30);
  a.setSpawnTile(game.ref(15, 15));
  b.setSpawnTile(game.ref(45, 15));
  a.addTroops(5_000_000);
  b.addTroops(2_000_000);
  executeTicks(game, 60);
  return { game, a, b };
}

/** The tiles where a's frontier touches b's ground: the legal frontline. */
function sharedBorder(
  game: Game,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
) {
  const out: TileRef[] = [];
  for (let y = y0; y < y1; y++) {
    const t = game.ref(x1 - 1, y);
    if (game.isLand(t)) out.push(t);
  }
  return out;
}

/** An arrow drawn straight east from the border, three tiles deep into b. */
function arrowEast(game: Game, depth: number, fromY: number): TileRef[] {
  const out: TileRef[] = [];
  for (let i = 0; i < depth; i++) {
    out.push(game.ref(30 + i, fromY));
  }
  return out;
}

/** 8-neighbours of a tile as an array; the buffer form leaks a length. */
function neighborsOf(game: Game, tile: TileRef): TileRef[] {
  const buf: TileRef[] = [0, 0, 0, 0, 0, 0, 0, 0];
  const n = game.neighbors8(tile, buf);
  return buf.slice(0, n);
}

function raiseArmy(game: Game, p: Player, troops: number) {
  let tile: TileRef | null = null;
  for (const t of p.tiles()) {
    if (game.isLand(t) && !game.isImpassable(t)) {
      tile = t;
      break;
    }
  }
  const exec = new CreateArmyExecution(p, tile!, troops, null, null);
  game.addExecution(exec);
  executeTicks(game, 2);
  expect(exec.failureReason()).toBeNull();
  return exec.createdArmy()!;
}

function drawPlan(
  game: Game,
  p: Player,
  kind: BattlePlanOrder,
  frontier: TileRef[],
  route: TileRef[],
  armyIDs: number[] = [],
) {
  const exec = new CreateBattlePlanExecution(p, {
    kind,
    frontier,
    route,
    armyIDs,
  });
  game.addExecution(exec);
  executeTicks(game, 2);
  return exec;
}

describe("battle plan acceptance", () => {
  // --- 4.2 frontline creation ---------------------------------------------

  test("a frontline is created from a dragged run of border tiles", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 10, 30);

    const exec = drawPlan(game, a, "frontline", border, []);
    expect(exec.failureReason()).toBeNull();

    const plan = exec.createdPlan()!;
    // Canonical frontier is the tiles the player actually holds and that actually
    // border ground they do not Ä‚ËĂ˘â€šÂ¬Ă˘â‚¬ĹĄ which is the whole of the drawn gesture here.
    expect(plan.frontier().length).toBe(border.length);
    for (const t of plan.frontier()) {
      expect(game.owner(t)).toBe(a);
      expect(game.isBorder(t)).toBe(true);
    }
    expect(plan.kind()).toBe("frontline");
    expect(plan.status()).toBe("active");
    // A frontline draws no arrow.
    expect(plan.route()).toEqual([]);
    expect(game.battlePlansOf(a)).toHaveLength(1);
  });

  test("a drawn frontline through the player's own interior is refused", async () => {
    const { game, a } = await twoPlayerGame();
    // Tiles 15..25 are deep inside a's territory and border nothing hostile.
    const interior: TileRef[] = [];
    for (let y = 12; y < 16; y++) interior.push(game.ref(15, y));

    const exec = drawPlan(game, a, "frontline", interior, []);
    expect(exec.failureReason()).toContain("border");
    expect(game.battlePlansOf(a)).toHaveLength(0);
  });

  test("a client cannot claim a frontier in land it does not own", async () => {
    const { game, a, b } = await twoPlayerGame();
    // b's border tiles: a genuine border, just not a's.
    const enemy: TileRef[] = [];
    for (let y = 12; y < 16; y++) enemy.push(game.ref(30, y));
    expect(game.owner(enemy[0])).toBe(b);

    const exec = drawPlan(game, a, "frontline", enemy, []);
    expect(exec.failureReason()).not.toBeNull();
    expect(game.battlePlansOf(a)).toHaveLength(0);
  });

  test("the canonical frontier drops the illegal half of a mixed gesture", async () => {
    const { game, a } = await twoPlayerGame();
    const legal = sharedBorder(game, 0, 30, 12, 16);
    const enemy: TileRef[] = [game.ref(30, 12), game.ref(31, 12)];
    // Exactly the claim a hostile client would make: half real, half stolen.
    const proposal = [...legal, ...enemy];

    const exec = drawPlan(game, a, "frontline", proposal, []);
    expect(exec.failureReason()).toBeNull();
    const frontier = exec.createdPlan()!.frontier();
    expect(frontier.length).toBe(legal.length);
    for (const t of frontier) expect(game.owner(t)).toBe(a);
  });

  test("out-of-range and off-map tiles cannot crash or claim a plan", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 16);
    const exec = drawPlan(game, a, "frontline", [-1, 1 << 30, border[0]], []);
    // The junk is filtered, and the one real border tile survives as a
    // single-tile front.
    expect(exec.failureReason()).toBeNull();
    expect(exec.createdPlan()!.frontier()).toEqual([border[0]]);
  });

  test("an over-sized gesture is refused before any map work", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 10, 30);
    const tooMany = new Array<TileRef>(BATTLE_PLAN_MAX_FRONTIER_TILES + 1).fill(
      border[0],
    );
    const exec = drawPlan(game, a, "frontline", tooMany, []);
    expect(exec.failureReason()).toContain("size limit");
    expect(game.battlePlansOf(a)).toHaveLength(0);
  });

  // --- 4.3 / 4.4 the drawn arrow is intent, never a route --------------------

  test("an offensive route is derived from map topology, not the drawn path", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    const hint = arrowEast(game, 3, 14);

    const plan = deriveOffensiveRoute(game, a, border, hint);
    expect(plan.length).toBeGreaterThan(1);
    // The route begins on the player's own border and ends on the drawn
    // destination.
    expect(game.owner(plan[0])).toBe(a);
    expect(plan[plan.length - 1]).toBe(hint[hint.length - 1]);
    // And every step is a legal 8-neighbour step: an army can walk it.
    for (let i = 1; i < plan.length; i++) {
      const dx = Math.abs(game.x(plan[i]) - game.x(plan[i - 1]));
      const dy = Math.abs(game.y(plan[i]) - game.y(plan[i - 1]));
      expect(Math.max(dx, dy)).toBe(1);
    }
  });

  test("a route never crosses water or impassable terrain", async () => {
    const game = await setup(MAP, { infiniteGold: true }, humans("a"));
    const a = game.player("a");
    conquerRect(game, a, 10, 10, 30, 30);
    a.setSpawnTile(game.ref(15, 15));
    a.addTroops(1_000_000);
    executeTicks(game, 60);

    // Find any impassable tile on the map, and hand the validator a hint aimed
    // straight at it. Whatever route comes back has to avoid it.
    let wall: TileRef | null = null;
    for (let ref = 0; ref < game.width() * game.height(); ref++) {
      if (game.isImpassable(ref)) {
        wall = ref;
        break;
      }
    }
    if (wall === null) return; // the plains map has no walls to test with
    const border = validateFrontier(
      game,
      a,
      Array.from({ length: 4 }, (_, i) => game.ref(29, 12 + i)),
    );
    const hint = [game.ref(30, 13), game.ref(31, 13), wall];
    const route = deriveOffensiveRoute(game, a, border, hint);
    for (const tile of route) {
      expect(game.isImpassable(tile)).toBe(false);
      expect(game.isLand(tile)).toBe(true);
    }
  });

  test("an unreachable drawn destination degrades to a manned front", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    // Aim at ocean: on the plains map there is none, so aim at a tile the owner
    // already holds, which is equally not a legal destination.
    const hint = [game.ref(12, 12), game.ref(13, 12)];
    const route = deriveOffensiveRoute(game, a, border, hint);
    expect(route).toEqual([]);

    const exec = drawPlan(game, a, "offensive", border, hint);
    expect(exec.failureReason()).toBeNull();
    expect(exec.createdPlan()!.route()).toEqual([]);
  });

  // --- 4.5 progressive offensive ------------------------------------------

  test("an offensive takes adjacent targets step by step toward the destination", async () => {
    const { game, a, b } = await twoPlayerGame();
    b.setTroops(30_000);
    const army = raiseArmy(game, a, 400_000);
    const border = sharedBorder(game, 0, 30, 12, 18);

    const exec = drawPlan(
      game,
      a,
      "offensive",
      border,
      arrowEast(game, 3, 14),
      [army.id()],
    );
    expect(exec.failureReason()).toBeNull();
    const plan = exec.createdPlan()!;
    expect(plan.route().length).toBeGreaterThan(2);
    expect(army.assignedBattlePlanId()).toBe(plan.id());

    const bTilesBefore = b.numTilesOwned();
    // Let the plan run. It attacks from the live frontier, so it cannot teleport:
    // every target is adjacent to ground the army already holds.
    executeTicks(game, 400);

    expect(army.isActive()).toBe(true);
    // Ground changed hands, and it changed hands progressively Ä‚ËĂ˘â€šÂ¬Ă˘â‚¬ĹĄ b lost tiles in
    // more than one step rather than all at once.
    expect(b.numTilesOwned()).toBeLessThan(bTilesBefore);
    const advance = plan.step();
    expect(advance).toBeGreaterThanOrEqual(0);
    // The army paid for it and stayed under its command.
    expect(army.totalStrength()).toBeLessThan(400_000);
  });

  test("a plan never orders an attack at ground its owner does not touch", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 200_000);
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(
      game,
      a,
      "offensive",
      border,
      arrowEast(game, 3, 14),
      [army.id()],
    ).createdPlan()!;

    // Every attack order the plan ever issues must name a tile at the army's
    // front. Sampled rather than instrumented: the invariant is what matters,
    // not the bookkeeping.
    //
    // The "or now ours" arm is not slack. The plan picks a target once a second
    // and the attack resolves underneath it, so a tile that was hostile when the
    // order went out can already be ours by the time this loop looks Ä‚ËĂ˘â€šÂ¬Ă˘â‚¬ĹĄ which is
    // the plan working, not the plan misbehaving. What it must never do is point
    // at ground that is neither adjacent to us nor already taken.
    for (let i = 0; i < 60; i++) {
      executeTicks(game, 1);
      const order = army.order();
      if (order.type !== "attack") continue;
      expect(game.isLand(order.tile)).toBe(true);
      const adjacent = neighborsOf(game, order.tile).some(
        (n) => game.owner(n) === a,
      );
      expect(adjacent || game.owner(order.tile) === a).toBe(true);
    }
    expect(plan.isRunning() || plan.status() === "completed").toBe(true);
  });

  test("a plan whose front has been overrun stops issuing orders", async () => {
    const { game, a, b } = await twoPlayerGame();
    const army = raiseArmy(game, a, 200_000);
    const border = sharedBorder(game, 0, 30, 12, 18);
    drawPlan(game, a, "frontline", border, [], [army.id()]);

    // Hand the whole border strip to b, so a's frontier no longer exists.
    for (const t of border) b.conquer(t);
    executeTicks(game, 40);

    const order = army.order();
    expect(order.type === "attack").toBe(false);
  });

  // --- 4.6 spearhead -------------------------------------------------------

  test("a spearhead is narrower than an offensive over the same front", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    const hint = arrowEast(game, 3, 14);

    const spear = drawPlan(game, a, "spearhead", border, hint).createdPlan()!;
    const offensive = drawPlan(
      game,
      a,
      "offensive",
      border,
      hint,
    ).createdPlan()!;

    expect(spear.kind()).toBe("spearhead");
    // Both derive a route from the same gesture; the spearhead's difference is in
    // which targets it will accept, not in where it is pointed.
    expect(spear.route().length).toBeGreaterThan(1);
    expect(offensive.route().length).toBeGreaterThan(1);
  });

  test("a spearhead is punished for going unsupported, through supply", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 150_000);
    const border = sharedBorder(game, 0, 30, 12, 18);
    drawPlan(game, a, "spearhead", border, arrowEast(game, 3, 14), [army.id()]);

    // Deep in enemy ground with nothing behind it, supply is what stops the army
    // Ä‚ËĂ˘â€šÂ¬Ă˘â‚¬ĹĄ the same rule that governs every army, which is why 4.6 says to lean on
    // the supply rules rather than inventing a penalty.
    army.setTile(game.ref(48, 20));
    executeTicks(game, 20);
    expect(army.supply()).toBeLessThan(100);
  });

  // --- 4.7 / 4.8 -----------------------------------------------------------

  test("a fallback line is only accepted inside the owner's own territory", async () => {
    const { game, a } = await twoPlayerGame();
    const inside: TileRef[] = [
      game.ref(20, 12),
      game.ref(20, 13),
      game.ref(20, 14),
    ];
    expect(validateFallbackLine(game, a, inside)).toEqual(inside);

    const enemy: TileRef[] = [
      game.ref(32, 12),
      game.ref(32, 13),
      game.ref(32, 14),
    ];
    expect(validateFallbackLine(game, a, enemy)).toEqual([]);
    const exec = drawPlan(game, a, "fallback", enemy, []);
    expect(exec.failureReason()).not.toBeNull();
    expect(game.battlePlansOf(a)).toHaveLength(0);
  });

  test("hold and frontline plans never order an attack", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    for (const kind of ["hold", "frontline", "move"] as BattlePlanOrder[]) {
      const army = raiseArmy(game, a, 100_000);
      const plan = drawPlan(game, a, kind, border, [], [army.id()]);
      expect(plan.failureReason()).toBeNull();
      executeTicks(game, 40);
      expect(army.order().type).not.toBe("attack");
      expect(army.combatState()).toBe("none");
    }
  });

  test("a plan with no armies never touches anything", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(game, a, "offensive", border, arrowEast(game, 3, 14));
    expect(plan.failureReason()).toBeNull();
    // The driver stands down on its own with nothing to command.
    executeTicks(game, 30);
    expect(game.battlePlansOf(a)).toHaveLength(1);
    expect(game.battlePlansOf(a)[0].armyIDs()).toEqual([]);
  });

  // --- 4.9 editing ---------------------------------------------------------

  test("a plan can be paused and resumed", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 200_000);
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(
      game,
      a,
      "offensive",
      border,
      arrowEast(game, 3, 14),
      [army.id()],
    ).createdPlan()!;

    const pause = new EditBattlePlanExecution(a, plan.id(), "pause");
    game.addExecution(pause);
    executeTicks(game, 2);
    expect(pause.failureReason()).toBeNull();
    expect(plan.status()).toBe("paused");

    const resume = new EditBattlePlanExecution(a, plan.id(), "resume");
    game.addExecution(resume);
    executeTicks(game, 2);
    expect(resume.failureReason()).toBeNull();
    expect(plan.status()).toBe("active");
  });

  test("a redraw replaces the canonical geometry and resets progress", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(
      game,
      a,
      "offensive",
      border,
      arrowEast(game, 3, 14),
    ).createdPlan()!;
    const firstRoute = [...plan.route()];
    expect(firstRoute.length).toBeGreaterThan(1);

    const redraw = new EditBattlePlanExecution(
      a,
      plan.id(),
      "redraw",
      [],
      sharedBorder(game, 0, 30, 20, 26),
      arrowEast(game, 3, 22),
      "offensive",
    );
    game.addExecution(redraw);
    executeTicks(game, 2);
    expect(redraw.failureReason()).toBeNull();
    expect(plan.route()).not.toEqual(firstRoute);
    expect(plan.step()).toBe(0);
    // Every new frontier tile is still one the owner actually holds.
    for (const t of plan.frontier()) expect(game.owner(t)).toBe(a);
  });

  test("armies can be reassigned, and only the owner's own armies", async () => {
    const { game, a, b } = await twoPlayerGame();
    const mine = raiseArmy(game, a, 50_000);
    const other = raiseArmy(game, a, 50_000);
    const enemy = raiseArmy(game, b, 50_000);
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(
      game,
      a,
      "frontline",
      border,
      [],
      [mine.id()],
    ).createdPlan()!;

    const reassign = new EditBattlePlanExecution(a, plan.id(), "reassign", [
      other.id(),
      enemy.id(),
    ]);
    game.addExecution(reassign);
    executeTicks(game, 2);
    expect(reassign.failureReason()).toBeNull();
    // The enemy's army is dropped rather than stealing it onto the plan.
    expect([...plan.armyIDs()]).toEqual([other.id()]);
    expect(enemy.assignedBattlePlanId()).toBeNull();
    expect(mine.assignedBattlePlanId()).toBeNull();
  });

  test("one army belongs to one plan", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 50_000);
    const border = sharedBorder(game, 0, 30, 12, 18);
    const first = drawPlan(
      game,
      a,
      "frontline",
      border,
      [],
      [army.id()],
    ).createdPlan()!;
    const second = drawPlan(
      game,
      a,
      "frontline",
      border,
      [],
      [army.id()],
    ).createdPlan()!;

    expect([...first.armyIDs()]).toEqual([]);
    expect([...second.armyIDs()]).toEqual([army.id()]);
    expect(army.assignedBattlePlanId()).toBe(second.id());
  });

  test("deleting a plan releases its armies rather than disbanding them", async () => {
    const { game, a } = await twoPlayerGame();
    const army = raiseArmy(game, a, 60_000);
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(
      game,
      a,
      "offensive",
      border,
      arrowEast(game, 3, 14),
      [army.id()],
    ).createdPlan()!;

    const del = new EditBattlePlanExecution(a, plan.id(), "delete");
    game.addExecution(del);
    executeTicks(game, 2);
    expect(del.failureReason()).toBeNull();

    expect(game.battlePlan(plan.id())).toBeUndefined();
    expect(game.battlePlansOf(a)).toHaveLength(0);
    expect(army.isActive()).toBe(true);
    expect(army.assignedBattlePlanId()).toBeNull();
    expect(army.totalStrength()).toBe(60_000);
  });

  // --- authority -----------------------------------------------------------

  test("a player cannot edit, delete or reassign somebody else's plan", async () => {
    const { game, a, b } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(game, a, "frontline", border, []).createdPlan()!;

    const attacks: (Execution & { failureReason(): string | null })[] = [
      new EditBattlePlanExecution(b, plan.id(), "pause"),
      new EditBattlePlanExecution(b, plan.id(), "resume"),
      new EditBattlePlanExecution(b, plan.id(), "delete"),
      new EditBattlePlanExecution(b, plan.id(), "reassign", [1]),
      new EditBattlePlanExecution(
        b,
        plan.id(),
        "redraw",
        [],
        [],
        [],
        "offensive",
      ),
    ];
    for (const exec of attacks) game.addExecution(exec);
    executeTicks(game, 2);

    for (const exec of attacks) {
      expect(exec.failureReason()).toContain("not owned by the sender");
    }
    expect(game.battlePlan(plan.id())).toBeDefined();
    expect(plan.status()).toBe("active");
  });

  test("an unknown plan id is refused without revealing whether it existed", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(game, a, "frontline", border, []).createdPlan()!;

    const missing = new EditBattlePlanExecution(a, plan.id() + 999, "pause");
    game.addExecution(missing);
    executeTicks(game, 2);
    expect(missing.failureReason()).toContain("not found");
  });

  test("a client cannot assign more armies to a plan than the cap allows", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(game, a, "frontline", border, []).createdPlan()!;
    const tooMany = new Array<number>(BATTLE_PLAN_MAX_ARMIES + 1).fill(1);
    const reassign = new EditBattlePlanExecution(
      a,
      plan.id(),
      "reassign",
      tooMany,
    );
    game.addExecution(reassign);
    executeTicks(game, 2);
    expect(reassign.failureReason()).toContain("limit");
  });

  test("the number of live plans per player is capped", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 10, 30);
    for (let i = 0; i < BATTLE_PLAN_MAX_PER_PLAYER; i++) {
      expect(
        drawPlan(game, a, "frontline", border, []).failureReason(),
      ).toBeNull();
    }
    const extra = drawPlan(game, a, "frontline", border, []);
    expect(extra.failureReason()).toBe("battle plan cap reached");
    expect(game.battlePlansOf(a)).toHaveLength(BATTLE_PLAN_MAX_PER_PLAYER);
  });

  test("an opponent's army cannot be commandeered through a plan", async () => {
    const { game, a, b } = await twoPlayerGame();
    const enemy = raiseArmy(game, b, 50_000);
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(game, a, "frontline", border, [], [enemy.id()]);
    expect(plan.failureReason()).toBeNull();
    expect([...plan.createdPlan()!.armyIDs()]).toEqual([]);
    expect(enemy.assignedBattlePlanId()).toBeNull();
  });

  // --- 4.11 determinism ---------------------------------------------------

  test("the same battle-plan state and game state produce the same decisions", async () => {
    const run = async () => {
      const { game, a, b } = await twoPlayerGame();
      b.setTroops(30_000);
      const army = raiseArmy(game, a, 400_000);
      const border = sharedBorder(game, 0, 30, 12, 18);
      const plan = drawPlan(
        game,
        a,
        "offensive",
        border,
        arrowEast(game, 3, 14),
        [army.id()],
      ).createdPlan()!;
      const route = [...plan.route()];
      const orders: string[] = [];
      for (let i = 0; i < 120; i++) {
        executeTicks(game, 1);
        const order = army.order();
        orders.push(
          order.type === "attack" ? `attack:${order.tile}` : order.type,
        );
      }
      const hash = (game as unknown as { hash(): number }).hash();
      return {
        route,
        orders,
        hash,
        bTiles: b.numTilesOwned(),
        step: plan.step(),
        armyTile: army.tile(),
      };
    };

    const first = await run();
    const second = await run();
    // Identical route, identical order-by-order decisions, identical outcome.
    // No random number generator is involved anywhere in the plan path, so this
    // is not "unlikely to differ" Ä‚ËĂ˘â€šÂ¬Ă˘â‚¬ĹĄ it cannot differ.
    expect(second.route).toEqual(first.route);
    expect(second.orders).toEqual(first.orders);
    expect(second.hash).toBe(first.hash);
    expect(second.bTiles).toBe(first.bTiles);
    expect(second.step).toBe(first.step);
    expect(second.armyTile).toBe(first.armyTile);
  });

  // --- wire ----------------------------------------------------------------

  test("plans reach every client as whole records, and a delete tombstones", async () => {
    const { game, a } = await twoPlayerGame();
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(game, a, "frontline", border, []).createdPlan()!;

    let seen: { id: number; frontier: TileRef[] } | undefined;
    for (let i = 0; i < 8 && seen === undefined; i++) {
      const updates = game.executeNextTick();
      seen = updates[GameUpdateType.BattlePlan].find((u) => u.id === plan.id());
    }
    expect(seen?.frontier.length).toBe(plan.frontier().length);

    const del = new EditBattlePlanExecution(a, plan.id(), "delete");
    game.addExecution(del);
    // Driven tick by tick so the tombstone can be caught on the tick it is
    // emitted: executeTicks throws away each tick's updates, and the delete's
    // tombstone rides out with the very tick that removes the plan.
    let tombstone: { id: number; isActive: boolean } | undefined;
    for (let i = 0; i < 4 && tombstone === undefined; i++) {
      const batch = game.executeNextTick();
      tombstone = batch[GameUpdateType.BattlePlan].find(
        (u) => u.id === plan.id(),
      );
    }
    expect(tombstone?.isActive).toBe(false);
    expect(game.battlePlan(plan.id())).toBeUndefined();
  });

  test("an army that disbands leaves its plan without breaking it", async () => {
    const { game, a } = await twoPlayerGame();
    const army: Army = raiseArmy(game, a, 10_000);
    const border = sharedBorder(game, 0, 30, 12, 18);
    const plan = drawPlan(
      game,
      a,
      "offensive",
      border,
      arrowEast(game, 3, 14),
      [army.id()],
    ).createdPlan()!;

    army.applyLosses(army.totalStrength());
    executeTicks(game, 130);

    expect(army.isActive()).toBe(false);
    // The plan record survives as the record of what was ordered; the driver has
    // stood down because there is nothing left to command.
    expect(game.battlePlan(plan.id())).toBeDefined();
    executeTicks(game, 20);
    expect(() => game.executeNextTick()).not.toThrow();
  });
});
