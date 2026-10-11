// Air wing marker instance layout (Prompt 7.8).
//
// Split out of AirWingPass on purpose: the pass imports `.glsl?raw` shaders,
// and a *value* import from it would drag those into any non-Vite consumer (the
// Node perf harness, tests). The kinds and the flag word are built by the
// producer and read straight out of the instance buffer, so they live here with
// no GL dependency and both sides share one definition.
//
// One layout serves all three things 7.8 asks the map to show, so the pass is a
// single program and a single draw call:
//
//   REGION  the air-region overlay, tinted by who holds the region
//   MARKER  one wing icon, at the centre of the region it flies in
//   LINE    that wing's mission line, from its home ground to the region
//
// And explicitly NOT an aircraft: nothing here is per-plane, nothing animates
// along a path, and nothing has a position that could be mistaken for one. The
// only per-frame animation is a slow pulse on a contested region, which is a
// state readout rather than a position.

import type { AirWingMarker, AirRegionOverlay, AirMissionLine } from "./Renderer";

export type { AirMissionLine, AirRegionOverlay, AirWingMarker };

/** Three vec4 attributes per instance; see AirWingPass for the field order. */
export const AIR_WING_FLOATS_PER_INSTANCE = 12;

/** What an instance draws. Packed into the third slot of attribute 0. */
export const AIR_WING_KIND = {
  region: 0,
  marker: 1,
  line: 2,
} as const;

export type AirWingKind =
  (typeof AIR_WING_KIND)[keyof typeof AIR_WING_KIND];

/** Wing marker flag bits, unpacked by air-wing.frag.glsl. */
export const AIR_WING_FLAGS = {
  own: 1 << 0,
  /** Flying air superiority (patrol). */
  patrol: 1 << 1,
  /** Flying intercept. */
  intercept: 1 << 2,
  /** Flying a strike. */
  strike: 1 << 3,
  /** The wing has been gutted and is rebuilding. */
  depleted: 1 << 4,
  selected: 1 << 5,
  /**
   * Region only: aircraft from more than one side are here. Deliberately NOT a
   * reuse of `strike` — a region has no mission, and borrowing a marker bit for
   * it would make the two flag words quietly incompatible.
   */
  contested: 1 << 6,
} as const;

/** Packs the per-instance flag word. Exported so producer and shader agree. */
export function packAirWingFlags(opts: {
  isOwn: boolean;
  mission: string;
  isDepleted: boolean;
  isSelected: boolean;
}): number {
  const f = AIR_WING_FLAGS;
  let flags = 0;
  if (opts.isOwn) flags |= f.own;
  if (opts.mission === "airSuperiority") flags |= f.patrol;
  if (opts.mission === "intercept") flags |= f.intercept;
  if (opts.mission === "strike") flags |= f.strike;
  if (opts.isDepleted) flags |= f.depleted;
  if (opts.isSelected) flags |= f.selected;
  return flags;
}