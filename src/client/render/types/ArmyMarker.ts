// Army marker instance layout (Prompt 3.6).
//
// Split out of ArmyMarkerPass on purpose: the pass imports `.glsl?raw` shaders,
// and a *value* import from it would drag those into any non-Vite consumer (the
// Node perf harness, tests). The flag word is built by the producer and read
// straight out of the instance buffer, so it lives here with no GL dependency
// and both sides share one definition.

import type { ArmyMarker } from "./Renderer";

export type { ArmyMarker };

/** Floats per instance: centerX, centerY, sizeTiles, flags, r, g, b. */
export const ARMY_MARKER_FLOATS_PER_INSTANCE = 7;

/** Instance flag bits, unpacked by army-marker.frag.glsl. */
export const ARMY_MARKER_FLAGS = {
  own: 1 << 0,
  friendly: 1 << 1,
  selected: 1 << 2,
  moving: 1 << 3,
  engaging: 1 << 4,
  attacking: 1 << 5,
  near: 1 << 6,
} as const;

/**
 * Packs the per-instance flag word the fragment shader unpacks. Exported so the
 * producer of the instance data builds the exact word the pass draws with,
 * rather than duplicating the bit layout in two files.
 */
export function packArmyMarkerFlags(opts: {
  isOwn: boolean;
  isFriendly: boolean;
  isSelected: boolean;
  isMoving: boolean;
  isEngaging: boolean;
  isAttacking: boolean;
  isNear: boolean;
}): number {
  const f = ARMY_MARKER_FLAGS;
  let flags = 0;
  if (opts.isOwn) flags |= f.own;
  if (opts.isFriendly) flags |= f.friendly;
  if (opts.isSelected) flags |= f.selected;
  if (opts.isMoving) flags |= f.moving;
  if (opts.isEngaging) flags |= f.engaging;
  if (opts.isAttacking) flags |= f.attacking;
  if (opts.isNear) flags |= f.near;
  return flags;
}
