// Prompt 2.4: dev-only 1x/2x/5x/10x speeds stay in local testing.
// The order is pure: replays always keep the shared set, dev
// singleplayer appends 5x/10x ahead of max, everything else is unchanged.
import { describe, expect, it } from "vitest";
import {
  ReplaySpeedMultiplier,
  speedOrderForSession,
} from "../../src/client/utilities/ReplaySpeedMultiplier";

describe("speedOrderForSession", () => {
  it("keeps the shared order for replays, even in dev", () => {
    expect(speedOrderForSession(true, true)).toEqual([
      ReplaySpeedMultiplier.slow,
      ReplaySpeedMultiplier.normal,
      ReplaySpeedMultiplier.fast,
      ReplaySpeedMultiplier.fastest,
    ]);
  });

  it("keeps the shared order outside dev", () => {
    expect(speedOrderForSession(false, false)).toEqual([
      ReplaySpeedMultiplier.slow,
      ReplaySpeedMultiplier.normal,
      ReplaySpeedMultiplier.fast,
      ReplaySpeedMultiplier.fastest,
    ]);
  });

  it("appends 5x/10x for dev singleplayer", () => {
    const order = speedOrderForSession(false, true);
    expect(order.slice(0, 3)).toEqual([
      ReplaySpeedMultiplier.slow,
      ReplaySpeedMultiplier.normal,
      ReplaySpeedMultiplier.fast,
    ]);
    // A step divides the turn interval, so speed is 1 / multiplier:
    // 0.2 -> 20 ms turns (5x), 0.1 -> 10 ms turns (10x).
    expect(1 / (order[3] as number)).toBe(5);
    expect(1 / (order[4] as number)).toBe(10);
    expect(order[5]).toBe(ReplaySpeedMultiplier.fastest);
  });
});
