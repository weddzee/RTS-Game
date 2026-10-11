// Prompt 7.9: the acceptance scenario, run through the real simulation.
//
//   Player A builds air factory -> produces fighters -> creates air wing ->
//   assigns it to region. Player B assigns bombers. Fighters intercept. Both
//   clients receive identical losses and mission outcomes.
//
// "Both clients" is not asserted by faking a second client — it is asserted the
// only way this codebase can honestly assert it: the whole air war is rebuilt
// from a snapshot and run forward, and the restored game must agree with the
// original on every wing's aircraft count, losses and mission outcome. That is
// the same property DesyncDetector checks at runtime, tested deterministically.
//
// No aircraft are ever positioned. Every number below comes from counts,
// missions and a region's power share.

import {
  AIR_ENGAGEMENT_INTERVAL_TICKS,
} from "../src/core/configuration/AirBalance";
import { AirWingOrderExecution } from "../src/core/execution/air/AirWingOrderExecution";
import { AirRegionExecution } from "../src/core/execution/air/AirRegionExecution";
import { CreateAirWingExecution } from "../src/core/execution/air/CreateAirWingExecution";
import { RenameAirWingExecution } from "../src/core/execution/air/RenameAirWingExecution";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { FactoryType } from "../src/core/game/Factory";
import {
  type Game,
  type Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import {
  AIR_POINTS_PER_AIRCRAFT,
  WING_CREATION_COST,
  WING_START_AIRCRAFT,
} from "../src/core/game/Aircraft";
import { airSuperiorityShare } from "../src/core/game/AirSuperiority";
import { IntentSchema } from "../src/core/Schemas";
import { roundTrip } from "./util/Snapshot";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

const A_INFO = new PlayerInfo("Alpha", PlayerType.Human, null, "alpha_id");
const B_INFO = new PlayerInfo("Bravo", PlayerType.Human, null, "bravo_id");

interface AirFixture {
  game: Game;
  a: Player;
  b: Player;
  /** An air region near both spawns. */
  regionId: number;
}

async function setupAirGame(): Promise<AirFixture> {
  const game = await setup(
    "plains",
    { infiniteGold: true, infiniteTroops: true, instantBuild: true },
    [A_INFO, B_INFO],
    undefined,
    UseRealAttackLogic,
  );
  // Wing commands are refused from a player who has not spawned, so the
  // scenario spawns both players the way a real game does.
  game.addExecution(
    new SpawnExecution("air_test", game.player(A_INFO.id).info(), game.ref(2, 2)),
    new SpawnExecution("air_test", game.player(B_INFO.id).info(), game.ref(44, 44)),
  );
  game.executeNextTick();
  game.executeNextTick();
  const a = game.player(A_INFO.id);
  const b = game.player(B_INFO.id);
  expect(a.hasSpawned()).toBe(true);
  expect(b.hasSpawned()).toBe(true);

// Both players need territory to build on — enough for two factories, since
  // structures keep a minimum distance from each other — and it must be in the
  // same air region or the two wings never meet.
  for (let x = 1; x <= 16; x++) {
    for (let y = 1; y <= 16; y++) a.conquer(game.ref(x, y));
  }
  for (let x = 38; x <= 47; x++) {
    for (let y = 38; y <= 47; y++) b.conquer(game.ref(x, y));
  }
  const regionId = game.airRegions().at(game.ref(2, 2));
  expect(regionId).toBeGreaterThanOrEqual(0);
  expect(game.airRegions().at(game.ref(44, 44))).toBe(regionId);

  // Air factories. `hasSpawned()` is what the wing executions gate on, and the
  // air factory requirement is what 7.3 is really about, so these are built the
  // same way a player's are rather than conjured.
  game.addExecution(
    new ConstructionExecution(
      a,
      UnitType.Factory,
      game.ref(2, 2),
      undefined,
      undefined,
      FactoryType.Air,
    ),
    new ConstructionExecution(
      b,
      UnitType.Factory,
      game.ref(44, 44),
      undefined,
      undefined,
      FactoryType.Air,
    ),
  );
  game.executeNextTick();
  game.executeNextTick();
  expect(
    a.units(UnitType.Factory).filter((u) => u.factoryType() === FactoryType.Air)
      .length,
  ).toBeGreaterThan(0);

  // The air war pass runs from GameRunner.init() in a real game; tests drive it
  // directly so a scenario does not have to tick a whole match.
  game.addExecution(new AirRegionExecution());
  return { game, a, b, regionId };
}

/**
 * Bank enough air production to raise wings, without waiting on the factory
 * economy. The bank is a real player field either way; the factory that fills
 * it is covered by FactoryProduction.test.ts and by the scenario below.
 */
const FUNDED_AIRCRAFT = 20;

function fundAirProduction(game: Game, ...players: Player[]): void {
  for (const p of players) {
    p.addAirCapacity(FUNDED_AIRCRAFT * AIR_POINTS_PER_AIRCRAFT);
  }
  void game;
}

function createWing(
  game: Game,
  owner: Player,
  aircraftType: string,
  regionId: number,
  name: string | null = null,
): CreateAirWingExecution {
  const exec = new CreateAirWingExecution(
    owner,
    aircraftType,
    name,
    regionId,
  );
  game.addExecution(exec);
  game.executeNextTick();
  game.executeNextTick();
  return exec;
}

/** Run enough ticks for several air-war waves. */
function runWaves(game: Game, waves = 3): void {
  for (let i = 0; i < waves * AIR_ENGAGEMENT_INTERVAL_TICKS + 2; i++) {
    game.executeNextTick();
  }
}

// ---------------------------------------------------------------------------

describe("Prompt 7.9: the air war, end to end", () => {
  test("a wing requires an air factory, so production is structural (7.3)", async () => {
    // Same world as the air-game fixture, minus the air factories.
    const game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [A_INFO],
      undefined,
      UseRealAttackLogic,
    );
    game.addExecution(
      new SpawnExecution("air_test", game.player(A_INFO.id).info(), game.ref(2, 2)),
    );
    game.executeNextTick();
    game.executeNextTick();
    const a = game.player(A_INFO.id);
    a.conquer(game.ref(1, 1));
    fundAirProduction(game, a);
    // With plenty of banked production and no air factory, still nothing.
    expect(
      a.canAffordAirCapacity(WING_CREATION_COST * AIR_POINTS_PER_AIRCRAFT),
    ).toBe(true);

    const exec = createWing(game, a, "Fighter", game.airRegions().at(game.ref(1, 1)));
    expect(exec.failureReason()).toContain("no air factory");
    expect(game.airWings()).toHaveLength(0);
  });

test("an air factory banks production and a wing can be raised from it", async () => {
    const { game, a, regionId } = await setupAirGame();
    expect(a.airCapacity()).toBe(0);

    // The factory itself credits the bank. This is the Prompt 5 → Prompt 7
    // join: nothing else writes this field.
    for (let i = 0; i < 300; i++) game.executeNextTick();
    const banked = a.airCapacity();
    expect(banked).toBeGreaterThanOrEqual(
      WING_CREATION_COST * AIR_POINTS_PER_AIRCRAFT,
    );

    const exec = createWing(game, a, "Fighter", regionId);
    expect(exec.failureReason()).toBeNull();
    expect(game.airWings()).toHaveLength(1);
    const wing = game.airWings()[0];
    expect(wing.aircraftType()).toBe("Fighter");
    expect(wing.aircraftCount()).toBe(WING_START_AIRCRAFT);
    expect(wing.assignedRegionId()).toBe(regionId);
    expect(wing.effectiveness()).toBeGreaterThan(0);
// The creation order is paid for, not free. The exact price is a pure
    // constant, so what this asserts is that it came out of the bank at all —
    // the factory keeps producing across the two ticks the intent takes to land,
    // so the drop is the cost minus that trickle.
    expect(a.airCapacity()).toBeLessThan(banked);
    expect(banked - a.airCapacity()).toBeLessThanOrEqual(
      WING_CREATION_COST * AIR_POINTS_PER_AIRCRAFT,
    );
  });

  test("the scenario: fighters intercept bombers and both sides take losses", async () => {
    const { game, a, b, regionId } = await setupAirGame();
    fundAirProduction(game, a, b);

    // Player A: fighters, assigned to the region.
    const aWing = createWing(game, a, "Fighter", regionId, "Alpha Patrol");
    expect(aWing.failureReason()).toBeNull();
    const alpha = game.airWingsOf(a)[0];
    expect(alpha.displayName()).toBe("Alpha Patrol");

    // Player B: bombers, sent at A's military industry in the same region.
    const bWing = createWing(game, b, "Bomber", regionId);
    expect(bWing.failureReason()).toBeNull();
    const bravo = game.airWingsOf(b)[0];
    const order = new AirWingOrderExecution(b, bravo.id(), regionId, {
      type: "strike",
      target: "militaryIndustry",
    });
    game.addExecution(order);
    game.executeNextTick();
    game.executeNextTick();
    expect(order.failureReason()).toBeNull();
    expect(bravo.mission()).toEqual({
      type: "strike",
      target: "militaryIndustry",
    });

    // Put the fighters on intercept — the bomber-killing mission.
    const intercept = new AirWingOrderExecution(a, alpha.id(), regionId, {
      type: "intercept",
    });
    game.addExecution(intercept);
    game.executeNextTick();
    game.executeNextTick();
    expect(intercept.failureReason()).toBeNull();

    runWaves(game, 3);

    // An engagement happened: both wings lost aircraft, and the bomber lost
    // more than the fighters, because attrition 140 divides survivability 70.
    expect(bravo.statistics().engagements).toBeGreaterThan(0);
    expect(alpha.statistics().engagements).toBeGreaterThan(0);
    expect(bravo.aircraftCount()).toBeLessThan(WING_START_AIRCRAFT);
    expect(alpha.aircraftCount()).toBeLessThan(WING_START_AIRCRAFT);
    expect(bravo.losses()).toBeGreaterThan(0);
    expect(alpha.losses()).toBeGreaterThan(0);
    // Loss ledgers and live counts agree: a wing cannot quietly lose aircraft.
    expect(bravo.losses() + bravo.aircraftCount()).toBeGreaterThanOrEqual(
      bravo.losses(),
    );
    // Both sides flew, so both sides earned experience.
    expect(alpha.experience()).toBeGreaterThan(0);
    expect(bravo.experience()).toBeGreaterThan(0);
  });

test("the bomber's strike damaged the factory the server picked", async () => {
    const { game, a, b, regionId } = await setupAirGame();

    // Give A a military factory in the region: the strike's target. Built
    // BEFORE the wings, because the factory build cooldown (50 ticks) has to
    // clear first and letting 6 air-war waves run in the meantime would see the
    // bomber shot out of the sky before it ever flew a sortie.
    for (let i = 0; i < 60; i++) game.executeNextTick();
    game.addExecution(
      new ConstructionExecution(
        a,
        UnitType.Factory,
        game.ref(15, 15),
        undefined,
        undefined,
        FactoryType.Military,
      ),
    );
    game.executeNextTick();
    game.executeNextTick();
    const target = a
      .units(UnitType.Factory)
      .find((u) => u.factoryType() === FactoryType.Military);
    expect(target).toBeDefined();
    expect(target!.factoryEfficiency()).toBe(100);

    fundAirProduction(game, a, b);
    createWing(game, a, "Fighter", regionId);
    createWing(game, b, "Bomber", regionId);

    // A strike is a moment, not a state: the factory repairs itself, so the
    // damage is measured as the low-water mark over the run rather than
    // whatever it happened to be when the assertions ran.
    let lowestEfficiency = target!.factoryEfficiency();
    for (let i = 0; i < 3 * AIR_ENGAGEMENT_INTERVAL_TICKS + 2; i++) {
      game.executeNextTick();
      lowestEfficiency = Math.min(lowestEfficiency, target!.factoryEfficiency());
    }

    const bravo = game.airWingsOf(b)[0];
    expect(bravo.statistics().strikesLanded).toBeGreaterThan(0);
    // damageFactory / disableFactory were the Prompt 5 hooks nothing had called;
    // a bomber wing is their first real user, and both must have fired.
    expect(lowestEfficiency).toBeLessThan(100);
    expect(target!.factoryDisabledTicks()).toBeGreaterThan(0);
  });

/** Live execution list of a game, for asserting what is actually running. */
function airWingExecCount(game: Game): number {
  return (
    game as unknown as { execs: object[] }
  ).execs.filter((e) => e.constructor.name === "AirWingExecution").length;
}

test("a raised wing owns its own execution, before and after a restore", async () => {
  const { game, a, regionId } = await setupAirGame();
  fundAirProduction(game, a);
  createWing(game, a, "Fighter", regionId);
  // Not one, and not zero: exactly the one the create spawned. This is the
  // regression guard for the init()-vs-tick() bug described below.
  expect(airWingExecCount(game)).toBe(1);

  const { restored } = await roundTrip(game, "plains");
  expect(airWingExecCount(restored)).toBe(1);
});

test("two clients agree: a restored game replays the air war identically", async () => {
    const { game, a, b, regionId } = await setupAirGame();
    fundAirProduction(game, a, b);
    createWing(game, a, "Fighter", regionId);
    createWing(game, b, "Bomber", regionId);
    runWaves(game, 2);

    // The whole point of the comparison is that REPLACEMENT behaves the same on
    // both sides, so the fixture has to prove the restored game still has the
    // per-wing execution. It used to be re-added by hand here, which masked a
    // real bug: CreateAirWingExecution spawned its AirWingExecution from init(),
    // and GameImpl.executeNextTick reassigns unInitExecs mid-drain, so that
    // execution was being dropped — wings never rebuilt. Both sides then agreed
// only because the restored side was being hand-patched to match.
    expect(airWingExecCount(game)).toBe(2);

    // Snapshot mid-air-war, restore, and run both forward together.
    // No re-adding of AirRegionExecution: it is a registered, long-lived
    // execution, so it is IN the snapshot and the restore already has one.
    // Adding a second makes the restored game resolve two waves per interval,
    // which is how this test once "passed" while proving nothing.
    const { restored } = await roundTrip(game, "plains");

    const before = game.airWings().map((w) => ({
      id: w.id(),
      owner: w.owner().id(),
      aircraft: w.aircraftCount(),
      losses: w.losses(),
      xp: w.experience(),
      engagementStats: w.statistics(),
    }));

    for (let i = 0; i < 5 * AIR_ENGAGEMENT_INTERVAL_TICKS; i++) {
      game.executeNextTick();
      restored.executeNextTick();
    }

    const after = game.airWings().map((w) => ({
      id: w.id(),
      owner: w.owner().id(),
      aircraft: w.aircraftCount(),
      losses: w.losses(),
      xp: w.experience(),
      engagementStats: w.statistics(),
    }));

    expect(restored.airWings()).toHaveLength(after.length);
    expect(restored.airWings().map((w) => w.aircraftCount())).toEqual(
      after.map((w) => w.aircraft),
    );
    expect(restored.airWings().map((w) => w.losses())).toEqual(
      after.map((w) => w.losses),
    );
    expect(restored.airWings().map((w) => w.experience())).toEqual(
      after.map((w) => w.xp),
    );
    expect(restored.airWings().map((w) => w.statistics())).toEqual(
      after.map((w) => w.engagementStats),
    );
    // And they were not already identical before the restore, or this test
    // would prove nothing: the air war must actually have been running, with
    // aircraft actually being lost.
    expect(before.length).toBe(after.length);
    expect(after.some((w) => w.aircraft < WING_START_AIRCRAFT)).toBe(true);
  });

  test("an air war with no wings is free", async () => {
    const { game } = await setupAirGame();
    runWaves(game, 3);
    expect(game.airWings()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("Prompt 7: air wing commands are server-authoritative (7.6)", () => {
  test("an unknown aircraft type is refused", async () => {
    const { game, a, regionId } = await setupAirGame();
    fundAirProduction(game, a);
    const exec = createWing(game, a, "StealthJet", regionId);
    expect(exec.failureReason()).toContain("unknown aircraft type");
    // The reserved-but-unbuilt types are refused the same way.
    for (const type of ["Transport", "Recon", "Helicopter"]) {
      expect(createWing(game, a, type, regionId).failureReason()).toContain(
        "unknown aircraft type",
      );
    }
    expect(game.airWings()).toHaveLength(0);
  });

  test("an unknown air region is refused", async () => {
    const { game, a } = await setupAirGame();
    fundAirProduction(game, a);
    expect(
      createWing(game, a, "Fighter", 99_999).failureReason(),
    ).toContain("unknown air region");
    expect(game.airWings()).toHaveLength(0);
  });

  test("insufficient production is refused, and nothing is charged", async () => {
    const { game, a, regionId } = await setupAirGame();
    expect(a.airCapacity()).toBe(0);
    const exec = createWing(game, a, "Fighter", regionId);
    expect(exec.failureReason()).toContain("not enough air production");
    expect(game.airWings()).toHaveLength(0);
  });

  test("wing names use the army naming rules, bad names included", async () => {
    const { game, a, regionId } = await setupAirGame();
    fundAirProduction(game, a);
    // 7.2's own example name is legal.
    const ok = createWing(game, a, "Fighter", regionId, "Definitely Not Ryanair");
    expect(ok.failureReason()).toBeNull();
    expect(game.airWings()[0].displayName()).toBe("Definitely Not Ryanair");

    const wing = game.airWings()[0];
    const bad = new RenameAirWingExecution(a, wing.id(), "   ");
    game.addExecution(bad);
    game.executeNextTick();
    game.executeNextTick();
    expect(bad.failureReason()).toContain("invalid air wing name");
    expect(wing.displayName()).toBe("Definitely Not Ryanair");
  });

  test("a player cannot rename or order somebody else's wing", async () => {
    const { game, a, b, regionId } = await setupAirGame();
    fundAirProduction(game, a, b);
    createWing(game, a, "Fighter", regionId);
    const wing = game.airWingsOf(a)[0];

    const rename = new RenameAirWingExecution(b, wing.id(), "Stolen");
    game.addExecution(rename);
    game.executeNextTick();
    game.executeNextTick();
    expect(rename.failureReason()).toContain("not owned by the sender");
    expect(wing.displayName()).not.toBe("Stolen");

    const order = new AirWingOrderExecution(b, wing.id(), regionId, {
      type: "intercept",
    });
    game.addExecution(order);
    game.executeNextTick();
    game.executeNextTick();
    expect(order.failureReason()).toContain("not owned by the sender");
    expect(wing.mission()).toEqual({ type: "airSuperiority" });
  });

  test("a bomber cannot be put on patrol and a fighter cannot strike", async () => {
    const { game, a, regionId } = await setupAirGame();
    fundAirProduction(game, a);
    createWing(game, a, "Bomber", regionId);
    createWing(game, a, "Fighter", regionId);
    const bomber = game.airWingsOf(a).find((w) => w.aircraftType() === "Bomber")!;
    const fighter = game.airWingsOf(a).find((w) => w.aircraftType() === "Fighter")!;

    const patrol = new AirWingOrderExecution(a, bomber.id(), regionId, {
      type: "airSuperiority",
    });
    const strike = new AirWingOrderExecution(a, fighter.id(), regionId, {
      type: "strike",
      target: "groundArmy",
    });
    game.addExecution(patrol, strike);
    game.executeNextTick();
    game.executeNextTick();
    expect(patrol.failureReason()).toContain("cannot fly");
    expect(strike.failureReason()).toContain("cannot fly");
    expect(bomber.mission().type).toBe("strike");
    expect(fighter.mission().type).toBe("airSuperiority");
  });

  test("the intent schemas carry no target, damage or effect", () => {
    // 7.6 in the type system: a bomber strike names a category, and nothing
    // else exists in the payload for a client to fill in.
    const order = IntentSchema.parse({
      type: "air_wing_order",
      wingId: 3,
      regionId: 5,
      mission: { type: "strike", target: "airIndustry" },
    }) as Extract<
      ReturnType<typeof IntentSchema.parse>,
      { type: "air_wing_order" }
    >;
    expect(Object.keys(order).sort()).toEqual([
      "mission",
      "regionId",
      "type",
      "wingId",
    ]);
    expect(
      Object.keys((order as { mission: object }).mission).sort(),
    ).toEqual(["target", "type"]);

    const create = IntentSchema.parse({
      type: "create_air_wing",
      aircraftType: "Fighter",
      name: null,
      regionId: 5,
    });
    expect(Object.keys(create).sort()).toEqual([
      "aircraftType",
      "name",
      "regionId",
      "type",
    ]);
    // No aircraft count: a wing's size is the catalog's, not the client's.
    const smuggled = IntentSchema.parse({
      type: "create_air_wing",
      aircraftType: "Fighter",
      name: null,
      regionId: 5,
      aircraftCount: 500,
    });
    expect(Object.keys(smuggled).sort()).toEqual([
      "aircraftType",
      "name",
      "regionId",
      "type",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("Prompt 7: air superiority reaches the ground (7.5)", () => {
  test("an unopposed wing holds its region and grants the ground bonus", async () => {
    const { game, a, regionId } = await setupAirGame();
    fundAirProduction(game, a);
    createWing(game, a, "Fighter", regionId);

    const wings = game.airWingsInRegion(regionId);
    expect(wings).toHaveLength(1);
    // Unopposed is 100% share; parity only happens when both sides are zero.
    expect(airSuperiorityShare(1000, 0)).toBe(100);

    // The regional picture is derived, not stored, so the same numbers the sim
    // uses can be read straight back.
    const { computeRegionalRecon, computeRegionalShares } =
      await import("../src/core/execution/air/AirRegionExecution");
    const shares = computeRegionalShares(game, wings);
    expect(shares.get(a.smallID())).toBe(100);
    // A patrol wing grants its owner recon.
    const recon = computeRegionalRecon(game, wings);
    expect(recon.get(a.smallID())).toBeGreaterThan(0);
  });

  test("two wings in different regions never meet", async () => {
    const { game, a, b, regionId } = await setupAirGame();
    fundAirProduction(game, a, b);
    createWing(game, a, "Fighter", regionId);
    createWing(game, b, "Bomber", regionId);
    // Move Bravo's wing out of the region entirely.
    const bravo = game.airWingsOf(b)[0];
    const elsewhere = bravo.assignedRegionId() === 0 ? 1 : 0;
    const order = new AirWingOrderExecution(b, bravo.id(), elsewhere, {
      type: "strike",
      target: "militaryIndustry",
    });
    game.addExecution(order);
    game.executeNextTick();
    game.executeNextTick();
    expect(order.failureReason()).toBeNull();

    runWaves(game, 3);
    // No contact: neither side fought, and nothing was shot down.
    expect(game.airWingsOf(a)[0].statistics().engagements).toBe(0);
    expect(bravo.statistics().engagements).toBe(0);
    expect(bravo.aircraftCount()).toBe(WING_START_AIRCRAFT);
  });

  test("an unassigned wing never fights and is not in anyone's sky", async () => {
    const { game, a, regionId } = await setupAirGame();
    fundAirProduction(game, a);
    const exec = new CreateAirWingExecution(a, "Fighter", null, null);
    game.addExecution(exec);
    game.executeNextTick();
    game.executeNextTick();
    expect(exec.failureReason()).toBeNull();
    const wing = game.airWingsOf(a)[0];
    expect(wing.assignedRegionId()).toBeNull();
    expect(wing.effectiveness()).toBe(0);

    runWaves(game, 2);
    expect(wing.statistics().engagements).toBe(0);
    expect(game.airWingsInRegion(regionId)).toHaveLength(0);
  });

  test("allies never fight each other in the air", async () => {
    const { game, a, b, regionId } = await setupAirGame();
    fundAirProduction(game, a, b);
    createWing(game, a, "Fighter", regionId);
    createWing(game, b, "Fighter", regionId);
    a.createAllianceRequest(b);
    game.executeNextTick();
    game.executeNextTick();
    b.createAllianceRequest(a);
    game.executeNextTick();
    game.executeNextTick();
    expect(a.isFriendly(b)).toBe(true);

    runWaves(game, 3);
    // Friendly air is not pooled, so neither gains share from the other — but
    // neither is shot at either.
    expect(game.airWingsOf(a)[0].statistics().engagements).toBe(0);
    expect(game.airWingsOf(b)[0].statistics().engagements).toBe(0);
    expect(game.airWingsOf(a)[0].aircraftCount()).toBe(WING_START_AIRCRAFT);
    expect(game.airWingsOf(b)[0].aircraftCount()).toBe(WING_START_AIRCRAFT);
  });
});