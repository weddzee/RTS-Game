import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  AllPlayers,
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  UnitType,
} from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { GameMapLoader, MapData } from "../../src/core/game/GameMapLoader";
import {
  ErrorUpdate,
  GameUpdateViewData,
} from "../../src/core/game/GameUpdates";
import { MapManifest } from "../../src/core/game/TerrainMapLoader";
import {
  createGameRunner,
  createGameRunnerFromSnapshot,
  GameRunner,
} from "../../src/core/GameRunner";
import { PseudoRandom } from "../../src/core/PseudoRandom";
import {
  GameConfig,
  GameStartInfo,
  Intent,
  StampedIntent,
  Turn,
} from "../../src/core/Schemas";
import { flattenedEmojiTable } from "../../src/core/Util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serves one directory of tests/testdata/maps for whatever map type the game
 * config names, so the real createGameRunner pipeline can run on test maps.
 */
export class TestDataMapLoader implements GameMapLoader {
  constructor(private mapName: string) {}

  getMapData(): MapData {
    const dir = path.join(__dirname, `../testdata/maps/${this.mapName}`);
    const read = (name: string) => async () =>
      new Uint8Array(fs.readFileSync(path.join(dir, name)));
    return {
      mapBin: read("map.bin"),
      map4xBin: read("map4x.bin"),
      map16xBin: read("map16x.bin"),
      manifest: async () =>
        JSON.parse(
          fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
        ) as MapManifest,
      webpPath: path.join(dir, "thumbnail.webp"),
      layerPng: async () => {
        throw new Error("no layers in test maps");
      },
    };
  }
}

export const SCRIPTED_HUMANS = ["HUMAN001", "HUMAN002", "HUMAN003"] as const;

export function scriptedGameStart(
  overrides: Partial<GameConfig> = {},
): GameStartInfo {
  return {
    gameID: "SNAPTEST1",
    lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.World,
      gameMapSize: GameMapSize.Compact,
      gameMode: GameMode.FFA,
      gameType: GameType.Private,
      difficulty: Difficulty.Hard,
      nations: 12,
      bots: 40,
      donateGold: true,
      donateTroops: true,
      infiniteGold: true,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
      doomsdayClock: { enabled: true, speed: "veryfast" },
      ...overrides,
    },
    players: SCRIPTED_HUMANS.map((clientID, i) => ({
      clientID,
      username: `scripted${i}`,
      clanTag: null,
      isLobbyCreator: i === 0,
    })),
  };
}

export async function createScriptedRunner(
  mapName: string,
  gameStart: GameStartInfo,
): Promise<GameRunner> {
  return createGameRunner(
    gameStart,
    undefined,
    new TestDataMapLoader(mapName),
    recordErrors,
  );
}

export async function restoreScriptedRunner(
  mapName: string,
  gameStart: GameStartInfo,
  snapshot: Uint8Array,
): Promise<GameRunner> {
  return createGameRunnerFromSnapshot(
    gameStart,
    snapshot,
    undefined,
    new TestDataMapLoader(mapName),
    recordErrors,
  );
}

let lastError: ErrorUpdate | null = null;
function recordErrors(gu: GameUpdateViewData | ErrorUpdate): void {
  if ("errMsg" in gu) lastError = gu;
}

/** Runs one tick with the scripted humans' intents for it. */
export function stepScripted(runner: GameRunner): void {
  runner.addTurn(scriptedTurn(runner.game));
  lastError = null;
  if (!runner.executeNextTick()) {
    const err = lastError as ErrorUpdate | null;
    throw new Error(
      `tick ${runner.game.ticks()} failed: ${err?.errMsg}\n${err?.stack}`,
    );
  }
}

/**
 * Deterministic "human" players that exercise every intent. The choices are
 * a pure function of the game state and tick, so a restored game gets the
 * same intents as the original at the same tick.
 */
export function scriptedTurn(game: Game): Turn {
  const tick = game.ticks();
  const rand = new PseudoRandom(tick * 7919 + 17);
  const intents: StampedIntent[] = [];
  for (const clientID of SCRIPTED_HUMANS) {
    const p = game.playerByClientID(clientID);
    if (p === null) continue;
    const intent = game.inSpawnPhase()
      ? (spawnIntent(game, p, tick) ?? queuedIntent(game, p, tick))
      : playIntent(game, p, rand);
    if (intent !== null) intents.push({ ...intent, clientID } as StampedIntent);

    // Battle plans ride alongside the main intent rather than competing with it
    // for the same slot. They cost no troops and no gold, so letting them queue
    // up behind an economy action cannot starve the trade ships, SAMs and
    // artillery the other half of this test is relying on.
    if (!game.inSpawnPhase() && p.isAlive() && p.hasSpawned()) {
      const planIntent = playBattlePlanIntent(
        game,
        p,
        new PseudoRandom(game.ticks() * 15_486_317 + p.smallID()),
      );
      if (planIntent !== null) {
        intents.push({ ...planIntent, clientID } as StampedIntent);
      }
    }
  }
  if (tick === 21) {
    // From a client that is not in the game: becomes a NoOpExecution.
    intents.push({
      type: "emoji",
      recipient: AllPlayers,
      emoji: 0,
      clientID: "UNKNOWN1",
    });
  }
  return { turnNumber: tick, intents };
}

// Rough land coordinates on the world test map (compact size, 1000x500).
const SPAWNS = [
  [250, 330], // South America
  [520, 170], // Europe
  [760, 230], // Asia
];

function spawnIntent(game: Game, p: Player, tick: number): Intent | null {
  if (p.hasSpawned() || tick < 5) return null;
  const i = SCRIPTED_HUMANS.indexOf(p.clientID() as never);
  const [x, y] = SPAWNS[i];
  const tile = nearestSpawnable(game, x, y);
  return tile === null ? null : { type: "spawn", tile };
}

/**
 * One of each intent while the spawn phase holds them back: they sit in the
 * pending list until the game starts, which is the only time a snapshot can
 * catch executions that finish within the tick they start.
 */
function queuedIntent(game: Game, p: Player, tick: number): Intent | null {
  if (p.clientID() !== SCRIPTED_HUMANS[0] || tick < 20 || tick % 2 !== 0) {
    return null;
  }
  const other = game.playerByClientID(SCRIPTED_HUMANS[1]);
  if (other === null) return null;
  const queued: Intent[] = [
    { type: "attack", targetID: other.id(), troops: 10 },
    { type: "cancel_attack", attackID: "nonexistent" },
    { type: "boat", troops: 10, dst: other.spawnTile() ?? 0 },
    { type: "cancel_boat", unitID: 1 },
    { type: "allianceRequest", recipient: other.id() },
    { type: "allianceReject", requestor: other.id() },
    { type: "breakAlliance", recipient: other.id() },
    { type: "allianceExtension", recipient: other.id() },
    { type: "targetPlayer", target: other.id() },
    { type: "emoji", recipient: AllPlayers, emoji: 0 },
    { type: "donate_gold", recipient: other.id(), gold: 1 },
    { type: "donate_troops", recipient: other.id(), troops: 1 },
    { type: "embargo", targetID: other.id(), action: "start" },
    { type: "embargo_all", action: "stop" },
    {
      type: "build_unit",
      unit: UnitType.City,
      tile: p.spawnTile() ?? 0,
    },
    { type: "upgrade_structure", unit: UnitType.City, unitId: 1 },
    { type: "move_warship", unitIds: [1], tile: 0 },
    { type: "delete_unit", unitId: 1 },
    {
      type: "quick_chat",
      recipient: other.id(),
      quickChatKey: "greet.hello",
    },
    { type: "mark_disconnected", isDisconnected: false },
    { type: "toggle_pause", paused: false },
    // Armies (Prompt 3): raise one, name it, compose it, order it. All four
    // executions finish inside the tick they start, so like the rest of this
    // list they are only reachable from the spawn-phase pending list.
    {
      type: "create_army",
      tile: p.spawnTile() ?? 0,
      troops: 500,
      name: "1st Army",
      composition: { infantry: 60, armor: 20, artillery: 15, support: 5 },
    },
    { type: "rename_army", armyId: 1, name: "Renamed Army" },
    {
      type: "set_army_composition",
      armyId: 1,
      composition: { infantry: 40, armor: 40, artillery: 10, support: 10 },
    },
    { type: "army_order", armyId: 1, order: { type: "hold" } },
  ];
  return queued[(tick - 20) / 2] ?? null;
}

function nearestSpawnable(game: Game, cx: number, cy: number): TileRef | null {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!game.isValidCoord(x, y)) continue;
        const t = game.ref(x, y);
        if (game.isLand(t) && !game.isImpassable(t) && !game.hasOwner(t)) {
          return t;
        }
      }
    }
  }
  return null;
}

function pick<T>(rand: PseudoRandom, arr: readonly T[]): T | null {
  return arr.length === 0 ? null : arr[rand.nextInt(0, arr.length)];
}

/** 8-neighbours of a tile as an array; the buffer form leaks a length. */
function around(game: Game, tile: TileRef): TileRef[] {
  const buf: TileRef[] = [0, 0, 0, 0, 0, 0, 0, 0];
  const n = game.neighbors8(tile, buf);
  return buf.slice(0, n);
}

function randomOwnedTile(rand: PseudoRandom, p: Player): TileRef | null {
  const n = p.numTilesOwned();
  if (n === 0) return null;
  const k = rand.nextInt(0, n);
  let i = 0;
  for (const t of p.tiles()) {
    if (i++ === k) return t;
  }
  return null;
}

/**
 * A run of consecutive tiles from the player's own border, as if the pointer
 * had been dragged along it. Empty when the player has no border to draw on,
 * which is the case before anyone has taken anything.
 */
function drawnFrontier(rand: PseudoRandom, p: Player, game: Game): TileRef[] {
  const borders: TileRef[] = [];
  for (const t of p.borderTiles()) {
    if (game.isLand(t) && !game.isImpassable(t)) borders.push(t);
  }
  if (borders.length === 0) return [];
  const start = pick(rand, borders)!;
  const run = [start];
  let current = start;
  for (let i = 0; i < 6; i++) {
    const options: TileRef[] = [];
    for (const n of around(game, current)) {
      if (game.owner(n) !== p) continue;
      if (run.includes(n)) continue;
      options.push(n);
    }
    if (options.length === 0) break;
    current = options[rand.nextInt(0, options.length)];
    run.push(current);
  }
  return run;
}

/**
 * A straight arrow out of the drawn front: the drawn frontier's first tile, then
 * a few steps in the direction the border faces. Not a legal route — that is the
 * point. It is exactly the kind of gesture a player makes, and the reference
 * game proves the simulation turns it into something legal.
 */
function drawnArrow(
  rand: PseudoRandom,
  game: Game,
  frontier: readonly TileRef[],
): TileRef[] {
  if (frontier.length === 0) return [];
  const anchor = frontier[0];
  const ax = game.x(anchor);
  const ay = game.y(anchor);
  // Face the open side: the first neighbour direction that is not ours.
  let dx = 1;
  let dy = 0;
  for (const n of around(game, anchor)) {
    if (game.owner(n) === game.owner(anchor)) continue;
    dx = game.x(n) - ax;
    dy = game.y(n) - ay;
    break;
  }
  const out: TileRef[] = [];
  for (let step = 1; step <= 12; step++) {
    const x = ax + dx * step;
    const y = ay + dy * step;
    if (!game.isValidCoord(x, y)) break;
    out.push(game.ref(x, y));
  }
  // A sideways wobble, so simplification and smoothing are exercised rather than
  // handed a perfectly straight line.
  if (out.length > 3) {
    const i = rand.nextInt(1, out.length - 1);
    const t = out[i];
    const x = game.x(t) + (rand.chance(2) ? 1 : -1);
    if (game.isValidCoord(x, game.y(t))) out[i] = game.ref(x, game.y(t));
  }
  return out;
}

const STRUCTURES = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
] as const;

function playIntent(game: Game, p: Player, rand: PseudoRandom): Intent | null {
  if (!p.isAlive()) return null;

  // Armies (Prompt 3) get their own deterministic cadence and their own PRNG,
  // deliberately independent of `rand`: folding them into the switch below
  // would shift every other case's draw and quietly change which executions
  // this reference game exercises.
  if ((game.ticks() * 31 + p.smallID() * 7) % 9 === 0) {
    const armyIntent = playArmyIntent(
      game,
      p,
      new PseudoRandom(game.ticks() * 104_729 + p.smallID()),
    );
    if (armyIntent !== null) return armyIntent;
  }

  // Most ticks a human does nothing; keep the game moving.
  if (!rand.chance(3)) return null;
  const others = game.players().filter((o) => o !== p && o.isPlayer());
  const other = pick(rand, others);
  const own = (types: UnitType[]) => p.units(types);

  switch (rand.nextInt(0, 22)) {
    case 0:
    case 1:
    case 2: {
      const target = pick(rand, p.nearby());
      if (target === null) return null;
      return {
        type: "attack",
        targetID: target.isPlayer() ? target.id() : null,
        troops: p.troops() / 4,
      };
    }
    case 3: {
      if (other === null) return null;
      const dst = pick(
        rand,
        [...other.borderTiles()].filter((t) => game.isShore(t)),
      );
      if (dst === null) return null;
      return { type: "boat", troops: p.troops() / 5, dst };
    }
    case 4:
    case 5:
    case 6: {
      const unit = pick(rand, STRUCTURES)!;
      const tile =
        unit === UnitType.Port
          ? pick(
              rand,
              [...p.borderTiles()].filter((t) => game.isShore(t)),
            )
          : randomOwnedTile(rand, p);
      if (tile === null || p.canBuild(unit, tile) === false) return null;
      return { type: "build_unit", unit, tile };
    }
    case 7: {
      const port = pick(rand, own([UnitType.Port]));
      if (port === null) return null;
      const water = nearbyWater(game, port.tile(), rand);
      if (water === null || p.canBuild(UnitType.Warship, water) === false) {
        return null;
      }
      return { type: "build_unit", unit: UnitType.Warship, tile: water };
    }
    case 8: {
      if (own([UnitType.MissileSilo]).length === 0 || other === null) {
        return null;
      }
      const unit = pick(rand, [
        UnitType.AtomBomb,
        UnitType.HydrogenBomb,
        UnitType.MIRV,
      ])!;
      const tile = randomOwnedTile(rand, other);
      if (tile === null || p.canBuild(unit, tile) === false) return null;
      return {
        type: "build_unit",
        unit,
        tile,
        rocketDirectionUp: rand.chance(2),
      };
    }
    case 9: {
      const s = pick(rand, own([...STRUCTURES]));
      if (s === null) return null;
      return { type: "upgrade_structure", unit: s.type(), unitId: s.id() };
    }
    case 10: {
      if (other === null) return null;
      if (p.isAlliedWith(other)) {
        return rand.chance(4)
          ? { type: "breakAlliance", recipient: other.id() }
          : { type: "allianceExtension", recipient: other.id() };
      }
      return { type: "allianceRequest", recipient: other.id() };
    }
    case 11: {
      const req = pick(rand, p.incomingAllianceRequests());
      if (req === null) return null;
      return { type: "allianceReject", requestor: req.requestor().id() };
    }
    case 12: {
      const ally = pick(rand, p.allies());
      if (ally === null) return null;
      return rand.chance(2)
        ? { type: "donate_gold", recipient: ally.id(), gold: 1000 }
        : { type: "donate_troops", recipient: ally.id(), troops: null };
    }
    case 13:
      if (other === null) return null;
      return {
        type: "embargo",
        targetID: other.id(),
        action: rand.chance(2) ? "start" : "stop",
      };
    case 14:
      return { type: "embargo_all", action: rand.chance(2) ? "start" : "stop" };
    case 15:
      return {
        type: "emoji",
        recipient: other === null || rand.chance(3) ? AllPlayers : other.id(),
        emoji: rand.nextInt(0, flattenedEmojiTable.length),
      };
    case 16:
      if (other === null) return null;
      return rand.chance(2)
        ? { type: "targetPlayer", target: other.id() }
        : {
            type: "quick_chat",
            recipient: other.id(),
            quickChatKey: "greet.hello",
          };
    case 17: {
      const attack = pick(rand, p.outgoingAttacks());
      if (attack === null) return null;
      return { type: "cancel_attack", attackID: attack.id() };
    }
    case 18: {
      const boat = pick(rand, own([UnitType.TransportShip]));
      if (boat === null) return null;
      return { type: "cancel_boat", unitID: boat.id() };
    }
    case 19: {
      const ships = own([UnitType.Warship]);
      const ship = pick(rand, ships);
      if (ship === null) return null;
      const water = nearbyWater(game, ship.tile(), rand);
      if (water === null) return null;
      return { type: "move_warship", unitIds: [ship.id()], tile: water };
    }
    case 20: {
      const s = pick(rand, own([UnitType.DefensePost, UnitType.City]));
      if (s === null || !rand.chance(4)) return null;
      return { type: "delete_unit", unitId: s.id() };
    }
    case 21:
      return {
        type: "mark_disconnected",
        isDisconnected: !p.isDisconnected() && rand.chance(3),
      };
  }
  return null;
}

/**
 * One army action: raise an army, or rename/compose/order/reinforce one that
 * already exists. Uses its own PRNG (see playIntent) so it cannot disturb the
 * draw sequence of the other intents.
 */
function playArmyIntent(
  game: Game,
  p: Player,
  rand: PseudoRandom,
): Intent | null {
  const armies = game.armiesOf(p);
  // Small slices, on purpose: this reference game also has to afford nukes,
  // warships and trade ships, and troops locked into an army never return to
  // the free pool. A greedy scripted army would starve all of them.
  if (armies.length === 0 || rand.chance(2)) {
    const tile = randomOwnedTile(rand, p);
    if (tile === null || p.troops() < 40_000) return null;
    return {
      type: "create_army",
      tile,
      troops: p.troops() / 30,
      name: null,
      composition: null,
    };
  }
  const army = pick(rand, armies)!;
  switch (rand.nextInt(0, 5)) {
    case 0:
      return {
        type: "rename_army",
        armyId: army.id(),
        name: `Army ${army.id()}`,
      };
    case 1:
      // Deliberately does not total 100: the execution normalizes it, and this
      // is the reference game that proves it does so identically everywhere.
      return {
        type: "set_army_composition",
        armyId: army.id(),
        composition: {
          infantry: rand.nextInt(0, 60),
          armor: rand.nextInt(0, 60),
          artillery: rand.nextInt(0, 60),
          support: rand.nextInt(0, 60),
        },
      };
    case 2:
      return {
        type: "army_order",
        armyId: army.id(),
        order: { type: "reinforce", troops: p.troops() / 30 },
      };
    case 3:
      return { type: "army_order", armyId: army.id(), order: { type: "hold" } };
    default:
      return {
        type: "army_order",
        armyId: army.id(),
        order: { type: "createFront", tile: army.tile() },
      };
  }
}

/**
 * One battle-plan action: draw a new plan, or edit one that already exists.
 *
 * Rare on purpose. This reference game also has to keep producing a trade ship, a
 * SAM engagement and an artillery shell so every execution type lands in a
 * snapshot, and a plan's driver starts real attacks — every extra one perturbs
 * exactly those fights. The gate below still fires often enough to create plans
 * and cycle through all five edits many times over.
 *
 * The gesture is deliberately sloppy — a run of border tiles and a straight arrow
 * that may well run into the sea. That is the interesting case for this
 * reference game: it proves the simulation's derived geometry is a function of
 * the map and the proposal, and identical on every client that saw the same
 * intent.
 */
function playBattlePlanIntent(
  game: Game,
  p: Player,
  rand: PseudoRandom,
): Intent | null {
  if ((game.ticks() * 17 + p.smallID() * 5) % 47 !== 0) return null;
  const plans = game.battlePlansOf(p);
  const armies = game.armiesOf(p).map((a) => a.id());
  const frontier = drawnFrontier(rand, p, game);
  const arrow = drawnArrow(rand, game, frontier);

  if (plans.length === 0 || rand.chance(3)) {
    if (frontier.length === 0) return null;
    const kind = rand.nextInt(0, 5);
    return {
      type: "battle_plan",
      action: {
        type: "create",
        kind:
          kind === 0
            ? "offensive"
            : kind === 1
              ? "spearhead"
              : kind === 2
                ? "fallback"
                : kind === 3
                  ? "hold"
                  : "frontline",
        frontier,
        // A `hold` or `fallback` plan draws no arrow; sending one anyway is a
        // legitimate thing for a client to do and the simulation ignores it.
        route: arrow,
        armyIDs: armies.length === 0 ? [] : [pick(rand, armies)!],
      },
    };
  }

  const plan = pick(rand, plans)!;
  switch (rand.nextInt(0, 5)) {
    case 0:
      return {
        type: "battle_plan",
        action: { type: "pause", planId: plan.id() },
      };
    case 1:
      return {
        type: "battle_plan",
        action: { type: "resume", planId: plan.id() },
      };
    case 2:
      return {
        type: "battle_plan",
        action: { type: "delete", planId: plan.id() },
      };
    case 3:
      return {
        type: "battle_plan",
        action: { type: "reassign", planId: plan.id(), armyIDs: armies },
      };
    default:
      if (frontier.length === 0) return null;
      return {
        type: "battle_plan",
        action: {
          type: "redraw",
          planId: plan.id(),
          kind: "offensive",
          frontier,
          route: arrow,
          armyIDs: armies,
        },
      };
  }
}

function nearbyWater(
  game: Game,
  tile: TileRef,
  rand: PseudoRandom,
): TileRef | null {
  const x = game.x(tile);
  const y = game.y(tile);
  for (let i = 0; i < 20; i++) {
    const nx = x + rand.nextInt(-12, 13);
    const ny = y + rand.nextInt(-12, 13);
    if (!game.isValidCoord(nx, ny)) continue;
    const t = game.ref(nx, ny);
    if (game.isOcean(t)) return t;
  }
  return null;
}
