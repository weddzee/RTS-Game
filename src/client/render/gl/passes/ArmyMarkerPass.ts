/**
 * ArmyMarkerPass — the map marker for every visible army (Prompt 3.6).
 *
 * One instanced quad per army. Deliberately NOT fifty individual soldiers:
 * the marker is a single abstract shape that carries the owner color, scales
 * with strength, and is legible at every zoom.
 *
 * Two levels of detail, both driven from the same instance data:
 *   - zoomed out: a small solid chevron/diamond in the owner color.
 *   - zoomed in:  the same shape with a ring, plus the strength abbreviation.
 * The custom army name and the status icon are drawn by WorldTextPass and the
 * label list below, which already own world-anchored text at constant screen
 * size — see WorldTextPass.setArmyLabels.
 *
 * Friendly armies standing on the same tile are fanned out on a small ring
 * (offsetIndex / offsetCount in the instance data) instead of stacking into one
 * unreadable blob.
 */

import {
  ARMY_MARKER_FLOATS_PER_INSTANCE,
  type ArmyMarker,
} from "../../types/ArmyMarker";
import { DynamicInstanceBuffer } from "../DynamicBuffer";
import type { RenderSettings } from "../RenderSettings";
import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/army-marker/army-marker.frag.glsl?raw";
import vertSrc from "../shaders/army-marker/army-marker.vert.glsl?raw";

const FLOATS_PER_INSTANCE = ARMY_MARKER_FLOATS_PER_INSTANCE;

export class ArmyMarkerPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instanceBuf: DynamicInstanceBuffer;
  private settings: RenderSettings["armyMarker"];

  private uCamera: WebGLUniformLocation;
  private uPxPerTile: WebGLUniformLocation;
  private uNearZoom: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;

  private instanceCount = 0;
  private startTime = 0;

  constructor(
    gl: WebGL2RenderingContext,
    settings: RenderSettings["armyMarker"],
  ) {
    this.gl = gl;
    this.settings = settings;
    this.program = createProgram(gl, vertSrc, fragSrc);

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uPxPerTile = gl.getUniformLocation(this.program, "uPxPerTile")!;
    this.uNearZoom = gl.getUniformLocation(this.program, "uNearZoom")!;
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

    // Instance buffer
    const glBuf = gl.createBuffer()!;
    this.instanceBuf = new DynamicInstanceBuffer(
      gl,
      glBuf,
      64,
      FLOATS_PER_INSTANCE,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    const stride = FLOATS_PER_INSTANCE * 4;

    // Attribute 1: vec4 (centerX, centerY, sizeTiles, flags)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    // Attribute 2: vec3 (r, g, b)
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);
  }

  /**
   * Replace the marker set. Called once per simulation tick with the full
   * list; an empty list turns the pass off.
   */
  update(markers: ArmyMarker[]): void {
    if (markers.length === 0) {
      this.instanceCount = 0;
      return;
    }
    this.instanceBuf.ensureCapacity(markers.length);
    const data = this.instanceBuf.float32;
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      const off = i * FLOATS_PER_INSTANCE;
      data[off + 0] = m.x;
      data[off + 1] = m.y;
      data[off + 2] = m.sizeTiles;
      data[off + 3] = m.flags;
      data[off + 4] = m.r;
      data[off + 5] = m.g;
      data[off + 6] = m.b;
    }
    this.instanceCount = markers.length;

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceBuf.float32,
      0,
      markers.length * FLOATS_PER_INSTANCE,
    );
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    if (this.instanceCount === 0) return;
    const gl = this.gl;
    const s = this.settings;
    const now = performance.now();
    if (this.startTime === 0) this.startTime = now;

    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uPxPerTile, zoom);
    gl.uniform1f(this.uNearZoom, s.nearZoom);
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
