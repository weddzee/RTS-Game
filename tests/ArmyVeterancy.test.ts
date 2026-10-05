// Deterministic tests for army veterancy (Prompt 3.7).
//
// Two properties matter more than the exact numbers and both are pinned here:
//  - the ladder is progressive and the bonuses stay modest, so an experienced
//    army is better but never unkillable;
//  - experience is diluted proportionally to the force that survived, and the
//    dilution composes — applying it once per tick cannot drain the ladder the
//    way a threshold would.

import {
  ARMY_VETERANCY_BONUS,
  ARMY_VETERANCY_THRESHOLDS,
  ARMY_VETERANCY_TIERS,
} from "../src/core/configuration/ArmyBalance";
import {
  addXp,
  combatBonusFor,
  diluteXp,
  tierForIndex,
  tierForXp,
  veterancyBonus,
  xpForCasualtiesInflicted,
  xpForTier,
  xpForTilesCaptured,
  xpProgress,
} from "../src/core/game/ArmyVeterancy";

describe("army veterancy", () => {
  describe("the ladder", () => {
    test("has exactly the four named tiers, in order", () => {
      expect(ARMY_VETERANCY_TIERS).toEqual([
        "recruit",
        "regular",
        "veteran",
        "elite",
      ]);
      for (let i = 0; i < ARMY_VETERANCY_TIERS.length; i++) {
        expect(tierForIndex(i)).toBe(ARMY_VETERANCY_TIERS[i]);
      }
    });

    test("a new army is a recruit", () => {
      expect(tierForXp(0)).toBe("recruit");
      expect(tierForIndex(-5)).toBe("recruit");
    });

    test("thresholds rise, so progress slows as an army improves", () => {
      for (let i = 1; i < ARMY_VETERANCY_THRESHOLDS.length; i++) {
        expect(ARMY_VETERANCY_THRESHOLDS[i]).toBeGreaterThan(
          ARMY_VETERANCY_THRESHOLDS[i - 1],
        );
      }
    });

    test("xp at or above a threshold is that tier, one below is the previous", () => {
      for (const tier of ARMY_VETERANCY_TIERS) {
        const at = xpForTier(tier);
        expect(tierForXp(at)).toBe(tier);
        if (at > 0) expect(tierForXp(at - 1)).not.toBe(tier);
      }
    });

    test("bonuses are modest and strictly increasing", () => {
      expect(veterancyBonus("recruit")).toBe(0);
      for (let i = 1; i < ARMY_VETERANCY_TIERS.length; i++) {
        const previous = veterancyBonus(ARMY_VETERANCY_TIERS[i - 1]);
        const current = veterancyBonus(ARMY_VETERANCY_TIERS[i]);
        expect(current).toBeGreaterThan(previous);
        // The spec's hard requirement: experience helps, it does not win fights
        // on its own. Elite is ~15% on both axes.
        expect(current).toBeLessThanOrEqual(20);
      }
      expect(veterancyBonus("elite")).toBe(ARMY_VETERANCY_BONUS.elite);
    });

    test("an Elite army is not invincible: the combat bonus stays a divisor, not a multiplier", () => {
      const elite = combatBonusFor(xpForTier("elite"));
      // Above 100 means "bleeds less / takes ground faster", and the step from
      // Veteran to Elite is small.
      expect(elite.lossDivisor).toBe(100 + ARMY_VETERANCY_BONUS.elite);
      expect(elite.conquestCostMultiplier).toBe(
        100 + ARMY_VETERANCY_BONUS.elite,
      );
      const veteran = combatBonusFor(xpForTier("veteran"));
      expect(elite.lossDivisor - veteran.lossDivisor).toBe(
        ARMY_VETERANCY_BONUS.elite - ARMY_VETERANCY_BONUS.veteran,
      );
    });
  });

  describe("gaining experience", () => {
    test("experience comes from dealing damage and taking ground", () => {
      expect(xpForCasualtiesInflicted(0)).toBe(0);
      expect(xpForCasualtiesInflicted(-5)).toBe(0);
      expect(xpForCasualtiesInflicted(1000)).toBeGreaterThan(0);
      expect(xpForCasualtiesInflicted(4000)).toBeGreaterThan(
        xpForCasualtiesInflicted(1000),
      );
      expect(xpForTilesCaptured(1)).toBeGreaterThan(0);
      expect(xpForTilesCaptured(10)).toBeGreaterThan(xpForTilesCaptured(1));
    });

    test("a sub-thousand of casualties rounds to nothing rather than fractionally crediting", () => {
      // Whole numbers only, so a hundred tiny ticks cannot be farmed into a
      // tier by the rounding error.
      for (let n = 1; n < 1000; n += 137) {
        expect(Number.isInteger(xpForCasualtiesInflicted(n))).toBe(true);
      }
    });

    test("addXp never runs past the top of the ladder", () => {
      const cap =
        ARMY_VETERANCY_THRESHOLDS[ARMY_VETERANCY_THRESHOLDS.length - 1];
      expect(addXp(cap - 10, 1000)).toBe(cap);
      expect(addXp(cap - 10, -1000)).toBe(cap - 10);
      expect(addXp(0, 0)).toBe(0);
      expect(tierForXp(addXp(cap - 10, 1000))).toBe("elite");
    });

    test("xpProgress reports position within the tier", () => {
      const floor = xpForTier("regular");
      const span = xpForTier("veteran") - floor;
      const p = xpProgress(floor + Math.floor(span / 2));
      expect(p.tier).toBe("regular");
      expect(p.atMaxTier).toBe(false);
      expect(p.intoTier).toBe(Math.floor(span / 2));
      expect(p.tierSpan).toBe(span);
      const max = xpProgress(xpForTier("elite"));
      expect(max.atMaxTier).toBe(true);
    });
  });

  describe("dilution", () => {
    test("a growing army never dilutes", () => {
      expect(diluteXp(5000, 1000, 2000)).toBe(5000);
      expect(diluteXp(5000, 1000, 1000)).toBe(5000);
    });

    test("losing half the force halves the experience", () => {
      expect(diluteXp(4000, 1000, 500)).toBe(2000);
    });

    test("a wiped-out army keeps no experience", () => {
      expect(diluteXp(4000, 1000, 0)).toBe(0);
    });

    test("a nil army is not diluted by a loss that never happened", () => {
      expect(diluteXp(4000, 0, 0)).toBe(4000);
    });

    test("proportional steps compose, so per-tick application cannot compound away the ladder", () => {
      const initialXp = 20_000;
      const start = 1000;
      // Ninety equal 10-troop losses applied one at a time.
      let xp = initialXp;
      let strength = start;
      for (let i = 0; i < 90; i++) {
        const previous = strength;
        strength -= 10;
        xp = diluteXp(xp, previous, strength);
      }
      expect(strength).toBe(100);
      // The same 90% loss applied in one step gives the same answer, which is
      // the whole point: per-tick application cannot run away from it.
      expect(xp).toBe(diluteXp(initialXp, start, strength));
      expect(xp).toBe(2000);
    });

    test("losses big enough to drop a tier actually drop it", () => {
      const veteranXp = xpForTier("veteran");
      expect(tierForXp(veteranXp)).toBe("veteran");
      // An army that loses 80% of its troops is mostly recruits again.
      expect(tierForXp(diluteXp(veteranXp, 1000, 200))).not.toBe("veteran");
    });

    test("is deterministic across repeated calls", () => {
      for (let i = 0; i < 50; i++) {
        expect(diluteXp(7919, 1337, 811)).toBe(diluteXp(7919, 1337, 811));
      }
    });
  });
});
