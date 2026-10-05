// Deterministic tests for army naming (Prompt 3.2).
//
// Custom names are the headline feature of the army system, and the safety
// rules are the part most likely to be got wrong, so both are pinned here:
// permissive about content (whatever the player types) and strict about
// rendering safety and invisible characters.

import {
  ARMY_NAME_MAX_LENGTH,
  defaultArmyName,
  ordinal,
  sanitizeArmyName,
  truncateArmyName,
  validateArmyName,
} from "../src/core/game/ArmyName";

describe("army names", () => {
  describe("length", () => {
    test("allows the documented examples", () => {
      for (const name of [
        "1st Army",
        "Northern Army",
        "Class 11B Destroyers",
        "Kevin",
      ]) {
        expect(validateArmyName(name)).toEqual({ ok: true, name });
      }
    });

    test("rejects an empty name", () => {
      expect(validateArmyName("")).toEqual({ ok: false, reason: "empty" });
      expect(validateArmyName("   ")).toEqual({ ok: false, reason: "empty" });
    });

    test("rejects anything that is not a string", () => {
      for (const input of [null, undefined, 42, {}, [], true]) {
        expect(validateArmyName(input)).toEqual({
          ok: false,
          reason: "notAString",
        });
      }
    });

    test("accepts exactly 32 code points and truncates beyond it", () => {
      const at32 = "a".repeat(32);
      expect(validateArmyName(at32)).toEqual({ ok: true, name: at32 });
      const at33 = "a".repeat(33);
      expect(validateArmyName(at33)).toEqual({ ok: true, name: at32 });
    });

    test("counts code points, not UTF-16 units", () => {
      // Each of these is one code point but two UTF-16 units. Counting units
      // would reject a 32-emoji name as 64 characters.
      const name = "⚔".repeat(32);
      expect(validateArmyName(name)).toEqual({ ok: true, name });
      expect([...name]).toHaveLength(32);
    });

    test("truncation never splits a surrogate pair", () => {
      // "⚔" is one code point; truncating to 32 must keep 32 whole ones.
      const truncated = truncateArmyName("⚔".repeat(40));
      expect([...truncated]).toHaveLength(ARMY_NAME_MAX_LENGTH);
      // No lone surrogate survives: every code unit pair is complete, which is
      // what is checked by re-encoding the string losslessly.
      const reencoded = Buffer.from(truncated, "utf16le").toString("utf16le");
      expect(reencoded).toBe(truncated);
      expect([...reencoded]).toHaveLength(ARMY_NAME_MAX_LENGTH);
    });
  });

  describe("safety", () => {
    test("keeps markup as literal text rather than escaping it", () => {
      // Every consumer renders the name as a text node or canvas text, so
      // markup is inert and must survive verbatim: a player who types <b> sees
      // "<b>", not "&lt;b&gt;".
      const attack = '<img src=x onerror="alert(1)">';
      expect(validateArmyName(attack)).toEqual({ ok: true, name: attack });
      expect(validateArmyName("<script>alert(1)</script>")).toEqual({
        ok: true,
        name: "<script>alert(1)</script>",
      });
    });

    test("strips control characters, so a name cannot break the HUD layout", () => {
      // A stripped control character leaves its neighbours adjacent; the point
      // is only that nothing invisible or line-breaking survives.
      expect(sanitizeArmyName("North\u0000\u0007er Army")).toBe("Norther Army");
      // Tab is a C0 control, so it is stripped outright rather than turned into
      // a space — nothing invisible survives either way.
      expect(sanitizeArmyName("tab\there")).toBe("tabhere");
      // A newline or carriage return would otherwise reflow a single-line label;
      // like tab, it is stripped outright.
      expect(sanitizeArmyName("North\nArmy")).toBe("NorthArmy");
      expect(sanitizeArmyName("a\rb")).toBe("ab");
      // Printable whitespace does collapse to a single space.
      expect(sanitizeArmyName("a   b")).toBe("a b");
    });

    test("strips zero-width and bidi-formatting characters", () => {
      // Trojan-source: an army that reads as one name and measures as another.
      expect(sanitizeArmyName("Army\u202Eexe")).toBe("Armyexe");
      // Zero-width joiners would let a name exceed the visible budget.
      expect(sanitizeArmyName("1st\u200B Army")).toBe("1st Army");
      // A byte-order mark in the middle of a name is invisible; drop it.
      expect(sanitizeArmyName("A\uFEFFB")).toBe("AB");
    });

    test("rejects a name made only of stripped characters", () => {
      expect(validateArmyName("\u200B\u200C")).toEqual({
        ok: false,
        reason: "onlyStrippedCharacters",
      });
    });

    test("trims and collapses whitespace, including non-breaking spaces", () => {
      expect(sanitizeArmyName("  Northern   Army  ")).toBe("Northern Army");
      expect(sanitizeArmyName("Northern\u00a0Army")).toBe("Northern Army");
      expect(sanitizeArmyName("\u00a0Northern\u00a0")).toBe("Northern");
    });

    test("normalizes to NFC, so visually identical names compare equal", () => {
      // "e" + combining acute composes to "é".
      const decomposed = "Cafe\u0301 Army";
      const result = validateArmyName(decomposed);
      expect(result.ok).toBe(true);
      expect(result.ok && result.name).toBe("Caf\u00e9 Army");
      expect(result.ok && result.name).toBe("Café Army");
    });

    test("keeps non-Latin scripts intact", () => {
      for (const name of [
        "北部軍",
        "Северная армия",
        "الجيش الشمالي",
        "南軍",
        "💥⚔️",
      ]) {
        expect(validateArmyName(name)).toEqual({ ok: true, name });
      }
    });

    test("a sanitized name is a fixed point: re-sanitizing changes nothing", () => {
      for (const input of [
        "  a\u0000b  ",
        "\u200B\u00a0 x \u00a0",
        "Cafe\u0301",
        "a".repeat(50),
      ]) {
        const once = sanitizeArmyName(input);
        expect(sanitizeArmyName(once)).toBe(once);
      }
    });
  });

  describe("generated defaults", () => {
    test("ordinals are correct, including the teens", () => {
      expect(ordinal(1)).toBe("1st");
      expect(ordinal(2)).toBe("2nd");
      expect(ordinal(3)).toBe("3rd");
      expect(ordinal(4)).toBe("4th");
      expect(ordinal(11)).toBe("11th");
      expect(ordinal(12)).toBe("12th");
      expect(ordinal(13)).toBe("13th");
      expect(ordinal(21)).toBe("21st");
      expect(ordinal(22)).toBe("22nd");
      expect(ordinal(101)).toBe("101st");
      expect(ordinal(111)).toBe("111th");
    });

    test("the first army of a player is the 1st Army", () => {
      expect(defaultArmyName(0)).toBe("1st Army");
      expect(defaultArmyName(1)).toBe("2nd Army");
      expect(defaultArmyName(2)).toBe("3rd Army");
    });

    test("generated names are unique past the ordinal range", () => {
      expect(defaultArmyName(98)).toBe("99th Army");
      expect(defaultArmyName(99)).toBe("Army 100");
      expect(defaultArmyName(149)).toBe("Army 150");
      const names = new Set<string>();
      for (let i = 0; i < 200; i++) names.add(defaultArmyName(i));
      expect(names.size).toBe(200);
    });

    test("generated names pass the same validation as a player's own", () => {
      for (let i = 0; i < 150; i++) {
        const result = validateArmyName(defaultArmyName(i));
        expect(result.ok).toBe(true);
      }
    });

    test("is a pure function of the existing army count", () => {
      expect(defaultArmyName(3)).toBe(defaultArmyName(3));
    });
  });
});
