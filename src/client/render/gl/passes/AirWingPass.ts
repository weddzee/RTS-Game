/**
 * AirWingPass — the air map layer (Prompt 7.8).
 *
 * One instanced quad per thing to draw, one program, one draw call:
 *
 *   - the air-region overlay, tinted by who holds the region's sky
 *   - one icon per air wing, at the centre of the region it flies in
 *   - that wing's mission line, from its airbase to the region
 *
 * And explicitly NOT aircraft. There is no per-plane instance, nothing is
 * animated along a flight path, and nothing here has a position a player could
 * mistake for one. 7.8's "optional cosmetic aircraft movement ... cannot
 * represent authoritative positioning" is satisfied by there being none: the
 * only animation is a slow pulse on a contested region and a dash running along
 * a mission line, both of which are state readouts.
 *
 * Visibility is two gates, both owned elsewhere and both read live:
 * `Renderer.render` checks `passEnabled.airWing` (air mode, off by default —
 * the region grid must not flood the base map), and `draw` culls below
 * `settings.airWing.cullZoom`. Data is pushed either way, so toggling air mode
 * is instant and never needs the simulation to resend anything.
 *
 * Pass conventions (see src/client/render/CLAUDE.md): constructed with the
 * settings slice, updated once per simulation tick with the full list, drawn in
 * explicit z-order from renderOverlays.
 */

import {
  AIR_WING_FLAGS,
  AIR_WING_FLOATS_PER_INSTANCE,
  AIR_WING_KIND,
  type AirMissionLine,
  type AirRegionOverlay,
  type AirWingMarker,
} from "../../types/AirWingMarker";
import { DynamicInstanceBuffer } from "../DynamicBuffer";
import type { RenderSettings } from "../RenderSettings";
import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/air-wing/air-wing.frag.glsl?raw";
import vertSrc from "../shaders/air-wing/air-wing.vert.glsl?raw";

const FLOATS_PER_INSTANCE = AIR_WING_FLOATS_PER_INSTANCE;

export class AirWingPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instanceBuf: DynamicInstanceBuffer;
  private settings: RenderSettings["airWing"];

  private uCamera: WebGLUniformLocation;
  private uPxPerTile: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;

  private instanceCount = 0;
  private startTime = 0;

  constructor(gl: WebGL2RenderingContext, settings: RenderSettings["airWing"]) {
    this.gl = gl;
    this.settings = settings;
    this.program = createProgram(gl, vertSrc, fragSrc);

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uPxPerTile = gl.getUniformLocation(this.program, "uPxPerTile")!;
    this.uTime = gl.getUniformLocation(this.program, "uTime")!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Attribute 0: unit quad [0,1]
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const glBuf = gl.createBuffer()!;
    this.instanceBuf = new DynamicInstanceBuffer(gl, glBuf, 64, FLOATS_PER_INSTANCE);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    const stride = FLOATS_PER_INSTANCE * 4;

    // Attribute 1: shape A (see air-wing.vert.glsl)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    // Attribute 2: (kind, flags, sharePercent, halfWidth)
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);

    // Attribute 3: (r, g, b, alpha)
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);
  }

  /**
   * Replace the whole air layer, once per simulation tick. Called with empty
   * lists when air mode is off, so the cost of an off overlay is one branch in
   * the producer rather than a live buffer the renderer keeps paying for.
   */
  update(data: {
    regions: AirRegionOverlay[];
    markers: AirWingMarker[];
    lines: AirMissionLine[];
  }): void {
    const regions = data.regions;
    const markers = data.markers;
    const lines = data.lines;
    const total = regions.length + markers.length + lines.length;
    if (total === 0) {
      this.instanceCount = 0;
      return;
    }

    this.instanceBuf.ensureCapacity(total);
    const out = this.instanceBuf.float32;
    let i = 0;

    // Regions first: the wash has to be under the icons and the lines.
    for (const r of regions) {
      const off = i * FLOATS_PER_INSTANCE;
      out[off + 0] = r.x;
      out[off + 1] = r.y;
      out[off + 2] = r.width;
      out[off + 3] = r.height;
      out[off + 4] = AIR_WING_KIND.region;
      out[off + 5] = r.contested ? AIR_WING_FLAGS.contested : 0;
      out[off + 6] = r.sharePercent;
      out[off + 7] = 0;
      const c = r.color;
      out[off + 8] = c === null ? 0.75 : c.r;
      out[off + 9] = c === null ? 0.8 : c.g;
      out[off + 10] = c === null ? 0.9 : c.b;
      out[off + 11] = this.settings.regionAlpha;
      i++;
    }

    for (const m of markers) {
      const off = i * FLOATS_PER_INSTANCE;
      out[off + 0] = m.x;
      out[off + 1] = m.y;
      out[off + 2] = m.sizeTiles;
      out[off + 3] = 0;
      out[off + 4] = AIR_WING_KIND.marker;
      out[off + 5] = m.flags;
      out[off + 6] = 0;
      out[off + 7] = 0;
      out[off + 8] = m.r;
      out[off + 9] = m.g;
      out[off + 10] = m.b;
      out[off + 11] = this.settings.markerAlpha;
      i++;
    }

    for (const l of lines) {
      const off = i * FLOATS_PER_INSTANCE;
      out[off + 0] = l.fromX;
      out[off + 1] = l.fromY;
      out[off + 2] = l.toX;
      out[off + 3] = l.toY;
      out[off + 4] = AIR_WING_KIND.line;
      out[off + 5] = l.flags;
      out[off + 6] = 0;
      out[off + 7] = l.widthTiles;
      out[off + 8] = l.r;
      out[off + 9] = l.g;
      out[off + 10] = l.b;
      out[off + 11] = this.settings.lineAlpha;
      i++;
    }

    this.instanceCount = i;

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceBuf.float32,
      0,
      i * FLOATS_PER_INSTANCE,
    );
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    if (this.instanceCount === 0) return;
    // Zoomed out far enough, the whole grid is sub-pixel. Drop it rather than
    // shade a continent with hairlines: the army-marker precedent.
    if (zoom < this.settings.cullZoom) return;
    const gl = this.gl;
    const now = performance.now();
    if (this.startTime === 0) this.startTime = now;

    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uPxPerTile, zoom);
    gl.uniform1f(this.uTime, (now - this.startTime) / 1000);

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    this.instanceBuf.dispose();
    gl.deleteVertexArray(this.vao);
  }
}