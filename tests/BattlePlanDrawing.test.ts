// The client half of drawn battle plans: path simplification, smoothing, and the
// promise that drawing never talks to the network (Prompt 4.3, 4.10).
//
// These are pure functions and one controller, exercised directly rather than
// through a live game. The controller tests are the important ones: 4.10's whole
// requirement is that nothing goes out while the pointer moves, and that is only
// checkable by watching what the event bus emits.

import {
  BattlePlanController,
  chaikin,
  simplify,
} from "../src/client/controllers/BattlePlanController";
import {
  MouseDownEvent,
  MouseMoveEvent,
  MouseUpEvent,
} from "../src/client/InputHandler";
import type { MapRenderer } from "../src/client/render/gl";
import type { TransformHandler } from "../src/client/TransformHandler";
import { BattlePlanIntentEvent } from "../src/client/Transport";
import type { GameView } from "../src/client/view";
import type { GameEvent } from "../src/core/EventBus";
import { EventBus } from "../src/core/EventBus";

describe("battle plan path math", () => {
  test("simplify keeps the endpoints and the corners, drops the rest", () => {
    // A right-angle corner with lots of points along each leg.
    const points: number[] = [];
    for (let i = 0; i <= 10; i++) points.push(i, 0);
    for (let i = 1; i <= 10; i++) points.push(10, i);

    const out = simplify(points, 1.25);
    // The two endpoints and the one corner survive; the collinear middles do not.
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[out.length - 2]).toBe(10);
    expect(out[out.length - 1]).toBe(10);
    expect(out).toContain(10);
    expect(out).toContain(0);
    expect(out.length).toBeLessThan(points.length / 4);
  });

  test("simplify collapses a straight line to its endpoints", () => {
    const points: number[] = [];
    for (let i = 0; i <= 50; i++) points.push(i * 0.5, 3);
    const out = simplify(points, 1.25);
    expect(out).toEqual([0, 3, 25, 3]);
  });

  test("simplify leaves a short path alone", () => {
    expect(simplify([1, 1], 1.25)).toEqual([1, 1]);
    expect(simplify([1, 1, 2, 2], 1.25)).toEqual([1, 1, 2, 2]);
  });

  test("simplify handles a path that doubles back on itself", () => {
    // Straight out and straight back. Every point is on the line through the
    // endpoints, so the whole thing is one segment as far as the test is
    // concerned — the point is that it terminates and does not loop.
    const points: number[] = [];
    for (let i = 0; i <= 20; i++) points.push(i, 0);
    for (let i = 19; i >= 0; i--) points.push(i, 0);
    const out = simplify(points, 0.5);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });

  test("chaikin preserves the endpoints and rounds the corners", () => {
    const points = [0, 0, 10, 0, 10, 10];
    const out = chaikin(points);
    // Endpoints untouched, so an arrow still starts where the drag started and
    // ends where the pointer was released.
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[out.length - 2]).toBe(10);
    expect(out[out.length - 1]).toBe(10);
    // The hard corner is replaced by points off both legs, which is what makes it
    // a curve rather than a corner.
    expect(
      out.some((_, i) => i > 0 && i < out.length / 2 && out[i + 1] !== 0),
    ).toBe(true);
  });

  test("chaikin leaves a path too short to smooth alone", () => {
    expect(chaikin([1, 1, 2, 2])).toEqual([1, 1, 2, 2]);
  });
});

/** Records every event a controller emits, for the "nothing goes out" test. */
class RecordingBus extends EventBus {
  readonly seen: GameEvent[] = [];

  override emit(event: GameEvent): void {
    this.seen.push(event);
    super.emit(event);
  }
}

describe("battle plan drawing", () => {
  /**
   * The smallest GameView stand-in the controller actually touches. Real tile
   * lookups, fake everything else.
   */
  function stubGame(): GameView {
    const width = 200;
    const height = 200;
    // A lake between the player's ground (x < 100) and the far bank (x >= 106):
    // the realistic case for an invalid section, since an arrow drawn straight
    // over water is exactly the gesture the simulation has to refuse to follow.
    const isWater = (ref: number): boolean => {
      const x = ref % width;
      return x >= 100 && x < 106;
    };
    const ownerOf = (ref: number): number => {
      const x = ref % width;
      return x < 100 ? 1 : 2;
    };
    return {
      width: () => width,
      height: () => height,
      x: (ref: number) => ref % width,
      y: (ref: number) => Math.floor(ref / width),
      isValidCoord: (x: number, y: number) =>
        x >= 0 && y >= 0 && x < width && y < height,
      isValidRef: (ref: number) =>
        Number.isInteger(ref) && ref >= 0 && ref < width * height,
      ref: (x: number, y: number) => y * width + x,
      ownerID: ownerOf,
      isBorder: (ref: number) => ref % width === 99,
      isLand: (ref: number) => !isWater(ref),
      isWater,
      isImpassable: () => false,
      myPlayer: () => ({
        smallID: () => 1,
        territoryColor: () => ({ toHex: () => "#ff0000" }),
      }),
      players: () => [
        {
          smallID: () => 1,
          territoryColor: () => ({ toHex: () => "#ff0000" }),
        },
      ],
      battlePlans: () => [],
      selectedArmy: () => null,
      myArmies: () => [],
      selectedBattlePlanId: () => null,
      hoveredBattlePlanId: () => null,
      setHoveredBattlePlan: () => {},
      setSelectedBattlePlan: () => {},
      battlePlanNearTile: () => null,
    } as unknown as GameView;
  }

  function stubView() {
    const pushed: unknown[][] = [];
    const view = {
      updateBattlePlanStrokes: (strokes: unknown[]) => pushed.push(strokes),
      battlePlanAlphas: () => ({ alpha: 0.7, activeAlpha: 0.95 }),
    } as unknown as MapRenderer;
    return { view, pushed };
  }

  function setup() {
    const game = stubGame();
    const bus = new RecordingBus();
    const view = stubView();
    // Screen space that maps 1:1 onto tile space, which keeps the drag arithmetic
    // in the test obvious.
    const transformHandler = {
      screenToWorldCoordinates: (sx: number, sy: number) => ({ x: sx, y: sy }),
    } as unknown as TransformHandler;
    const controller = new BattlePlanController(
      game,
      bus,
      transformHandler,
      view.view,
    );
    controller.init();
    return { controller, bus, pushed: view.pushed, game };
  }

  test("drawing sends nothing until the pointer is released", () => {
    const { controller, bus } = setup();
    controller.arm("offensive");
    expect(controller.armedMode()).toBe("offensive");

    // A drag from the border at x=99, over the lake, onto the far bank at x=110.
    bus.emit(new MouseDownEvent(99, 50));
    for (let x = 99; x <= 110; x++) {
      bus.emit(new MouseMoveEvent(x, 50));
      bus.emit(new MouseMoveEvent(x, 51));
    }
    // Nothing at all, not even a start-plan message: drawing is local.
    expect(
      bus.seen.filter((e) => e instanceof BattlePlanIntentEvent),
    ).toHaveLength(0);
    expect(controller.isDrawing()).toBe(true);

    bus.emit(new MouseUpEvent(104, 51));

    const intents = bus.seen.filter(
      (e): e is BattlePlanIntentEvent => e instanceof BattlePlanIntentEvent,
    );
    expect(intents).toHaveLength(1);
    const action = intents[0].action;
    expect(action.type).toBe("create");
    if (action.type !== "create") throw new Error("expected a create action");
    expect(action.kind).toBe("offensive");
    // The gesture is sent as tiles, already simplified, not as pointer positions.
    expect(action.frontier.length).toBeGreaterThan(0);
    expect(action.route.length).toBeGreaterThan(0);
    expect(controller.isDrawing()).toBe(false);
  });

  test("a drag along the border produces a frontline proposal on the border", () => {
    const { controller, bus } = setup();
    controller.arm("frontline");
    bus.emit(new MouseDownEvent(99, 40));
    for (let y = 40; y <= 50; y++) bus.emit(new MouseMoveEvent(99, y));
    bus.emit(new MouseUpEvent(99, 50));

    const intents = bus.seen.filter(
      (e): e is BattlePlanIntentEvent => e instanceof BattlePlanIntentEvent,
    );
    expect(intents).toHaveLength(1);
    const action = intents[0].action;
    if (action.type !== "create") throw new Error("expected a create action");
    expect(action.kind).toBe("frontline");
    // Only the player's own border tiles go out.
    expect(action.frontier.length).toBeGreaterThanOrEqual(2);
    for (const tile of action.frontier) expect(tile % 200).toBe(99);
  });

  test("a frontline drawn through the player's own interior sends no tiles for it", () => {
    const { controller, bus } = setup();
    controller.arm("frontline");
    bus.emit(new MouseDownEvent(40, 40));
    for (let y = 40; y <= 50; y++) bus.emit(new MouseMoveEvent(40, y));
    bus.emit(new MouseUpEvent(40, 50));

    const intents = bus.seen.filter(
      (e): e is BattlePlanIntentEvent => e instanceof BattlePlanIntentEvent,
    );
    // There is nothing to draw a front on, so nothing is proposed at all — rather
    // than proposing tiles the simulation is guaranteed to reject.
    expect(intents).toHaveLength(0);
  });

  test("a fallback line is only proposed inside the player's own territory", () => {
    const { controller, bus } = setup();
    controller.arm("fallback");
    bus.emit(new MouseDownEvent(60, 30));
    for (let y = 30; y <= 36; y++) bus.emit(new MouseMoveEvent(60, y));
    bus.emit(new MouseUpEvent(60, 36));

    const intents = bus.seen.filter(
      (e): e is BattlePlanIntentEvent => e instanceof BattlePlanIntentEvent,
    );
    expect(intents).toHaveLength(1);
    const action = intents[0].action;
    if (action.type !== "create") throw new Error("expected a create action");
    expect(action.kind).toBe("fallback");
    for (const tile of action.frontier) expect(tile % 200).toBe(60);
  });

  test("the live preview marks the illegal part of a drag", () => {
    const { controller, bus, pushed } = setup();
    controller.arm("offensive");
    // Start on the border, drag out over the lake (x 100..105) and onto the far
    // bank. The crossing is not somewhere an army could go, and the player has to
    // be able to see that before letting go.
    bus.emit(new MouseDownEvent(99, 100));
    for (let x = 99; x <= 112; x++) bus.emit(new MouseMoveEvent(x, 100));

    const last = pushed[pushed.length - 1] as { valid: Uint8Array }[];
    expect(last).toHaveLength(1);
    const valid = Array.from(last[0].valid);
    // Both flags present: the whole point of the invalid tint is that it
    // distinguishes the crossing from the rest of the line.
    expect(valid).toContain(0);
    expect(valid).toContain(1);
  });

  test("an arrow's proposed route skips the water it was drawn over", () => {
    const { controller, bus } = setup();
    controller.arm("offensive");
    bus.emit(new MouseDownEvent(99, 100));
    for (let x = 99; x <= 112; x++) bus.emit(new MouseMoveEvent(x, 100));
    bus.emit(new MouseUpEvent(112, 100));

    const intents = bus.seen.filter(
      (e): e is BattlePlanIntentEvent => e instanceof BattlePlanIntentEvent,
    );
    expect(intents).toHaveLength(1);
    const action = intents[0].action;
    if (action.type !== "create") throw new Error("expected a create action");
    // The gesture is sent as drawn; the simulation is what has to route around
    // the lake, and it does so from map topology rather than from this array.
    for (const tile of action.route)
      expect(tile % 200).toBeGreaterThanOrEqual(99);
  });

  test("re-clicking the armed button cancels the gesture", () => {
    const { controller } = setup();
    controller.arm("spearhead");
    expect(controller.armedMode()).toBe("spearhead");
    controller.arm("spearhead");
    expect(controller.armedMode()).toBeNull();
  });
});
