// Prompt 1 acceptance: private-lobby core units — nickname validation,
// match pacing configuration, and room-code utilities. Pure functions only;
// server join paths live in tests/server/PrivateRooms.test.ts.
import { describe, expect, it } from "vitest";
import {
  MATCH_PACING_CONFIGS,
  MATCH_PACING_PRESETS,
  isMatchPacingPreset,
  matchPacingConfigFor,
  matchPacingGameConfigPatch,
} from "../src/core/MatchPacing";
import {
  PRIVATE_NICKNAME_MAX,
  validatePrivateNickname,
} from "../src/core/PrivateNickname";
import { UsernameSchema } from "../src/core/Schemas";
import {
  authoritativeNickname,
  disambiguateUsername,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  parsePrivateRoomOptions,
} from "../src/server/PrivateRooms";

describe("validatePrivateNickname", () => {
  it("accepts a 1-character name", () => {
    expect(validatePrivateNickname("X")).toEqual({
      isValid: true,
      value: "X",
    });
  });

  it("accepts 20 characters and rejects 21", () => {
    expect(validatePrivateNickname("a".repeat(20)).isValid).toBe(true);
    expect(validatePrivateNickname("a".repeat(21))).toEqual({
      isValid: false,
      error: "too_long",
    });
    expect(PRIVATE_NICKNAME_MAX).toBe(20);
  });

  it("trims surrounding whitespace", () => {
    expect(validatePrivateNickname("  Bob  ")).toEqual({
      isValid: true,
      value: "Bob",
    });
  });

  it("rejects blank input", () => {
    for (const raw of ["", "   ", null, undefined, 42]) {
      expect(validatePrivateNickname(raw).error).toBe("blank");
    }
  });

  it("supports ordinary Unicode within the renderable set", () => {
    expect(validatePrivateNickname("José Müller").isValid).toBe(true);
    expect(validatePrivateNickname("Renée-Bjørn_99").isValid).toBe(true);
  });

  it("rejects HTML-significant and control characters", () => {
    for (const raw of ["<img>", "a&b", 'q"q', "a/b", "a\nb", "😀"]) {
      expect(validatePrivateNickname(raw).error).toBe("invalid_chars");
    }
  });

  it("rejects names with no letter or digit", () => {
    expect(validatePrivateNickname("---").error).toBe("no_alnum");
    expect(validatePrivateNickname(" . ").error).toBe("no_alnum");
  });
});

describe("match pacing configuration", () => {
  it("declares rapid/standard/extended/sandbox presets", () => {
    expect([...MATCH_PACING_PRESETS]).toEqual([
      "rapid",
      "standard",
      "extended",
      "sandbox",
    ]);
  });

  it("centralizes the 10/15/20/unlimited durations", () => {
    expect(MATCH_PACING_CONFIGS.rapid.durationMinutes).toBe(10);
    expect(MATCH_PACING_CONFIGS.standard.durationMinutes).toBe(15);
    expect(MATCH_PACING_CONFIGS.extended.durationMinutes).toBe(20);
    expect(MATCH_PACING_CONFIGS.sandbox.durationMinutes).toBeNull();
  });

  it("falls back to standard for unknown presets", () => {
    expect(matchPacingConfigFor("blitz")).toBe(MATCH_PACING_CONFIGS.standard);
    expect(matchPacingConfigFor(undefined)).toBe(MATCH_PACING_CONFIGS.standard);
    expect(isMatchPacingPreset("rapid")).toBe(true);
    expect(isMatchPacingPreset("blitz")).toBe(false);
  });

  it("maps presets to a GameConfig patch without scattering constants", () => {
    expect(matchPacingGameConfigPatch("rapid")).toEqual({
      maxTimerValue: 10,
      goldMultiplier: 1.5,
    });
    expect(matchPacingGameConfigPatch("standard")).toEqual({
      maxTimerValue: 15,
      goldMultiplier: 1.0,
    });
    expect(matchPacingGameConfigPatch("extended")).toEqual({
      maxTimerValue: 20,
      goldMultiplier: 0.85,
    });
    expect(matchPacingGameConfigPatch("sandbox")).toEqual({
      maxTimerValue: null,
      goldMultiplier: 1.0,
    });
  });
});

describe("room codes", () => {
  it("generates 6 uppercase unambiguous codes", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
      expect(isValidRoomCode(code)).toBe(true);
      expect(code).not.toMatch(/[01IL]/);
    }
  });

  it("normalizes typed codes", () => {
    expect(normalizeRoomCode("k7 p2-xm")).toBe("K7P2XM");
    expect(normalizeRoomCode("  ab12cd ")).toBe("AB12CD");
  });

  it("rejects malformed codes", () => {
    for (const bad of ["", "ABC", "ABCDEFG", "ABC01D", "abc!!1", "K7P2XM "]) {
      if (bad === "K7P2XM ") {
        expect(isValidRoomCode(normalizeRoomCode(bad))).toBe(true);
      } else {
        expect(isValidRoomCode(bad)).toBe(false);
      }
    }
  });

  it("parses room options defensively", () => {
    expect(
      parsePrivateRoomOptions({
        durationPreset: "rapid",
        bots: 5,
        fogEnabled: true,
        aircraftEnabled: false,
        advancedSupplyEnabled: true,
      }),
    ).toEqual({
      durationPreset: "rapid",
      bots: 5,
      fogEnabled: true,
      aircraftEnabled: false,
      advancedSupplyEnabled: true,
    });
    expect(parsePrivateRoomOptions({ durationPreset: "blitz" })).toEqual({});
    expect(parsePrivateRoomOptions({ bots: 401 })).toEqual({});
    expect(parsePrivateRoomOptions(null)).toBeNull();
    expect(parsePrivateRoomOptions("rapid")).toBeNull();
  });
});

describe("server nickname authority helpers", () => {
  it("trims and clamps to the menu cap", () => {
    expect(authoritativeNickname("  Bob  ")).toBe("Bob");
    expect(authoritativeNickname("a".repeat(30))).toBe("a".repeat(20));
  });

  it("leaves unique names untouched", () => {
    expect(disambiguateUsername(["Alice"], "Bob")).toBe("Bob");
  });

  it("suffixes duplicates case-insensitively", () => {
    expect(disambiguateUsername(["bob"], "Bob")).toBe("Bob 2");
    expect(disambiguateUsername(["Bob", "Bob 2"], "bob")).toBe("bob 3");
  });

  it("keeps the suffix within the length cap", () => {
    const long = "a".repeat(20);
    const result = disambiguateUsername([long], long);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toBe(`${"a".repeat(16)} 2`);
  });

  it("produces names the wire schema accepts", () => {
    // Regression guard: lobby_info re-encodes roster names through
    // UsernameSchema, so a suffix outside the charset kills the broadcast.
    const outputs = [
      disambiguateUsername(["Bob"], "Bob"),
      disambiguateUsername(["bob"], "Bob"),
      disambiguateUsername(["Bob", "Bob 2"], "BOB"),
      disambiguateUsername(["a".repeat(20)], "a".repeat(20)),
    ];
    for (const name of outputs) {
      expect(UsernameSchema.safeParse(name).success).toBe(true);
    }
  });
});
