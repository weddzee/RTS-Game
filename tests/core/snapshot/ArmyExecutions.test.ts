// Snapshot round-trips for the army executions (Prompt 3).
//
// The full-game oracle in FullGameSnapshot.test.ts covers armies incidentally;
// this file pins the states that are easy to get wrong — an army mid-move, one
// mid-offensive, one with a front — at the tick boundaries where a snapshot can
// actually catch them.

import { ArmyOrderExecution } from "../../../src/core/execution/army/ArmyOrderExecution";
import { CreateArmyExecution } from "../../../src/core/execution/army/CreateArmyExecution";
import { RenameArmyExecution } from "../../../src/core/execution/army/RenameArmyExecution";
import { SetArmyCompositionExecution } from "../../../src/core/execution/army/SetArmyCompositionExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

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

const MAP = "plains";

/** Two neighbours with a contested border between them, both with troops. */
async function armyGame() {
  const game = await setup(MAP, { infiniteGold: true }, humans("a", "b"));
  const a = game.player("a");
  const b = game.player("b");
  conquerRect(game, a, 10, 10, 30, 30);
  conquerRect(game, b, 30, 10, 60, 30);
  // Armies can only be raised by a player who has spawned; setup() gives the
  // players territory without going through SpawnExecution.
  a.setSpawnTile(game.ref(15, 15));
  b.setSpawnTile(game.ref(45, 15));
  a.addTroops(500_000);
  b.addTroops(100_000);
  // Spawn immunity blocks PVP for the first few seconds; an offensive order
  // needs it gone.
  executeTicks(game, 60);
  return { game, a, b };
}

/** An owned, land tile to raise an army on. */
function deployTile(game: Game, p: Player): number {
  for (const t of p.tiles()) {
    if (game.isLand(t) && !game.isImpassable(t)) return t;
  }
  throw new Error("no deployable tile");
}

describe("snapshot: armies", () => {
  test("pending creation, then a raised and renamed army", async () => {
    const { game, a } = await armyGame();
    game.addExecution(
      new CreateArmyExecution(a, deployTile(game, a), 10_000, null, null),
    );
    // Still queued: init has not run, so the request itself is in the snapshot.
    await expectSnapshotRoundTrip(game, MAP, 1);
    executeTicks(game, 2);
    expect(game.armies().length).toBe(1);

    game.addExecution(
      new RenameArmyExecution(a, game.armies()[0].id(), "Northern Army"),
      new SetArmyCompositionExecution(a, game.armies()[0].id(), {
        infantry: 25,
        armor: 55,
        artillery: 10,
        support: 10,
      }),
    );
    await expectSnapshotRoundTrip(game, MAP, 20);
    expect(game.armies()[0].displayName()).toBe("Northern Army");
  });

  test("an army mid-move and one holding a front", async () => {
    const { game, a } = await armyGame();
    const home = deployTile(game, a);
    game.addExecution(new CreateArmyExecution(a, home, 20_000, null, null));
    executeTicks(game, 2);
    const army = game.armies()[0];

    game.addExecution(
      new ArmyOrderExecution(a, army.id(), {
        type: "createFront",
        tile: home,
      }),
    );
    game.addExecution(
      new ArmyOrderExecution(a, army.id(), { type: "move", tile: home }),
    );
    // Caught between the order and the next movement evaluation.
    await expectSnapshotRoundTrip(game, MAP, 12);
    expect(game.fronts().length).toBe(1);

    executeTicks(game, 25);
    // Caught mid-move, with supply and organization partially recovered.
    await expectSnapshotRoundTrip(game, MAP, 60);
  });

  test("an army mid-offensive, running the ordinary attack loop", async () => {
    const { game, a, b } = await armyGame();
    const home = deployTile(game, a);
    game.addExecution(new CreateArmyExecution(a, home, 20_000, null, null));
    executeTicks(game, 2);
    const army = game.armies()[0];

    // A border tile of b, adjacent to a's land.
    let target = -1;
    for (const t of b.borderTiles()) {
      if (a.canAttack(t)) {
        target = t;
        break;
      }
    }
    expect(target).toBeGreaterThanOrEqual(0);
    game.addExecution(
      new ArmyOrderExecution(a, army.id(), { type: "attack", tile: target }),
    );
    // Let it walk over and open the offensive.
    executeTicks(game, 20);
    expect(army.combatState()).toBe("attacking");
    // Mid-conquest: the AttackExecution owns the troops.
    await expectSnapshotRoundTrip(game, MAP, 10);
    expect(army.combatState()).toBe("attacking");
    expect(a.outgoingAttacks().some((at) => at.attacker() === a)).toBe(true);
  });

  test("an army that ran out of troops disbands", async () => {
    const { game, a } = await armyGame();
    const home = deployTile(game, a);
    game.addExecution(new CreateArmyExecution(a, home, 20_000, null, null));
    executeTicks(game, 2);
    const army = game.armies()[0];
    expect(game.armies().length).toBe(1);

    // Wipe the force out: upkeep then disbands the army once it has been below
    // the minimum strength for the disband window.
    army.applyLosses(army.totalStrength());
    await expectSnapshotRoundTrip(game, MAP, 130);
    // The round trip ticks the restored copy; tick this one too so the
    // disband has actually happened here.
    executeTicks(game, 130);
    expect(game.armies().length).toBe(0);
  });
});
