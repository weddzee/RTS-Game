// Prompt 1 acceptance: private rooms on the server — room creation,
// invalid-room resolution, room joins (including started/full errors),
// and the nickname rules the join path enforces.
import { describe, expect, it } from "vitest";
import { GameServer } from "../../src/server/GameServer";
import {
  PrivateRoomRegistry,
  generateRoomCode,
  isValidRoomCode,
} from "../../src/server/PrivateRooms";
import {
  cid,
  makeClient,
  makeGame,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";

describe("PrivateRoomRegistry — room creation", () => {
  it("mints a unique code per game and resolves it back", () => {
    const registry = new PrivateRoomRegistry();
    const first = registry.createForGame(cid("game0001"), "creator-1", {
      durationPreset: "rapid",
    });
    const second = registry.createForGame(cid("game0002"), "creator-2", {});

    expect(isValidRoomCode(first.roomCode)).toBe(true);
    expect(isValidRoomCode(second.roomCode)).toBe(true);
    expect(first.roomCode).not.toBe(second.roomCode);
    expect(registry.size()).toBe(2);

    expect(registry.resolve(first.roomCode)?.gameID).toBe(cid("game0001"));
    expect(registry.codeForGame(cid("game0001"))).toBe(first.roomCode);
  });

  it("reuses the existing code when asked twice for one game", () => {
    const registry = new PrivateRoomRegistry();
    const gameID = cid("game0003");
    const first = registry.createForGame(gameID, "creator-1", {});
    expect(registry.createForGame(gameID, "creator-1", {})).toBe(first);
    expect(registry.size()).toBe(1);
  });

  it("retries on collision instead of aliasing two games", () => {
    const registry = new PrivateRoomRegistry();
    registry.createForGame(cid("game0004"), "creator-1", {}, () => "ABCDEF");
    const second = registry.createForGame(
      cid("game0005"),
      "creator-2",
      {},
      (() => {
        let calls = 0;
        return () => (++calls === 1 ? "ABCDEF" : generateRoomCode());
      })(),
    );
    expect(second.roomCode).not.toBe("ABCDEF");
    expect(registry.resolve("ABCDEF")?.gameID).toBe(cid("game0004"));
  });
});

describe("PrivateRoomRegistry — invalid rooms", () => {
  it("returns null for unknown, malformed, and empty codes", () => {
    const registry = new PrivateRoomRegistry();
    registry.createForGame(cid("game0006"), "creator-1", {});
    expect(registry.resolve("ZZZZZZ")).toBeNull();
    expect(registry.resolve("ABC01D")).toBeNull();
    expect(registry.resolve("")).toBeNull();
    expect(registry.resolve("not a code!!")).toBeNull();
  });

  it("normalizes case and separators before lookup", () => {
    const registry = new PrivateRoomRegistry();
    const record = registry.createForGame(cid("game0007"), "creator-1", {});
    expect(registry.resolve(record.roomCode.toLowerCase())?.gameID).toBe(
      cid("game0007"),
    );
  });

  it("forgets rooms whose game is gone", () => {
    const registry = new PrivateRoomRegistry();
    const record = registry.createForGame(cid("game0008"), "creator-1", {});
    registry.removeByGame(cid("game0008"));
    expect(registry.resolve(record.roomCode)).toBeNull();
    expect(registry.codeForGame(cid("game0008"))).toBeNull();
  });
});

describe("GameServer.joinClient — private room joins", () => {
  it("seats players in a fresh private lobby", () => {
    const game: GameServer = makeGame();
    expect(game.joinClient(makeClient({ clientID: cid("host0001") }))).toBe(
      "joined",
    );
    expect(game.joinClient(makeClient({ clientID: cid("guest001") }))).toBe(
      "joined",
    );
    expect(game.numClients()).toBe(2);
  });

  it("reports a full room as rejected with a full-lobby frame", () => {
    const game: GameServer = makeGame({ config: { maxPlayers: 1 } });
    expect(game.joinClient(makeClient({ clientID: cid("solo0001") }))).toBe(
      "joined",
    );
    const late = makeClient({ clientID: cid("late0001") });
    expect(game.joinClient(late)).toBe("rejected");
    expect(mockWsOf(late).sent()).toContainEqual({
      type: "error",
      error: "full-lobby",
    });
  });

  it("reports a started room with a game-started frame", () => {
    const game: GameServer = makeGame();
    game.joinClient(makeClient({ clientID: cid("early001") }));
    startGame(game);
    const late = makeClient({ clientID: cid("late0002") });
    expect(game.joinClient(late)).toBe("started");
    expect(mockWsOf(late).sent()).toContainEqual({
      type: "error",
      error: "game-started",
    });
  });

  it("lets a spectator into a full room", () => {
    const game: GameServer = makeGame({ config: { maxPlayers: 1 } });
    game.joinClient(makeClient({ clientID: cid("player01") }));
    const watcher = makeClient({
      clientID: cid("watch001"),
      spectator: true,
    });
    expect(game.joinClient(watcher)).toBe("joined");
  });

  it("allows duplicate nicknames (disambiguation happens in Worker)", () => {
    const game: GameServer = makeGame();
    expect(
      game.joinClient(
        makeClient({ clientID: cid("dup00001"), username: "Bob" }),
      ),
    ).toBe("joined");
    expect(
      game.joinClient(
        makeClient({ clientID: cid("dup00002"), username: "Bob" }),
      ),
    ).toBe("joined");
  });
});
