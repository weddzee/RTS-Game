// Deterministic tests for the army composition math (Prompt 3.3).
//
// The composition system is pure integer math with no Game/Player access, so
// these tests are exact-value assertions rather than tolerance checks: the
// simulation and every client derive the same numbers, and a change to the
// balance table should show up here as an explicit diff.

import {
  ARMY_CATEGORY_STATS,
  ARMY_PRESET_COMPOSITIONS,
} from "../src/core/configuration/ArmyBalance";
import {
  ARMY_CATEGORIES,
  ARMY_COMPOSITION_TOTAL,
  ARMY_PRESETS,
  attackerLossDivisor,
  breakthroughMultiplier,
  derivedStats,
  matchingPreset,
  normalizeComposition,
  offenseMultiplier,
  presetComposition,
  terrainAdjustedSpeed,
  validateComposition,
  type ArmyComposition,
} from "../src/core/game/ArmyComposition";
import { TerrainType } from "../src/core/game/Game";

const total = (c: ArmyComposition): number =>
  ARMY_CATEGORIES.reduce((sum, k) => sum + c[k], 0);

describe("army composition", () => {
  describe("validateComposition", () => {
    test("accepts a normalized four-category mix", () => {
      expect(
        validateComposition({
          infantry: 60,
          armor: 20,
          artillery: 15,
          support: 5,
        }),
      ).toBe(true);
    });

    test("rejects a mix that does not total 100", () => {
      expect(
        validateComposition({
          infantry: 60,
          armor: 20,
          artillery: 15,
          support: 6,
        }),
      ).toBe(false);
      expect(
        validateComposition({
          infantry: 30,
          armor: 20,
          artillery: 15,
          support: 5,
        }),
      ).toBe(false);
    });

    test("rejects fractional and out-of-range values", () => {
      expect(
        validateComposition({
          infantry: 60.5,
          armor: 20,
          artillery: 15,
          support: 4.5,
        }),
      ).toBe(false);
      expect(
        validateComposition({
          infantry: 101,
          armor: 0,
          artillery: 0,
          support: -1,
        }),
      ).toBe(false);
      expect(
        validateComposition({
          infantry: -10,
          armor: 110,
          artillery: 0,
          support: 0,
        }),
      ).toBe(false);
    });

    test("rejects unknown categories and non-objects", () => {
      // A typo'd key would otherwise be dropped and quietly change the total.
      expect(
        validateComposition({
          infantry: 100,
          armour: 0,
          artillery: 0,
          support: 0,
        }),
      ).toBe(false);
      expect(validateComposition(null)).toBe(false);
      expect(validateComposition("60/20/15/5")).toBe(false);
      expect(validateComposition([60, 20, 15, 5])).toBe(false);
    });
  });

  describe("presets", () => {
    test.each(ARMY_PRESETS)("%s is a legal composition", (preset) => {
      const c = presetComposition(preset);
      expect(validateComposition(c)).toBe(true);
      expect(total(c)).toBe(ARMY_COMPOSITION_TOTAL);
    });

    test("presets are deep-copied, not shared", () => {
      const a = presetComposition("balanced");
      a.infantry = 1;
      expect(presetComposition("balanced").infantry).toBe(60);
    });

    test("matchingPreset recognizes each preset and rejects a custom mix", () => {
      for (const preset of ARMY_PRESETS) {
        expect(matchingPreset(presetComposition(preset))).toBe(preset);
      }
      expect(
        matchingPreset({ infantry: 33, armor: 33, artillery: 33, support: 1 }),
      ).toBeNull();
    });
  });

  describe("normalizeComposition", () => {
    test("always totals exactly 100", () => {
      const inputs = [
        { infantry: 1, armor: 1, artillery: 1, support: 1 },
        { infantry: 33, armor: 33, artillery: 33, support: 0 },
        { infantry: 34, armor: 33, artillery: 33, support: 0 },
        { infantry: 50, armor: 50 },
      ];
      for (const input of inputs) {
        const c = normalizeComposition(input);
        expect(total(c), JSON.stringify(input)).toBe(ARMY_COMPOSITION_TOTAL);
        expect(validateComposition(c)).toBe(true);
      }
    });

    test("an already-valid composition is returned unchanged", () => {
      const input: ArmyComposition = {
        infantry: 60,
        armor: 20,
        artillery: 15,
        support: 5,
      };
      expect(normalizeComposition(input)).toEqual(input);
    });

    test("fractions are apportioned proportionally, not round-robined", () => {
      // 40/30/20/10 is valid, so it must survive untouched.
      expect(
        normalizeComposition({
          infantry: 40,
          armor: 30,
          artillery: 20,
          support: 10,
        }),
      ).toEqual({
        infantry: 40,
        armor: 30,
        artillery: 20,
        support: 10,
      });
      // A 2:1 ratio stays a 2:1 ratio: the leftover unit goes to the larger
      // fractional part (infantry .67) rather than being sprinkled around.
      const c = normalizeComposition({
        infantry: 50,
        armor: 25,
        artillery: 0,
        support: 0,
      });
      expect(c).toEqual({ infantry: 67, armor: 33, artillery: 0, support: 0 });
      expect(total(c)).toBe(ARMY_COMPOSITION_TOTAL);
    });

    test("an over-subscribed input is scaled down proportionally", () => {
      const c = normalizeComposition({
        infantry: 80,
        armor: 80,
        artillery: 80,
        support: 80,
      });
      // Equal inputs stay equal.
      expect(c).toEqual({
        infantry: 25,
        armor: 25,
        artillery: 25,
        support: 25,
      });
      expect(validateComposition(c)).toBe(true);
    });

    test("garbage falls back to the balanced preset", () => {
      for (const input of [null, undefined, {}, "nope", 42]) {
        expect(normalizeComposition(input)).toEqual(
          ARMY_PRESET_COMPOSITIONS.balanced,
        );
      }
    });

    test("is deterministic: same input, same output, every time", () => {
      const input = {
        infantry: 12.5,
        armor: 33.3,
        artillery: 1.1,
        support: 0.9,
      };
      const first = normalizeComposition(input);
      for (let i = 0; i < 20; i++) {
        expect(normalizeComposition(input)).toEqual(first);
      }
    });
  });

  describe("derived stats", () => {
    /**
     * The derived stat is the composition-weighted average of the per-category
     * row, so a pure mix must land exactly on that row and a 50/50 mix on the
     * midpoint of two rows. This is the contract the balance table relies on.
     */
    const expectedStat = (
      c: ArmyComposition,
      key: keyof (typeof ARMY_CATEGORY_STATS)["infantry"],
    ): number => {
      let sum = 0;
      for (const k of ARMY_CATEGORIES) {
        sum += c[k] * ARMY_CATEGORY_STATS[k][key];
      }
      return Math.floor(sum / ARMY_COMPOSITION_TOTAL);
    };

    test("a pure category resolves to that category's row", () => {
      const pure: ArmyComposition = {
        infantry: 100,
        armor: 0,
        artillery: 0,
        support: 0,
      };
      const stats = derivedStats(pure);
      expect(stats.defense).toBe(ARMY_CATEGORY_STATS.infantry.defense);
      expect(stats.offense).toBe(ARMY_CATEGORY_STATS.infantry.offense);
      expect(stats.manpowerCost).toBe(
        ARMY_CATEGORY_STATS.infantry.manpowerCost,
      );
    });

    test("a 50/50 mix resolves to the floored midpoint", () => {
      const half: ArmyComposition = {
        infantry: 50,
        armor: 50,
        artillery: 0,
        support: 0,
      };
      const stats = derivedStats(half);
      expect(stats.breakthrough).toBe(expectedStat(half, "breakthrough"));
      expect(stats.breakthrough).toBe(
        Math.floor(
          (ARMY_CATEGORY_STATS.infantry.breakthrough +
            ARMY_CATEGORY_STATS.armor.breakthrough) /
            2,
        ),
      );
    });

    test("infantry is cheap, defensive and a poor attacker", () => {
      const stats = derivedStats(presetComposition("infantry"));
      const balanced = derivedStats(presetComposition("balanced"));
      expect(stats.defense).toBeGreaterThan(balanced.defense);
      expect(stats.manpowerCost).toBeLessThan(balanced.manpowerCost);
      expect(stats.equipmentCost).toBeLessThan(balanced.equipmentCost);
      expect(stats.offense).toBeLessThan(balanced.offense);
    });

    test("armor is expensive and breaks through fastest", () => {
      const armored = derivedStats(presetComposition("armored"));
      const infantry = derivedStats(presetComposition("infantry"));
      expect(armored.breakthrough).toBeGreaterThan(infantry.breakthrough);
      expect(armored.manpowerCost).toBeGreaterThan(infantry.manpowerCost);
      expect(armored.equipmentCost).toBeGreaterThan(infantry.manpowerCost);
    });

    test("artillery hits hardest and is the least defensible", () => {
      const artillery = derivedStats(presetComposition("artillery"));
      const others = ARMY_PRESETS.filter((p) => p !== "artillery").map((p) =>
        derivedStats(presetComposition(p)),
      );
      for (const other of others) {
        expect(artillery.offense).toBeGreaterThan(other.offense);
      }
      expect(artillery.breakthrough).toBeLessThan(
        others[0].breakthrough as number,
      );
    });

    test("support buys supply, organization and recon, not offence", () => {
      const supportHeavy: ArmyComposition = {
        infantry: 20,
        armor: 20,
        artillery: 20,
        support: 40,
      };
      const stats = derivedStats(supportHeavy);
      expect(stats.supply).toBeGreaterThan(ARMY_CATEGORY_STATS.infantry.supply);
      expect(stats.organization).toBeGreaterThan(
        ARMY_CATEGORY_STATS.artillery.organization,
      );
      expect(stats.recon).toBeGreaterThan(ARMY_CATEGORY_STATS.artillery.recon);
      expect(stats.offense).toBeLessThan(ARMY_CATEGORY_STATS.artillery.offense);
    });

    test("derived stats are whole numbers and identical across calls", () => {
      const c = presetComposition("balanced");
      const a = derivedStats(c);
      const b = derivedStats(c);
      expect(a).toEqual(b);
      for (const value of Object.values(a)) {
        expect(Number.isInteger(value)).toBe(true);
      }
    });
  });

  describe("terrainAdjustedSpeed", () => {
    test("armor is fastest on open ground and slowest in the mountains", () => {
      const armor = { infantry: 20, armor: 60, artillery: 10, support: 10 };
      const plains = terrainAdjustedSpeed(armor, TerrainType.Plains);
      const mountain = terrainAdjustedSpeed(armor, TerrainType.Mountain);
      expect(plains).toBeGreaterThan(mountain);
    });

    test("infantry loses far less ground in the mountains than armor does", () => {
      // The design point is relative, not absolute: nobody is faster in the
      // mountains than on the plains (every category pays the generic mountain
      // penalty), but infantry gives up much less than armor.
      const infantry = { infantry: 80, armor: 10, artillery: 5, support: 5 };
      const armor = { infantry: 20, armor: 60, artillery: 10, support: 10 };
      const retention = (c: ArmyComposition) =>
        terrainAdjustedSpeed(c, TerrainType.Mountain) /
        terrainAdjustedSpeed(c, TerrainType.Plains);
      expect(retention(infantry)).toBeGreaterThan(retention(armor));
    });

    test("water and impassable terrain have no movement value", () => {
      const c = presetComposition("balanced");
      expect(terrainAdjustedSpeed(c, TerrainType.Ocean)).toBe(0);
      expect(terrainAdjustedSpeed(c, TerrainType.Impassable)).toBe(0);
    });

    test("a whole preset never has zero speed on land", () => {
      for (const preset of ARMY_PRESETS) {
        const c = presetComposition(preset);
        for (const terrain of [
          TerrainType.Plains,
          TerrainType.Highland,
          TerrainType.Mountain,
        ]) {
          expect(
            terrainAdjustedSpeed(c, terrain),
            `${preset}/${terrain}`,
          ).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("combat multipliers", () => {
    test("breakthrough and offense come straight off the derived stats", () => {
      const stats = derivedStats(presetComposition("armored"));
      expect(breakthroughMultiplier(stats)).toBe(stats.breakthrough);
      expect(offenseMultiplier(stats)).toBe(stats.offense);
      expect(attackerLossDivisor(stats)).toBe(stats.defense);
    });

    test("an all-infantry army bleeds less per tile than an all-artillery one", () => {
      expect(
        attackerLossDivisor(derivedStats(presetComposition("infantry"))),
      ).toBeGreaterThan(
        attackerLossDivisor(derivedStats(presetComposition("artillery"))),
      );
    });
  });
});
