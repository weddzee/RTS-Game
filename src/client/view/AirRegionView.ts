import type { AirRegionUpdate } from "../../core/game/GameUpdates";

/**
 * Client-side read model of one air region (Prompt 7.8).
 *
 * Immutable after construction: an air region never changes identity, and every
 * change to who holds its sky arrives as a fresh update that replaces this
 * object. That keeps the overlay's per-tick rebuild a plain map walk with no
 * merge logic — and matches how the sim emits them.
 */
export class AirRegionView {
  constructor(private readonly u: AirRegionUpdate) {}

  regionId(): number {
    return this.u.regionId;
  }

  /** Region origin, in tiles. */
  x(): number {
    return this.u.x;
  }

  y(): number {
    return this.u.y;
  }

  width(): number {
    return this.u.width;
  }

  height(): number {
    return this.u.height;
  }

  /** Centre of the region, in tiles. Where its wing icons are drawn. */
  centerX(): number {
    return this.u.x + this.u.width / 2;
  }

  centerY(): number {
    return this.u.y + this.u.height / 2;
  }

  /**
   * Share of this region's air war held by the leading side, 0..100. Note this
   * is the LEADER's share, not the local player's: the overlay says who owns
   * the sky, which is the fact a player needs before they commit troops.
   */
  sharePercent(): number {
    return this.u.sharePercent;
  }

  /** Leading side's small id, or null when nobody is flying in the region. */
  leaderSmallID(): number | null {
    return this.u.leaderSmallID;
  }

  /** True when aircraft from more than one side are in the region. */
  contested(): boolean {
    return this.u.contested;
  }
}