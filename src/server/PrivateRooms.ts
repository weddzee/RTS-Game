// Private room codes for the friends-and-classmates build (Prompt 1).
//
// A room code is a short, server-minted alias for a private game ID:
// 6 uppercase characters from an unambiguous alphabet (no 0/O, 1/I/L).
// The game ID remains the join secret on the wire; the code is only a
// human-friendly lookup key.
//
// This module is server-only and dependency-free (nanoid + core pacing
// types only) so tests can exercise it without sockets. GameServer itself
// is untouched: the registry lives beside it in Worker.ts, and join/turn
// logic never consults a code.

import { customAlphabet } from "nanoid";
import { MatchPacingPreset, isMatchPacingPreset } from "../core/MatchPacing";

export const ROOM_CODE_LENGTH = 6;

// Uppercase, easy to type and read aloud. Excludes 0/O, 1/I and L.
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const ROOM_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

const generateAlphabet = customAlphabet(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH);

export function generateRoomCode(): string {
  return generateAlphabet();
}

/** Uppercase, strip spaces and dashes so "k7 p2-xm" still resolves. */
export function normalizeRoomCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

export function isValidRoomCode(value: string): boolean {
  return ROOM_CODE_PATTERN.test(value);
}

export interface PrivateRoomOptions {
  durationPreset?: MatchPacingPreset;
  bots?: number;
  /** Recorded for upcoming phases; no simulation effect yet. */
  fogEnabled?: boolean;
  /** Recorded for upcoming phases; no simulation effect yet. */
  aircraftEnabled?: boolean;
  /** Recorded for upcoming phases; no simulation effect yet. */
  advancedSupplyEnabled?: boolean;
}

export function parsePrivateRoomOptions(
  value: unknown,
): PrivateRoomOptions | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const options: PrivateRoomOptions = {};
  if (
    record.durationPreset !== undefined &&
    isMatchPacingPreset(record.durationPreset)
  ) {
    options.durationPreset = record.durationPreset;
  }
  if (
    typeof record.bots === "number" &&
    Number.isInteger(record.bots) &&
    record.bots >= 0 &&
    record.bots <= 400
  ) {
    options.bots = record.bots;
  }
  for (const key of [
    "fogEnabled",
    "aircraftEnabled",
    "advancedSupplyEnabled",
  ] as const) {
    if (typeof record[key] === "boolean") options[key] = record[key];
  }
  return options;
}

export interface PrivateRoomRecord {
  roomCode: string;
  gameID: string;
  creatorPersistentID: string;
  createdAt: number;
  options: PrivateRoomOptions;
}

/**
 * In-memory code -> game mapping, one instance per worker process.
 * Codes are minted with worker affinity by the caller (rejection-sample
 * until workerIndex(code) lands here), so resolution never crosses
 * workers; uniqueness is enforced within this map.
 */
export class PrivateRoomRegistry {
  private readonly byCode = new Map<string, PrivateRoomRecord>();
  private readonly codeByGame = new Map<string, string>();

  public size(): number {
    return this.byCode.size;
  }

  public createForGame(
    gameID: string,
    creatorPersistentID: string,
    options: PrivateRoomOptions = {},
    generate: () => string = generateRoomCode,
  ): PrivateRoomRecord {
    const existing = this.codeByGame.get(gameID);
    if (existing !== undefined) {
      return this.byCode.get(existing)!;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const roomCode = generate();
      if (!isValidRoomCode(roomCode)) continue;
      if (this.byCode.has(roomCode)) continue;
      const record: PrivateRoomRecord = {
        roomCode,
        gameID,
        creatorPersistentID,
        createdAt: Date.now(),
        options,
      };
      this.byCode.set(roomCode, record);
      this.codeByGame.set(gameID, roomCode);
      return record;
    }
    throw new Error("PrivateRoomRegistry: could not mint a unique room code");
  }

  public resolve(rawCode: string): PrivateRoomRecord | null {
    const roomCode = normalizeRoomCode(rawCode);
    if (!isValidRoomCode(roomCode)) return null;
    return this.byCode.get(roomCode) ?? null;
  }

  public codeForGame(gameID: string): string | null {
    return this.codeByGame.get(gameID) ?? null;
  }

  public removeByGame(gameID: string): void {
    const code = this.codeByGame.get(gameID);
    if (code === undefined) return;
    this.codeByGame.delete(gameID);
    this.byCode.delete(code);
  }

  public prune(olderThanMs: number, now: number = Date.now()): number {
    let removed = 0;
    for (const [code, record] of this.byCode) {
      if (now - record.createdAt > olderThanMs) {
        this.byCode.delete(code);
        this.codeByGame.delete(record.gameID);
        removed++;
      }
    }
    return removed;
  }
}

// Suffix space reserved so "name 2" never exceeds the 20-char menu cap.
// The suffix is a space plus digits: parentheses are NOT in the wire
// UsernameSchema charset, so " (2)" would fail lobby_info encoding.
const DISAMBIGUATION_SUFFIX_ROOM = 4;

/**
 * Duplicate nicknames are allowed in a room but must not render
 * identically: append " 2", " 3", … case-insensitively against the
 * usernames already in the lobby. Reconnects bypass this (rejoinClient
 * restores the stored identity before this runs), so an existing session
 * never gets renamed out from under it.
 */
export function disambiguateUsername(
  takenUsernames: Iterable<string>,
  username: string,
  maxLength: number = 20,
): string {
  const taken = new Set(
    Array.from(takenUsernames, (name) => name.toLowerCase()),
  );
  if (!taken.has(username.toLowerCase())) return username;
  const base = [...username]
    .slice(0, Math.max(0, maxLength - DISAMBIGUATION_SUFFIX_ROOM))
    .join("")
    .trimEnd();
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now() % 1000}`;
}

/**
 * The server's authoritative nickname: trimmed and clamped to the menu
 * cap, measured in code points. Charset and emptiness are enforced by the
 * wire UsernameSchema before this runs; this function never invents a new
 * name, it only narrows an accepted one.
 */
export function authoritativeNickname(
  raw: string,
  maxLength: number = 20,
): string {
  const trimmed = raw.trim();
  return [...trimmed].slice(0, maxLength).join("");
}
