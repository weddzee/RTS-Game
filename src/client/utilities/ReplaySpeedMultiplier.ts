export enum ReplaySpeedMultiplier {
  slow = 2,
  normal = 1,
  fast = 0.5,
  fastest = 0,
}

export const defaultReplaySpeedMultiplier = ReplaySpeedMultiplier.normal;

// Order: 0.5, 1, 2, max (LocalServer and ReplayPanel share this).
export const SPEED_ORDER: ReplaySpeedMultiplier[] = [
  ReplaySpeedMultiplier.slow,
  ReplaySpeedMultiplier.normal,
  ReplaySpeedMultiplier.fast,
  ReplaySpeedMultiplier.fastest,
];

// Prompt 2.4: local-testing speeds. 5x/10x divide the 100 ms turn interval
// to 20/10 ms. Dev singleplayer only — LocalServer never serves
// multiplayer, replays keep SPEED_ORDER, prod builds never branch here.
export const DEV_SPEED_UP_TO: ReplaySpeedMultiplier[] = [
  0.2 as ReplaySpeedMultiplier, // 5x
  0.1 as ReplaySpeedMultiplier, // 10x
];

/**
 * Speed steps for a local session. Pure (testable): replays always get
 * the shared order, dev singleplayer appends 5x/10x ahead of max. Always a
 * fresh array, so a caller can never mutate the shared order.
 */
export function speedOrderForSession(
  isReplay: boolean,
  isDev: boolean,
): ReplaySpeedMultiplier[] {
  if (!isReplay && isDev) {
    return [
      ...SPEED_ORDER.slice(0, -1),
      ...DEV_SPEED_UP_TO,
      ReplaySpeedMultiplier.fastest,
    ];
  }
  return [...SPEED_ORDER];
}
