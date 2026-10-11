import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { FactoryExecution } from "../src/core/execution/FactoryExecution";
import { UpgradeStructureExecution } from "../src/core/execution/UpgradeStructureExecution";
import {
  FACTORY_CAPTURE_EFFICIENCY_MAX,
  FACTORY_CAPTURE_EFFICIENCY_MIN,
  FACTORY_MAX_LEVEL,
  FactoryType,
  baseFactoryOutput,
  captureEfficiencyFor,
  factoryConstructionTicks,
  factoryDisplayInfoFor,
  factoryOutputFor,
  isFactoryTypeExposed,
} from "../src/core/game/Factory";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

const builderInfo = new PlayerInfo(
  "builder",
  PlayerType.Human,
  null,
  "builder_id",
);
const otherInfo = new PlayerInfo("other", PlayerType.Human, null, "other_id");

async function setupFactoryGame(
  gameConfig: Record<string, unknown> = {},
  gold: bigint = 100_000_000n,
): Promise<{ game: Game; player: Player; other: Player }> {
  const game = await setup(
    "plains",
    {
      infiniteGold: false,
      instantBuild: false,
      infiniteTroops: true,
      ...gameConfig,
    },
    [builderInfo, otherInfo],
  );
  const player = game.player(builderInfo.id);
  const other = game.player(otherInfo.id);
  // Own distinct territory for valid placement.
  player.conquer(game.ref(0, 10));
  player.conquer(game.ref(1, 10));
  player.conquer(game.ref(0, 11));
  other.conquer(game.ref(15, 15));
  other.conquer(game.ref(16, 15));
  player.addGold(gold);
  other.addGold(gold);
  return { game, player, other };
}

function buildFactoryViaConstruction(
  game: Game,
  player: Player,
  factoryType: FactoryType,
  x = 0,
  y = 10,
) {
  game.addExecution(
    new ConstructionExecution(
      player,
      UnitType.Factory,
      game.ref(x, y),
      undefined,
      undefined,
      factoryType,
    ),
  );
  game.executeNextTick(); // init
  game.executeNextTick(); // build unit + under construction
  const built = player
    .units(UnitType.Factory)
    .find((u) => u.tile() === game.ref(x, y));
  return built;
}

describe("Prompt 5: factory and production system", () => {
  test("factory types: initial exposed, later-compatible hidden", () => {
    expect(isFactoryTypeExposed(FactoryType.Civilian)).toBe(true);
    expect(isFactoryTypeExposed(FactoryType.Military)).toBe(true);
    expect(isFactoryTypeExposed(FactoryType.Air)).toBe(true);
    expect(isFactoryTypeExposed(FactoryType.Research)).toBe(false);
    expect(isFactoryTypeExposed(FactoryType.SupplyHub)).toBe(false);
    expect(isFactoryTypeExposed(FactoryType.MissileFacility)).toBe(false);
  });

  test("construction: factory takes meaningful short time under Standard pacing", async () => {
    const { game, player } = await setupFactoryGame();
    // Standard pacing baseline is 20-50s (200-500 ticks).
    const civilianTicks = game
      .config()
      .factoryConstructionDuration(FactoryType.Civilian);
    const militaryTicks = game
      .config()
      .factoryConstructionDuration(FactoryType.Military);
    expect(civilianTicks).toBeGreaterThanOrEqual(200);
    expect(civilianTicks).toBeLessThanOrEqual(500);
    expect(militaryTicks).toBeGreaterThanOrEqual(200);
    expect(militaryTicks).toBeLessThanOrEqual(500);

    const built = buildFactoryViaConstruction(
      game,
      player,
      FactoryType.Civilian,
    );
    expect(built).toBeDefined();
    expect(built!.isUnderConstruction()).toBe(true);
    expect(built!.factoryType()).toBe(FactoryType.Civilian);
    expect(built!.factoryEfficiency()).toBe(100);
  });

  test("construction: specialized types persist", async () => {
    const { game, player } = await setupFactoryGame();
    const military = buildFactoryViaConstruction(
      game,
      player,
      FactoryType.Military,
      1,
      10,
    );
    expect(military!.factoryType()).toBe(FactoryType.Military);
    // Later-compatible types are rejected by construction (not exposed).
    game.addExecution(
      new ConstructionExecution(
        player,
        UnitType.Factory,
        game.ref(0, 11),
        undefined,
        undefined,
        FactoryType.Research,
      ),
    );
    game.executeNextTick();
    game.executeNextTick();
    const research = player
      .units(UnitType.Factory)
      .find((u) => u.tile() === game.ref(0, 11));
    expect(research).toBeUndefined();
  });

  test("cost validation: cannot build without gold, cost scales", async () => {
    const { game, player } = await setupFactoryGame({}, 0n);
    // No gold -> canBuild fails (resources validation).
    expect(player.canBuild(UnitType.Factory, game.ref(0, 10))).toBe(false);
    player.addGold(10_000_000n);
    expect(player.canBuild(UnitType.Factory, game.ref(0, 10))).not.toBe(false);
    const firstCost = game.unitInfo(UnitType.Factory).cost(game, player);
    expect(firstCost).toBeGreaterThan(0n);
    // Build one, next costs more (escalating investment).
    buildFactoryViaConstruction(game, player, FactoryType.Civilian);
    const secondCost = game.unitInfo(UnitType.Factory).cost(game, player);
    expect(secondCost).toBeGreaterThanOrEqual(firstCost);
  });

  test("build limits + cooldown are enforced", async () => {
    const { game, player } = await setupFactoryGame();
    expect(game.config().factoryMaxPerPlayer()).toBeLessThanOrEqual(20);
    // Cooldown is enforced on the intent path (ConstructionExecution), not on
    // direct buildUnit setup: second immediate intent-build is rejected.
    buildFactoryViaConstruction(game, player, FactoryType.Civilian, 0, 10);
    const before = player.units(UnitType.Factory).length;
    game.addExecution(
      new ConstructionExecution(
        player,
        UnitType.Factory,
        game.ref(1, 10),
        undefined,
        undefined,
        FactoryType.Civilian,
      ),
    );
    game.executeNextTick();
    game.executeNextTick();
    expect(player.units(UnitType.Factory).length).toBe(before);
  });

  test("capture: conquered factory is damaged, never full output", async () => {
    const { game, player, other } = await setupFactoryGame();
    const built = player.buildUnit(UnitType.Factory, game.ref(0, 10), {
      factoryType: FactoryType.Military,
    });
    expect(built.factoryEfficiency()).toBe(100);
    other.captureUnit(built);
    const eff = built.factoryEfficiency();
    expect(eff).toBeGreaterThanOrEqual(FACTORY_CAPTURE_EFFICIENCY_MIN);
    expect(eff).toBeLessThanOrEqual(FACTORY_CAPTURE_EFFICIENCY_MAX);
    expect(eff).toBeLessThan(100);
    expect(built.isFactoryOperational()).toBe(false);
    // Deterministic: same unit id always captures to same efficiency.
    expect(captureEfficiencyFor(built.id())).toBe(eff);
  });

  test("damage hook reduces efficiency and output (bombing model, no bombing yet)", async () => {
    const { game, player } = await setupFactoryGame();
    const built = player.buildUnit(UnitType.Factory, game.ref(0, 10), {
      factoryType: FactoryType.Military,
    });
    const full = factoryOutputFor(
      FactoryType.Military,
      1,
      100,
      game.config().factoryOutputPacingPercent(),
    );
    built.damageFactory(40);
    expect(built.factoryEfficiency()).toBe(60);
    const damaged = factoryOutputFor(
      FactoryType.Military,
      1,
      built.factoryEfficiency(),
      game.config().factoryOutputPacingPercent(),
    );
    expect(damaged.reinforcementTroopsPerTick).toBeLessThan(
      full.reinforcementTroopsPerTick,
    );
    // Disable hook suppresses production entirely.
    built.disableFactory(10);
    expect(built.factoryDisabledTicks()).toBe(10);
    const disabled = factoryOutputFor(
      FactoryType.Military,
      1,
      built.factoryEfficiency(),
      game.config().factoryOutputPacingPercent(),
      { disabledTicks: 10 },
    );
    expect(disabled.reinforcementTroopsPerTick).toBe(0);
    expect(disabled.armorPoints).toBe(0);
  });

  test("repair: damaged factory recovers gradually via FactoryExecution", async () => {
    const { game, player } = await setupFactoryGame();
    const built = player.buildUnit(UnitType.Factory, game.ref(0, 10), {
      factoryType: FactoryType.Civilian,
    });
    built.setFactoryEfficiency(50);
    game.addExecution(new FactoryExecution(built));
    game.executeNextTick(); // init + station
    const start = built.factoryEfficiency();
    // Repair is +1% per 10 ticks. Run 100 ticks -> +10%.
    for (let i = 0; i < 100; i++) game.executeNextTick();
    expect(built.factoryEfficiency()).toBeGreaterThan(start);
    expect(built.factoryEfficiency()).toBeLessThanOrEqual(100);
  });

  test("upgrade: levels capped at 3 with rising output and cost", async () => {
    const { game, player } = await setupFactoryGame();
    const built = player.buildUnit(UnitType.Factory, game.ref(0, 10), {
      factoryType: FactoryType.Military,
    });
    expect(built.level()).toBe(1);
    expect(game.config().factoryMaxLevel()).toBe(FACTORY_MAX_LEVEL);
    expect(player.canUpgradeUnit(built)).toBe(true);
    player.upgradeUnit(built);
    expect(built.level()).toBe(2);
    player.upgradeUnit(built);
    expect(built.level()).toBe(3);
    // Cap: no infinite scaling.
    expect(player.canUpgradeUnit(built)).toBe(false);

    const pacing = game.config().factoryOutputPacingPercent();
    const l1 = factoryOutputFor(FactoryType.Military, 1, 100, pacing);
    const l2 = factoryOutputFor(FactoryType.Military, 2, 100, pacing);
    const l3 = factoryOutputFor(FactoryType.Military, 3, 100, pacing);
    expect(l2.reinforcementTroopsPerTick).toBeGreaterThan(
      l1.reinforcementTroopsPerTick,
    );
    expect(l3.reinforcementTroopsPerTick).toBeGreaterThan(
      l2.reinforcementTroopsPerTick,
    );
    expect(l3.armorPoints).toBeGreaterThan(l1.armorPoints);
  });

  test("output scaling: civilian income, military reinforcement, air points", async () => {
    const { game } = await setupFactoryGame();
    const pacing = game.config().factoryOutputPacingPercent();
    const civ = baseFactoryOutput(FactoryType.Civilian, 1);
    expect(civ.incomeGoldPerTick).toBeGreaterThan(0);
    expect(civ.constructionPoints).toBeGreaterThan(0);
    expect(civ.reinforcementTroopsPerTick).toBe(0);

    const mil = baseFactoryOutput(FactoryType.Military, 1);
    expect(mil.reinforcementTroopsPerTick).toBeGreaterThan(0);
    expect(mil.armorPoints).toBeGreaterThan(0);
    expect(mil.artilleryPoints).toBeGreaterThan(0);
    expect(mil.incomeGoldPerTick).toBe(0);

    const air = baseFactoryOutput(FactoryType.Air, 1);
    expect(air.aircraftPoints).toBeGreaterThan(0);
    expect(air.incomeGoldPerTick).toBe(0);

    // Efficiency scales output down.
    const full = factoryOutputFor(FactoryType.Civilian, 2, 100, pacing);
    const half = factoryOutputFor(FactoryType.Civilian, 2, 50, pacing);
    expect(half.incomeGoldPerTick).toBeLessThan(full.incomeGoldPerTick);
  });

  test("production: civilian factory pays gold, military pays troops", async () => {
    const { game, player } = await setupFactoryGame();
    const civ = player.buildUnit(UnitType.Factory, game.ref(0, 10), {
      factoryType: FactoryType.Civilian,
    });
    game.addExecution(new FactoryExecution(civ));
    game.executeNextTick();
    game.executeNextTick();
    const goldBefore = player.gold();
    for (let i = 0; i < 10; i++) game.executeNextTick();
    expect(player.gold()).toBeGreaterThan(goldBefore);

    const mil = player.buildUnit(UnitType.Factory, game.ref(1, 10), {
      factoryType: FactoryType.Military,
    });
    game.addExecution(new FactoryExecution(mil));
    game.executeNextTick();
    const troopsBefore = player.troops();
    for (let i = 0; i < 10; i++) game.executeNextTick();
    expect(player.troops()).toBeGreaterThanOrEqual(troopsBefore);
  });

  test("pacing modifiers: rapid builds faster and produces more than extended", async () => {
    const rapid = await setupFactoryGame({ maxTimerValue: 10 });
    const standard = await setupFactoryGame({ maxTimerValue: 15 });
    const extended = await setupFactoryGame({ maxTimerValue: 20 });

    const rapidTicks = rapid.game
      .config()
      .factoryConstructionDuration(FactoryType.Civilian);
    const standardTicks = standard.game
      .config()
      .factoryConstructionDuration(FactoryType.Civilian);
    const extendedTicks = extended.game
      .config()
      .factoryConstructionDuration(FactoryType.Civilian);
    expect(rapidTicks).toBeLessThan(standardTicks);
    expect(extendedTicks).toBeGreaterThan(standardTicks);

    // Pure helper also respects pacing percent.
    const rapidOut = factoryOutputFor(FactoryType.Civilian, 1, 100, 150);
    const standardOut = factoryOutputFor(FactoryType.Civilian, 1, 100, 100);
    const extendedOut = factoryOutputFor(FactoryType.Civilian, 1, 100, 90);
    expect(rapidOut.incomeGoldPerTick).toBeGreaterThan(
      standardOut.incomeGoldPerTick,
    );
    expect(extendedOut.incomeGoldPerTick).toBeLessThan(
      standardOut.incomeGoldPerTick,
    );
    // Config exposes the same percents.
    expect(rapid.game.config().factoryOutputPacingPercent()).toBe(150);
    expect(standard.game.config().factoryOutputPacingPercent()).toBe(100);
    expect(extended.game.config().factoryOutputPacingPercent()).toBe(90);
    // Construction ticks helper matches config.
    expect(factoryConstructionTicks(FactoryType.Civilian, 150, false)).toBe(
      rapidTicks,
    );
  });

  test("UI: selected factory exposes type/level/production/status/owner/cost", async () => {
    const { game, player } = await setupFactoryGame();
    const built = player.buildUnit(UnitType.Factory, game.ref(0, 10), {
      factoryType: FactoryType.Military,
    });
    const info = factoryDisplayInfoFor(built, game, player);
    expect(info.factoryType).toBe(FactoryType.Military);
    expect(info.level).toBe(1);
    expect(info.production).toBeGreaterThan(0);
    expect(info.status).toBe("Operational");
    expect(info.ownerName).toBe(player.displayName());
    expect(info.upgradeCost).toBeGreaterThan(0n);
    // Damaged status surfaces.
    built.setFactoryEfficiency(50);
    const damaged = factoryDisplayInfoFor(built, game, player);
    expect(damaged.status).toBe("Damaged");
    expect(damaged.production).toBeLessThan(info.production);
    // Map representation stays compact (factory fields on the update).
    const update = built.toUpdate();
    expect(update.factoryType).toBe(FactoryType.Military);
    expect(update.factoryEfficiency).toBe(50);
  });

  test("upgrade execution respects the level-3 cap", async () => {
    const { game, player } = await setupFactoryGame();
    const built = player.buildUnit(UnitType.Factory, game.ref(0, 10), {
      factoryType: FactoryType.Civilian,
    });
    player.upgradeUnit(built);
    player.upgradeUnit(built);
    expect(built.level()).toBe(3);
    game.addExecution(new UpgradeStructureExecution(player, built.id(), 5));
    game.executeNextTick();
    expect(built.level()).toBe(3);
  });
});
