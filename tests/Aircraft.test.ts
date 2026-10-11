// Aircraft: types, missions, regions and the air-superiority formula.
//
// These are pure modules with no game state, so the whole air-war model can be
// checked without a map, a player or a tick. That is deliberate — 7.7 asks for
// a readable and testable formula, and a formula you can only test by building
// an air war is neither.
//
// Almost everything here is an exact-value assertion rather than a tolerance
// check: two clients run the same turns and must reach the same numbers, so a
// "close enough" test would hide exactly the divergence that matters.

import {
  AIRCRAFT_CATALOG,
  AIRCRAFT_TYPES,
  type AircraftType,
  AIR_MISSION_TYPES,
  AircraftType as Types,
  aircraftDef,
  airMissionType,
  BOMBER_TARGET_CATEGORIES,
  defaultMissionFor,
  emptyAirWingState,
  FUTURE_AIRCRAFT_TYPES,
  isAircraftType,
  isAirMissionType,
  isBomberTargetCategory,
  validateAirMission,
  WING_CREATION_COST,
  WING_MAX_AIRCRAFT,
  WING_MAX_QUALITY_TIER,
  WING_QUALITY_THRESHOLDS,
  WING_START_AIRCRAFT,
  wingEffectiveness,
  wingQualityTier,
  wingTierBonusPercent,
} from "../src/core/game/Aircraft";
import {
  AIR_DAMAGE_PER_AIRCRAFT_LOST,
  AIR_GROUND_DEFENSE_BONUS_MAX_PERCENT,
  AIR_PARITY_PERCENT,
  AIR_SUPERIORITY_THRESHOLD_PERCENT,
  AIR_WAVE_DAMAGE_DIVISOR,
  airGroundDefenseBonusPercent,
  airSuperiorityShare,
  airWaveDamage,
  aircraftDestroyedInWave,
  aircraftLostInWave,
  bomberStrikePercent,
  fighterDamageVs,
  holdsAirSuperiority,
  missionEfficiencyPercent,
  RECON_BONUS_MAX_PERCENT,
  reconBonusPercent,
  regionalAirPicture,
  STRIKE_TARGET_WEIGHT,
  wingPower,
  wingQualityPercent,
} from "../src/core/game/AirSuperiority";
import {
  airRegionColumnLabel,
  airRegionIndexAt,
  airRegionLabel,
  airRegionLayoutFor,
  AIR_REGION_TARGET_TILES,
  MAX_AXIS_REGIONS,
} from "../src/core/game/AirRegion";

// ---------------------------------------------------------------------------

describe("Aircraft types (7.1)", () => {
  test("the first build is a fighter and a bomber", () => {
    expect(AIRCRAFT_TYPES).toEqual(["Fighter", "Bomber"]);
    expect(isAircraftType("Fighter")).toBe(true);
    expect(isAircraftType("Bomber")).toBe(true);
  });

  test("the reserved types exist but are not buildable", () => {
    // 7.1 asks for architecture room for Transport, Recon and Helicopter. They
    // are named here so the list is a real thing, but `isAircraftType` must
    // refuse them: an intent naming one is rejected exactly as an unknown
    // string is, which is what keeps them "later" rather than "half-built".
    expect(FUTURE_AIRCRAFT_TYPES).toEqual([
      "Transport",
      "Recon",
      "Helicopter",
    ]);
    for (const type of FUTURE_AIRCRAFT_TYPES) {
      expect(isAircraftType(type)).toBe(false);
      expect(AIRCRAFT_CATALOG[type as AircraftType]).toBeUndefined();
    }
  });

  test("the catalog gives each type a mission set and a toughness", () => {
    expect(AIRCRAFT_CATALOG[Types.Fighter].missions).toEqual([
      "airSuperiority",
      "intercept",
    ]);
    expect(AIRCRAFT_CATALOG[Types.Bomber].missions).toEqual(["strike"]);
    // Bombers lose more per enemy aircraft they shoot down than fighters do, which
    // is the whole reason a bomber wing needs escorts.
    expect(aircraftDef(Types.Bomber).attrition / aircraftDef(Types.Bomber).survivability).toBeGreaterThan(
      aircraftDef(Types.Fighter).attrition / aircraftDef(Types.Fighter).survivability,
    );
    // Only bombers strike.
    expect(aircraftDef(Types.Fighter).strikePower).toBe(0);
    expect(aircraftDef(Types.Bomber).strikePower).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("Missions (7.5, 7.6)", () => {
  test("fighters fly air superiority and intercept; bombers strike", () => {
    expect(AIR_MISSION_TYPES).toEqual([
      "airSuperiority",
      "intercept",
      "strike",
    ]);
    for (const type of AIRCRAFT_TYPES) {
      for (const mission of aircraftDef(type).missions) {
        // A strike also has to name what it is striking; see the next test for
        // the missing-target case.
        const candidate =
          mission === "strike"
            ? { type: "strike", target: "militaryIndustry" }
            : { type: mission };
        expect(validateAirMission(candidate, type)).not.toBeNull();
      }
    }
  });

  test("a fighter cannot be sent to strike, and a bomber cannot patrol", () => {
    expect(
      validateAirMission({ type: "strike", target: "militaryIndustry" }, Types.Fighter),
    ).toBeNull();
    expect(validateAirMission({ type: "airSuperiority" }, Types.Bomber)).toBeNull();
    expect(validateAirMission({ type: "intercept" }, Types.Bomber)).toBeNull();
  });

  test("a strike must name a real target category", () => {
    expect(BOMBER_TARGET_CATEGORIES).toEqual([
      "militaryIndustry",
      "airIndustry",
      "groundArmy",
      "infrastructure",
    ]);
    for (const target of BOMBER_TARGET_CATEGORIES) {
      expect(validateAirMission({ type: "strike", target }, Types.Bomber)).toEqual({
        type: "strike",
        target,
      });
      expect(isBomberTargetCategory(target)).toBe(true);
    }
    expect(validateAirMission({ type: "strike" }, Types.Bomber)).toBeNull();
    expect(
      validateAirMission({ type: "strike", target: "civilians" }, Types.Bomber),
    ).toBeNull();
  });

  test("there is no way to express a target beyond a category", () => {
    // 7.6: "Do not allow client to claim arbitrary damage." The mission type
    // has no tile, no unit id and no damage field at all, so a client cannot
    // send one — this is structural, not a check that could be forgotten.
    for (const mission of [
      { type: "strike", target: "militaryIndustry" },
      { type: "airSuperiority" },
      { type: "intercept" },
    ]) {
      expect(Object.keys(mission).sort()).toEqual(
        "target" in mission ? ["target", "type"] : ["type"],
      );
    }
  });

  test("fighter missions must not carry a target category", () => {
    expect(
      validateAirMission({ type: "intercept", target: "groundArmy" }, Types.Fighter),
    ).toBeNull();
  });

  test("nonsense is refused rather than coerced", () => {
    expect(validateAirMission(null, Types.Fighter)).toBeNull();
    expect(validateAirMission({ type: "nope" }, Types.Fighter)).toBeNull();
    expect(validateAirMission({ type: "intercept" }, Types.Fighter)).toEqual({
      type: "intercept",
    });
    expect(isAirMissionType("nope")).toBe(false);
  });

  test("a new wing starts on its type's default mission", () => {
    expect(defaultMissionFor(Types.Fighter)).toEqual({ type: "airSuperiority" });
    expect(defaultMissionFor(Types.Bomber)).toEqual({
      type: "strike",
      target: "militaryIndustry",
    });
    expect(airMissionType({ type: "intercept" })).toBe("intercept");
  });
});

// ---------------------------------------------------------------------------

describe("Wing state (7.2)", () => {
  test("a fresh wing has exactly the fields the spec lists", () => {
    const state = emptyAirWingState(3, 7, Types.Fighter);
    expect(state.id).toBe(3);
    expect(state.ownerID).toBe(7);
    expect(state.aircraftType).toBe("Fighter");
    expect(state.aircraftCount).toBe(WING_START_AIRCRAFT);
    expect(state.experience).toBe(0);
    expect(state.regionId).toBeNull();
    expect(state.mission).toEqual({ type: "airSuperiority" });
    expect(state.losses).toBe(0);
    expect(state.isActive).toBe(true);
  });

  test("quality tiers rise monotonically and stop at the top", () => {
    expect(wingQualityTier(-5)).toBe(1);
    expect(wingQualityTier(0)).toBe(1);
    for (let tier = 2; tier <= WING_MAX_QUALITY_TIER; tier++) {
      expect(wingQualityTier(WING_QUALITY_THRESHOLDS[tier])).toBe(tier);
      expect(wingQualityTier(WING_QUALITY_THRESHOLDS[tier] - 1)).toBe(tier - 1);
    }
    expect(wingQualityTier(1_000_000)).toBe(WING_MAX_QUALITY_TIER);
    // Bounded, so a long match cannot produce an unbeatable wing.
    expect(wingTierBonusPercent(1)).toBe(0);
    let previous = 0;
    for (let tier = 1; tier <= WING_MAX_QUALITY_TIER; tier++) {
      const bonus = wingTierBonusPercent(tier);
      expect(bonus).toBeGreaterThanOrEqual(previous);
      previous = bonus;
    }
    expect(previous).toBeLessThan(100);
  });

  test("effectiveness is 0 unassigned and rises with size and experience", () => {
    expect(
      wingEffectiveness({
        aircraftCount: WING_START_AIRCRAFT,
        experience: 0,
        regionId: null,
      }),
    ).toBe(0);
    const small = wingEffectiveness({
      aircraftCount: 4,
      experience: 0,
      regionId: 1,
    });
    const full = wingEffectiveness({
      aircraftCount: WING_START_AIRCRAFT,
      experience: 0,
      regionId: 1,
    });
    expect(small).toBeLessThan(full);
    // Experience adds on top of size, so it can only be seen on a wing that is
    // not already pinned at the ceiling.
    const veteran = wingEffectiveness({
      aircraftCount: 4,
      experience: WING_QUALITY_THRESHOLDS[3],
      regionId: 1,
    });
    expect(veteran).toBeGreaterThan(small);
    // Bounded at 100.
    expect(
      wingEffectiveness({
        aircraftCount: WING_MAX_AIRCRAFT,
        experience: 1_000_000,
        regionId: 1,
      }),
    ).toBe(100);
  });

  test("wing sizing constants agree with each other", () => {
    expect(WING_MAX_AIRCRAFT).toBeGreaterThan(WING_START_AIRCRAFT);
    expect(WING_CREATION_COST).toBeGreaterThan(0);
    expect(WING_CREATION_COST).toBeLessThanOrEqual(WING_START_AIRCRAFT);
  });
});

// ---------------------------------------------------------------------------

describe("Air regions (7.4)", () => {
  test("a Standard map lands in a usable number of regions", () => {
    const layout = airRegionLayoutFor(2000, 1200);
    expect(layout.cols).toBeGreaterThan(1);
    expect(layout.rows).toBeGreaterThan(1);
    expect(layout.count).toBe(layout.cols * layout.rows);
    // Roughly the target area, within a factor of two per axis — the point is
    // "tens of regions on a real map", not an exact partition.
    const area = layout.regionWidth * layout.regionHeight;
    expect(area).toBeGreaterThan(AIR_REGION_TARGET_TILES / 4);
    expect(area).toBeLessThan(AIR_REGION_TARGET_TILES * 16);
  });

  test("the axes are capped so a giant map cannot explode", () => {
    for (const [w, h] of [
      [6000, 400],
      [2000, 2000],
      [5536, 276],
    ]) {
      const layout = airRegionLayoutFor(w, h);
      expect(layout.cols).toBeLessThanOrEqual(MAX_AXIS_REGIONS);
      expect(layout.rows).toBeLessThanOrEqual(MAX_AXIS_REGIONS);
    }
  });

  test("a degenerate map still gets at least one region", () => {
    const layout = airRegionLayoutFor(1, 1);
    expect(layout.count).toBe(1);
    expect(airRegionIndexAt(layout, 0, 0)).toBe(0);
  });

  test("the partition is total: every tile lands in exactly one region", () => {
    const width = 517;
    const height = 311;
    const layout = airRegionLayoutFor(width, height);
    const seen = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = airRegionIndexAt(layout, x, y);
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(layout.count);
        seen.add(id);
      }
    }
    // Every declared region is reachable: no holes in the grid.
    expect(seen.size).toBe(layout.count);
  });

  test("the partition is derived only from map size, so both sides agree", () => {
    // No map, no player, no tick — the same dimensions must always give the
    // same layout, or two clients would number regions differently and a wing
    // assigned to "region 4" would be somewhere else on the other peer.
    for (let i = 0; i < 5; i++) {
      expect(airRegionLayoutFor(2000, 1200)).toEqual(
        airRegionLayoutFor(2000, 1200),
      );
    }
    expect(airRegionLayoutFor(1000, 600).count).not.toBe(
      airRegionLayoutFor(2000, 1200).count,
    );
  });

  test("off-map coordinates clamp to the nearest region rather than escaping", () => {
    const layout = airRegionLayoutFor(2000, 1200);
    expect(airRegionIndexAt(layout, -5, -5)).toBe(0);
    expect(airRegionIndexAt(layout, 99_999, 99_999)).toBe(layout.count - 1);
  });

  test("column labels are Excel-style so a wide grid stays readable", () => {
    expect(airRegionColumnLabel(0)).toBe("A");
    expect(airRegionColumnLabel(25)).toBe("Z");
    expect(airRegionColumnLabel(26)).toBe("AA");
    expect(airRegionColumnLabel(27)).toBe("AB");
  });

  test("region labels are stable and unique", () => {
    const layout = airRegionLayoutFor(2000, 1200);
    const labels = new Set<string>();
    for (let id = 0; id < layout.count; id++) {
      const label = airRegionLabel(layout, id);
      expect(label).toBe(airRegionLabel(layout, id));
      expect(labels.has(label)).toBe(false);
      labels.add(label);
    }
  });
});

// ---------------------------------------------------------------------------

describe("Air superiority (7.7)", () => {
  test("share is a plain fraction of combined power", () => {
    expect(airSuperiorityShare(0, 0)).toBe(AIR_PARITY_PERCENT);
    expect(airSuperiorityShare(100, 0)).toBe(100);
    expect(airSuperiorityShare(0, 100)).toBe(0);
    expect(airSuperiorityShare(100, 100)).toBe(AIR_PARITY_PERCENT);
    expect(airSuperiorityShare(300, 100)).toBe(75);
    expect(airSuperiorityShare(100, 300)).toBe(25);
  });

  test("an empty sky is parity, not a win", () => {
    // A player who has lost every wing must not read their own map as total
    // air control, so zero-versus-zero is 50 rather than 0 or 100.
    expect(airSuperiorityShare(0, 0)).toBe(50);
    expect(holdsAirSuperiority(airSuperiorityShare(0, 0))).toBe(false);
  });

  test("negative and fractional inputs cannot produce nonsense", () => {
    expect(airSuperiorityShare(-5, -5)).toBe(AIR_PARITY_PERCENT);
    expect(airSuperiorityShare(1, 2)).toBe(33);
  });

  test("wing power is aircraft x quality x mission efficiency", () => {
    // 8 baseline aircraft, neutral mission, no doctrine bonus: 8 * 100 * 100/10000.
    expect(wingPower(8, { type: "airSuperiority" }, 0, 0)).toBe(8);
    // A doctrine bonus multiplies in.
    expect(wingPower(8, { type: "airSuperiority" }, 0, 30)).toBe(10);
    // Experience multiplies in through quality.
    const veteran = wingPower(8, { type: "airSuperiority" }, 1400, 0);
    expect(veteran).toBeGreaterThan(8);
    // Intercepting realises less of a wing's potential than patrolling.
    expect(wingPower(8, { type: "intercept" }, 0, 0)).toBeLessThan(
      wingPower(8, { type: "airSuperiority" }, 0, 0),
    );
    // Nothing in, nothing out.
    expect(wingPower(0, { type: "airSuperiority" }, 0, 0)).toBe(0);
    // And the ceiling holds.
    expect(wingPower(10_000, { type: "airSuperiority" }, 0, 0)).toBe(
      wingPower(WING_MAX_AIRCRAFT, { type: "airSuperiority" }, 0, 0),
    );
  });

  test("the five inputs all reach the formula", () => {
    const base = wingPower(8, { type: "airSuperiority" }, 0, 0);
    // fighter count
    expect(wingPower(4, { type: "airSuperiority" }, 0, 0)).toBeLessThan(base);
    // quality
    expect(wingPower(8, { type: "airSuperiority" }, 1400, 0)).toBeGreaterThan(
      base,
    );
    // doctrine bonus
    expect(wingPower(8, { type: "airSuperiority" }, 0, 50)).toBeGreaterThan(
      base,
    );
    // mission efficiency
    expect(wingPower(8, { type: "intercept" }, 0, 0)).toBeLessThan(base);
    // losses, through the aircraft count
    expect(wingPower(2, { type: "airSuperiority" }, 0, 0)).toBeLessThan(base);
  });

  test("quality is a bounded percent above the 100 baseline", () => {
    expect(wingQualityPercent(0, 0)).toBe(100);
    expect(wingQualityPercent(WING_QUALITY_THRESHOLDS[2], 0)).toBe(110);
    expect(wingQualityPercent(1_000_000, 0)).toBe(145);
    expect(wingQualityPercent(0, 30)).toBe(130);
  });

  test("intercept is the bomber-killer and air superiority is not", () => {
    expect(fighterDamageVs({ type: "intercept" }, Types.Bomber)).toBeGreaterThan(
      fighterDamageVs({ type: "airSuperiority" }, Types.Bomber),
    );
    // Against other fighters the two missions are close: chasing bombers costs
    // a patrol some of its general punch.
    expect(
      fighterDamageVs({ type: "airSuperiority" }, Types.Fighter),
    ).toBeGreaterThan(fighterDamageVs({ type: "intercept" }, Types.Fighter));
  });

  test("mission efficiency is a plain percent table", () => {
    expect(missionEfficiencyPercent({ type: "airSuperiority" })).toBe(100);
    expect(missionEfficiencyPercent({ type: "strike", target: "groundArmy" })).toBe(
      100,
    );
    const intercept = missionEfficiencyPercent({ type: "intercept" });
    expect(intercept).toBeGreaterThan(0);
    expect(intercept).toBeLessThan(100);
  });

  test("superiority is only claimed at or above the threshold", () => {
    expect(holdsAirSuperiority(AIR_SUPERIORITY_THRESHOLD_PERCENT)).toBe(true);
    expect(holdsAirSuperiority(AIR_SUPERIORITY_THRESHOLD_PERCENT - 1)).toBe(
      false,
    );
    expect(holdsAirSuperiority(100)).toBe(true);
    expect(holdsAirSuperiority(0)).toBe(false);
  });
});

describe("Air engagements", () => {
  test("wave damage is aircraft x quality x vs-that-type", () => {
    // 8 aircraft, 100% quality, 110% vs fighters:
    // 8 * 100 * 110 / AIR_WAVE_DAMAGE_DIVISOR.
    expect(
      airWaveDamage(8, { type: "airSuperiority" }, 0, 0, Types.Fighter),
    ).toBe((8 * 100 * 110) / AIR_WAVE_DAMAGE_DIVISOR);
    // An interceptor hits a bomber much harder than a patrol does.
    expect(
      airWaveDamage(8, { type: "intercept" }, 0, 0, Types.Bomber),
    ).toBeGreaterThan(
      airWaveDamage(8, { type: "airSuperiority" }, 0, 0, Types.Bomber),
    );
    // Nothing in, nothing out.
    expect(
      airWaveDamage(0, { type: "airSuperiority" }, 0, 0, Types.Fighter),
    ).toBe(0);
  });

  test("two baseline fighter wings trade aircraft rather than annihilating", () => {
    // This is the calibration that matters: an even air fight must be a grind,
    // not a coin flip decided in one wave.
    const damage = airWaveDamage(8, { type: "airSuperiority" }, 0, 0, Types.Fighter);
    const destroyed = aircraftDestroyedInWave(8, damage);
    const lost = aircraftLostInWave(Types.Fighter, 8, damage);
    // A wing trades roughly one aircraft per wave for roughly one, so an even
    // fight lasts many waves instead of one.
    expect(destroyed).toBeGreaterThanOrEqual(1);
    expect(destroyed).toBeLessThanOrEqual(2);
    expect(lost).toBeGreaterThanOrEqual(1);
    expect(lost).toBeLessThanOrEqual(2);
  });

  test("kills never exceed the wing being shot at", () => {
    expect(aircraftDestroyedInWave(1, 10_000)).toBe(1);
    expect(aircraftDestroyedInWave(0, 10_000)).toBe(0);
    expect(aircraftLostInWave(Types.Fighter, 1, 10_000)).toBeLessThanOrEqual(1);
    expect(aircraftLostInWave(Types.Fighter, 0, 10_000)).toBe(0);
    expect(aircraftLostInWave(Types.Fighter, 8, 0)).toBe(0);
  });

  test("a bomber caught by fighters loses far more than it shoots down", () => {
    // This ratio is the reason a bomber wing wants escorts, and the reason
    // strike-power alone is not an answer to air superiority.
    const against = airWaveDamage(8, { type: "intercept" }, 0, 0, Types.Bomber);
    const kills = aircraftDestroyedInWave(8, against);
    const losses = aircraftLostInWave(Types.Bomber, 8, against);
    expect(losses).toBeGreaterThan(kills);
  });

  test("damage points convert at a fixed, documented rate", () => {
    expect(aircraftDestroyedInWave(10, AIR_DAMAGE_PER_AIRCRAFT_LOST)).toBe(1);
    expect(aircraftDestroyedInWave(10, AIR_DAMAGE_PER_AIRCRAFT_LOST - 1)).toBe(
      0,
    );
    expect(aircraftDestroyedInWave(10, AIR_DAMAGE_PER_AIRCRAFT_LOST * 3)).toBe(
      3,
    );
  });
});

describe("Bomber strikes (7.6)", () => {
  test("industry is worth more than a city, and an unknown target is floored", () => {
    expect(STRIKE_TARGET_WEIGHT["militaryIndustry"]).toBeGreaterThan(
      STRIKE_TARGET_WEIGHT["infrastructure"],
    );
    expect(bomberStrikePercent("militaryIndustry", 0, 0)).toBeGreaterThan(
      bomberStrikePercent("civilians", 0, 0),
    );
  });

  test("the defender's air share blunts a strike without negating it", () => {
    const open = bomberStrikePercent("militaryIndustry", 0, 0);
    const contested = bomberStrikePercent("militaryIndustry", 50, 0);
    const controlled = bomberStrikePercent("militaryIndustry", 100, 0);
    expect(contested).toBeLessThan(open);
    expect(controlled).toBeLessThan(contested);
    // Even total air control leaves a strike worth something: a bomber that got
    // through is a bomber that got through.
    expect(controlled).toBeGreaterThan(0);
  });

  test("recon sharpens a strike", () => {
    expect(bomberStrikePercent("militaryIndustry", 50, 30)).toBeGreaterThan(
      bomberStrikePercent("militaryIndustry", 50, 0),
    );
  });

  test("recon comes from patrol wings and is capped", () => {
    expect(reconBonusPercent(0)).toBe(0);
    expect(reconBonusPercent(-3)).toBe(0);
    expect(reconBonusPercent(1)).toBeGreaterThan(0);
    expect(reconBonusPercent(100)).toBe(RECON_BONUS_MAX_PERCENT);
  });

  test("out-of-range shares and recon cannot invert the strike", () => {
    expect(bomberStrikePercent("groundArmy", -50, 0)).toBe(
      bomberStrikePercent("groundArmy", 0, 0),
    );
    expect(bomberStrikePercent("groundArmy", 500, 0)).toBe(
      bomberStrikePercent("groundArmy", 100, 0),
    );
    expect(bomberStrikePercent("groundArmy", 100, -100)).toBeGreaterThan(0);
  });
});

describe("Ground-combat modifier (7.5)", () => {
  test("it is zero below the superiority threshold", () => {
    expect(airGroundDefenseBonusPercent(0)).toBe(0);
    expect(airGroundDefenseBonusPercent(50)).toBe(0);
    expect(
      airGroundDefenseBonusPercent(AIR_SUPERIORITY_THRESHOLD_PERCENT - 1),
    ).toBe(0);
  });

  test("it rises with superiority but stays small", () => {
    expect(airGroundDefenseBonusPercent(100)).toBe(
      AIR_GROUND_DEFENSE_BONUS_MAX_PERCENT,
    );
    expect(
      airGroundDefenseBonusPercent(AIR_SUPERIORITY_THRESHOLD_PERCENT),
    ).toBe(0);
    const middle = airGroundDefenseBonusPercent(80);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(AIR_GROUND_DEFENSE_BONUS_MAX_PERCENT);
    // A sky full of fighters tilts a ground fight; it does not decide it.
    expect(AIR_GROUND_DEFENSE_BONUS_MAX_PERCENT).toBeLessThan(25);
  });

  test("the regional picture assembles the same numbers", () => {
    const picture = regionalAirPicture(300, 100, 2);
    expect(picture.ownPower).toBe(300);
    expect(picture.enemyPower).toBe(100);
    expect(picture.sharePercent).toBe(75);
    expect(picture.holdsSuperiority).toBe(true);
    expect(picture.groundDefenseBonusPercent).toBeGreaterThan(0);
    expect(picture.reconBonusPercent).toBeGreaterThan(0);

    const empty = regionalAirPicture(0, 0, 0);
    expect(empty.sharePercent).toBe(50);
    expect(empty.holdsSuperiority).toBe(false);
    expect(empty.groundDefenseBonusPercent).toBe(0);
    expect(empty.reconBonusPercent).toBe(0);
  });
});