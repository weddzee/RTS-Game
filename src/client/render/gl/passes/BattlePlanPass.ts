/**
 * BattlePlanPass — draws drawn battle plans: frontlines and offensive arrows
 * (Prompt 4.3).
 *
 * Two draws over one geometry upload:
 *
 *  1. **Ribbon.** Every stroke is expanded on the CPU from a centreline into a
 *     triangle strip, two strip vertices per point, each carrying a
 *     pre-computed perpendicular and a cumulative arc length. The vertex shader
 *     offsets by the perpendicular, so the strip keeps the same screen width at
 *     every zoom, and the fragment shader draws a core inside an outline with an
 *     optional dash flow and an optional serrated edge for a frontline.
 *  2. **Arrow heads.** One instanced triangle per arrow tip, shaped by a signed
 *     distance function in the fragment shader so it stays crisp at any size.
 *
 * The dash phase lives in a uniform rather than in the vertex data, which means
 * the buffer is only rewritten when the geometry actually changes — the animated
 * part of an arrow costs nothing per frame. Strokes are drawn in separate
 * `drawArrays` calls because a triangle strip cannot span two strokes, and each
 * stroke's style flags ride along as vertex attributes so one program covers all
 * six order types.
 *
 * Nothing here reads game state. Strokes are pushed in via `setStrokes()`, which
 * the controller calls.
 */

import {
  BATTLE_PLAN_CORE_FRACTION,
  type BattlePlanStroke,
} from "../../types/BattlePlan";
import type { RenderSettings } from "../RenderSettings";
import { createProgram } from "../utils/GlUtils";

import headFragSrc from "../shaders/battle-plan/battle-plan-head.frag.glsl?raw";
import headVertSrc from "../shaders/battle-plan/battle-plan-head.vert.glsl?raw";
import fragSrc from "../shaders/battle-plan/battle-plan-line.frag.glsl?raw";
import vertSrc from "../shaders/battle-plan/battle-plan-line.vert.glsl?raw";

/** centreX, centreY, perpX, perpY, r, g, b, a, arcDist, side, dashed, teeth. */
const LINE_FLOATS = 12;
/** tipX, tipY, dirX, dirY, r, g, b, a, lengthPx, halfWidthPx, invalid. */
const HEAD_FLOATS = 11;
/** Starting capacities; both buffers double on demand. */
const INITIAL_LINE_VERTS = 1024;
const INITIAL_HEADS = 32;
/** Hover and selected plans read brighter and slightly thicker. */
const HOVER_BOOST = 1.15;
const SELECT_BOOST = 1.35;

interface StrokeRange {
  /** First strip vertex of this stroke in the shared line buffer. */
  first: number;
  count: number;
  /** 1 when any of this stroke's points is marked illegal. */
  invalid: number;
}

/** Per-stroke treatment that the vertex attributes carry as flags. */
interface StrokeStyle {
  dashed: 0 | 1;
  teeth: 0 | 1;
  head: boolean;
}

export class BattlePlanPass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;

  private lineProgram: WebGLProgram;
  private lineVao: WebGLVertexArrayObject;
  private lineBuffer: WebGLBuffer;
  private lineData = new Float32Array(INITIAL_LINE_VERTS * LINE_FLOATS);
  private lineCapacity = INITIAL_LINE_VERTS;
  private lineVertexCount = 0;

  private headProgram: WebGLProgram;
  private headVao: WebGLVertexArrayObject;
  private headBuffer: WebGLBuffer;
  private headData = new Float32Array(INITIAL_HEADS * HEAD_FLOATS);
  private headCapacity = INITIAL_HEADS;
  private headCount = 0;

  private uCamera: WebGLUniformLocation;
  private uPixelSize: WebGLUniformLocation;
  private uHalfWidthPx: WebGLUniformLocation;
  private uCoreHalfPx: WebGLUniformLocation;
  private uOutlineColor: WebGLUniformLocation;
  private uInvalidColor: WebGLUniformLocation;
  private uInvalidMix: WebGLUniformLocation;
  private uDashPeriodPx: WebGLUniformLocation;
  private uDashDuty: WebGLUniformLocation;
  private uDashOffsetPx: WebGLUniformLocation;
  private uToothPeriodWorld: WebGLUniformLocation;

  private hCamera: WebGLUniformLocation;
  private hPixelSize: WebGLUniformLocation;
  private hLengthPx: WebGLUniformLocation;
  private hHalfWidthPx: WebGLUniformLocation;
  private hOutlineColor: WebGLUniformLocation;
  private hInvalidColor: WebGLUniformLocation;
  private hInvalidMix: WebGLUniformLocation;

  private strokes: BattlePlanStroke[] = [];
  /** Draw ranges into `lineData`, one per stroke, in stroke order. */
  private ranges: StrokeRange[] = [];
  /** Set when `strokes` changes, so draw can skip a rebuild. */
  private dirty = true;
  /** Wall clock at the last rebuild, so the dash phase is continuous. */
  private startTime = 0;

  constructor(gl: WebGL2RenderingContext, settings: RenderSettings) {
    this.gl = gl;
    this.settings = settings;
    this.lineProgram = createProgram(gl, vertSrc, fragSrc);
    this.headProgram = createProgram(gl, headVertSrc, headFragSrc);

    this.uCamera = gl.getUniformLocation(this.lineProgram, "uCamera")!;
    this.uPixelSize = gl.getUniformLocation(this.lineProgram, "uPixelSize")!;
    this.uHalfWidthPx = gl.getUniformLocation(
      this.lineProgram,
      "uHalfWidthPx",
    )!;
    this.uCoreHalfPx = gl.getUniformLocation(this.lineProgram, "uCoreHalfPx")!;
    this.uOutlineColor = gl.getUniformLocation(
      this.lineProgram,
      "uOutlineColor",
    )!;
    this.uInvalidColor = gl.getUniformLocation(
      this.lineProgram,
      "uInvalidColor",
    )!;
    this.uInvalidMix = gl.getUniformLocation(this.lineProgram, "uInvalidMix")!;
    this.uDashPeriodPx = gl.getUniformLocation(
      this.lineProgram,
      "uDashPeriodPx",
    )!;
    this.uDashDuty = gl.getUniformLocation(this.lineProgram, "uDashDuty")!;
    this.uDashOffsetPx = gl.getUniformLocation(
      this.lineProgram,
      "uDashOffsetPx",
    )!;
    this.uToothPeriodWorld = gl.getUniformLocation(
      this.lineProgram,
      "uToothPeriodWorld",
    )!;

    this.hCamera = gl.getUniformLocation(this.headProgram, "uCamera")!;
    this.hPixelSize = gl.getUniformLocation(this.headProgram, "uPixelSize")!;
    this.hLengthPx = gl.getUniformLocation(this.headProgram, "uLengthPx")!;
    this.hHalfWidthPx = gl.getUniformLocation(
      this.headProgram,
      "uHalfWidthPx",
    )!;
    this.hOutlineColor = gl.getUniformLocation(
      this.headProgram,
      "uOutlineColor",
    )!;
    this.hInvalidColor = gl.getUniformLocation(
      this.headProgram,
      "uInvalidColor",
    )!;
    this.hInvalidMix = gl.getUniformLocation(this.headProgram, "uInvalidMix")!;

    this.lineBuffer = gl.createBuffer()!;
    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineData.byteLength, gl.DYNAMIC_DRAW);
    const lineStride = LINE_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, lineStride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, lineStride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, lineStride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, lineStride, 32);

    this.headBuffer = gl.createBuffer()!;
    this.headVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.headVao);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.headBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.headData.byteLength, gl.DYNAMIC_DRAW);
    const headStride = HEAD_FLOATS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, headStride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, headStride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, headStride, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  }

  /**
   * Replace the set of strokes to draw. Called with whatever the client currently
   * knows about; passing an empty array turns the pass off.
   */
  setStrokes(strokes: BattlePlanStroke[]): void {
    this.strokes = strokes;
    this.dirty = true;
  }

  /** Drop everything. Used when a game ends or the view is torn down. */
  clear(): void {
    this.strokes = [];
    this.dirty = true;
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    if (this.strokes.length === 0) return;
    const gl = this.gl;
    if (this.dirty) {
      this.rebuild();
      this.dirty = false;
      this.startTime = performance.now();
    }
    if (this.ranges.length === 0 && this.headCount === 0) return;

    const s = this.settings.battlePlan;
    // World units per device pixel, straight off the camera matrix, so the
    // ribbon keeps a constant weight on screen at every zoom level.
    const pixelSize = 2.0 / (cameraMatrix[0] * gl.drawingBufferWidth);
    // Dash phase advances with wall-clock time, which is what makes a live
    // offensive read as moving rather than static. The buffer is untouched by
    // this, so the animation is free.
    const dashOffset =
      ((performance.now() - this.startTime) / 1000) * s.dashSpeedPx;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.lineProgram);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.lineData,
      0,
      this.lineVertexCount * LINE_FLOATS,
    );
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uPixelSize, pixelSize);
    gl.uniform1f(this.uHalfWidthPx, s.halfWidthPx);
    gl.uniform1f(this.uCoreHalfPx, s.halfWidthPx * BATTLE_PLAN_CORE_FRACTION);
    gl.uniform1f(this.uDashPeriodPx, s.dashPeriodPx);
    gl.uniform1f(this.uDashDuty, s.dashDuty);
    gl.uniform1f(this.uDashOffsetPx, dashOffset);
    gl.uniform1f(this.uToothPeriodWorld, s.toothPeriodTiles);
    gl.uniform4f(
      this.uOutlineColor,
      s.outlineColor[0],
      s.outlineColor[1],
      s.outlineColor[2],
      1,
    );
    gl.uniform4f(
      this.uInvalidColor,
      s.invalidColor[0],
      s.invalidColor[1],
      s.invalidColor[2],
      1,
    );
    for (const range of this.ranges) {
      // Illegal sections only exist in an in-progress gesture, so this is zero
      // for every canonical plan and the fragment shader does no extra work.
      gl.uniform1f(this.uInvalidMix, range.invalid > 0 ? s.invalidMix : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, range.first, range.count);
    }

    if (this.headCount > 0) {
      gl.useProgram(this.headProgram);
      gl.bindVertexArray(this.headVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.headBuffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.headData,
        0,
        this.headCount * HEAD_FLOATS,
      );
      gl.uniformMatrix3fv(this.hCamera, false, cameraMatrix);
      gl.uniform1f(this.hPixelSize, pixelSize);
      gl.uniform1f(this.hLengthPx, s.headLengthPx);
      gl.uniform1f(this.hHalfWidthPx, s.headHalfWidthPx);
      gl.uniform4f(
        this.hOutlineColor,
        s.outlineColor[0],
        s.outlineColor[1],
        s.outlineColor[2],
        1,
      );
      gl.uniform4f(
        this.hInvalidColor,
        s.invalidColor[0],
        s.invalidColor[1],
        s.invalidColor[2],
        1,
      );
      gl.uniform1f(this.hInvalidMix, s.invalidMix);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.headCount);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.lineProgram);
    gl.deleteProgram(this.headProgram);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteVertexArray(this.headVao);
    gl.deleteBuffer(this.lineBuffer);
    gl.deleteBuffer(this.headBuffer);
  }

  /**
   * Expand every stroke into the shared line buffer, and every arrow tip into
   * the shared head buffer.
   *
   * Perpendiculars are computed here rather than in the shader so the strip does
   * not need a tangent: averaging the two adjacent segment directions at each
   * interior point keeps the ribbon from pinching on a sharp corner, which is
   * the one place an unsmoothed drawn line looks broken.
   */
  private rebuild(): void {
    this.ranges.length = 0;
    this.lineVertexCount = 0;
    this.headCount = 0;

    for (const stroke of this.strokes) {
      if (stroke.count < 2) continue;
      const style = styleFor(stroke.style);
      const boost = stroke.selected
        ? SELECT_BOOST
        : stroke.hovered
          ? HOVER_BOOST
          : 1;
      const alpha = Math.min(1, stroke.alpha * (stroke.selected ? 1 : boost));
      const verts = stroke.count * 2;
      this.ensureLineCapacity(this.lineVertexCount + verts);

      const first = this.lineVertexCount;
      let w = this.lineVertexCount * LINE_FLOATS;
      let arcDist = 0;
      let invalid = 0;
      for (let i = 0; i < stroke.count; i++) {
        const x = stroke.points[i * 2];
        const y = stroke.points[i * 2 + 1];
        if (i > 0) {
          arcDist += Math.hypot(
            x - stroke.points[(i - 1) * 2],
            y - stroke.points[(i - 1) * 2 + 1],
          );
        }
        const valid = i < stroke.valid.length ? stroke.valid[i] : 1;
        if (valid === 0) invalid = 1;
        const px = perpendicular(stroke.points, stroke.count, i);
        // `side` carries the width boost as well as the sign, which is what makes
        // a hovered or selected plan read as thicker without another uniform.
        for (const side of [-boost, boost]) {
          this.lineData[w++] = x;
          this.lineData[w++] = y;
          this.lineData[w++] = -px.y;
          this.lineData[w++] = px.x;
          this.lineData[w++] = Math.min(1, stroke.color[0] * boost);
          this.lineData[w++] = Math.min(1, stroke.color[1] * boost);
          this.lineData[w++] = Math.min(1, stroke.color[2] * boost);
          this.lineData[w++] = alpha;
          this.lineData[w++] = arcDist;
          this.lineData[w++] = side;
          this.lineData[w++] = style.dashed;
          this.lineData[w++] = style.teeth;
        }
      }
      this.lineVertexCount += verts;
      this.ranges.push({ first, count: verts, invalid });

      if (style.head) this.pushHead(stroke, boost, alpha);
    }
  }

  /** Adds the arrow head at a stroke's tip, pointing along its last segment. */
  private pushHead(
    stroke: BattlePlanStroke,
    boost: number,
    alpha: number,
  ): void {
    const last = stroke.count - 1;
    const prev = Math.max(0, last - 1);
    let dx = stroke.points[last * 2] - stroke.points[prev * 2];
    let dy = stroke.points[last * 2 + 1] - stroke.points[prev * 2 + 1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) {
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }
    this.ensureHeadCapacity(this.headCount + 1);
    let w = this.headCount * HEAD_FLOATS;
    const s = this.settings.battlePlan;
    this.headData[w++] = stroke.points[last * 2];
    this.headData[w++] = stroke.points[last * 2 + 1];
    this.headData[w++] = dx;
    this.headData[w++] = dy;
    this.headData[w++] = Math.min(1, stroke.color[0] * boost);
    this.headData[w++] = Math.min(1, stroke.color[1] * boost);
    this.headData[w++] = Math.min(1, stroke.color[2] * boost);
    this.headData[w++] = alpha;
    this.headData[w++] = s.headLengthPx;
    this.headData[w++] = s.headHalfWidthPx;
    this.headData[w] =
      last < stroke.valid.length && stroke.valid[last] === 0 ? 1 : 0;
    this.headCount++;
  }

  private ensureLineCapacity(verts: number): void {
    if (verts <= this.lineCapacity) return;
    while (this.lineCapacity < verts) this.lineCapacity *= 2;
    const grown = new Float32Array(this.lineCapacity * LINE_FLOATS);
    grown.set(this.lineData);
    this.lineData = grown;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, grown.byteLength, gl.DYNAMIC_DRAW);
  }

  private ensureHeadCapacity(count: number): void {
    if (count <= this.headCapacity) return;
    while (this.headCapacity < count) this.headCapacity *= 2;
    const grown = new Float32Array(this.headCapacity * HEAD_FLOATS);
    grown.set(this.headData);
    this.headData = grown;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.headBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, grown.byteLength, gl.DYNAMIC_DRAW);
  }
}

/**
 * Which treatment a stroke gets.
 *
 * The dash on an arrow is not decoration either: a dashed line reads as
 * "intent, not yet ordered", which is exactly the difference between the live
 * preview of a gesture and the confirmed plan it becomes.
 */
function styleFor(style: BattlePlanStroke["style"]): StrokeStyle {
  switch (style) {
    case "frontline":
      // Solid with teeth: a held line, nothing pushing through it.
      return { dashed: 0, teeth: 1, head: false };
    case "fallback":
      // Dashed with teeth: a line to fall back *to*, not a line to hold.
      return { dashed: 1, teeth: 1, head: false };
    case "arrow":
    case "spearhead":
    case "move":
      return { dashed: 1, teeth: 0, head: true };
  }
}

/**
 * Unit perpendicular at point `i`, from the incoming and outgoing segments
 * averaged.
 *
 * Averaging rather than picking one is what keeps a drawn corner from pinching
 * the ribbon to a point. A degenerate tangent falls back to (0, 1) so a
 * duplicated point does not produce NaNs.
 */
function perpendicular(
  points: Float32Array,
  count: number,
  i: number,
): { x: number; y: number } {
  let tx = 0;
  let ty = 0;
  if (i > 0) {
    tx += points[i * 2] - points[(i - 1) * 2];
    ty += points[i * 2 + 1] - points[(i - 1) * 2 + 1];
  }
  if (i < count - 1) {
    tx += points[(i + 1) * 2] - points[i * 2];
    ty += points[(i + 1) * 2 + 1] - points[i * 2 + 1];
  }
  const len = Math.hypot(tx, ty);
  return len < 1e-6 ? { x: 0, y: 1 } : { x: -ty / len, y: tx / len };
}
