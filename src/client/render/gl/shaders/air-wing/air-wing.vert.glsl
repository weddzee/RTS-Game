#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;
// Per-instance shape A. Meaning depends on vKind:
//   region: (x, y, width, height)
//   marker: (centerX, centerY, radiusTiles, unused)
//   line:   (fromX, fromY, toX, toY)
layout(location = 1) in vec4 aA;
// Per-instance: (kind, flags, sharePercent, halfWidth)
layout(location = 2) in vec4 aB;
// Per-instance: r, g, b, alpha
layout(location = 3) in vec4 aColor;

uniform mat3 uCamera;

flat out vec2 vLocal;   // [-1,+1] within the instance quad
flat out vec4 vColor;
flat out float vKind;
flat out float vFlags;
flat out float vShare;      // region: share of the air war, 0..100
flat out vec2 vSize;        // region: the rectangle's size in tiles
flat out float vHalfWidth;  // line: shaft half-width in tiles
flat out float vLength;     // line: shaft length in tiles

void main() {
  vKind = aB.x;
  vFlags = aB.y;
  vShare = aB.z;
  vLocal = aPos * 2.0 - 1.0;
  vColor = aColor;
  vHalfWidth = aB.w;
  vSize = vec2(1.0, 1.0);
  vLength = 0.0;

  vec2 world;

  if (vKind < 0.5) {
    // Region overlay: aPos 0/1 maps onto the rectangle's corner pair, so one
    // instanced quad covers a whole air region with no geometry per region.
    vSize = aA.zw;
    world = aA.xy + aPos * aA.zw;
  } else if (vKind < 1.5) {
    // Wing icon: a quad a fixed number of TILES across, anchored at the centre
    // of the region the wing flies in. Tiles, not pixels, so it does not
    // balloon as the camera zooms — same rule the army markers follow.
    world = aA.xy + vLocal * aA.z;
  } else {
    // Mission line: a quad stretched along the segment, with room past the tip
    // for the arrowhead. Built here so the CPU side pushes only two endpoints.
    vec2 from = aA.xy;
    vec2 to = aA.zw;
    vec2 delta = to - from;
    float len = max(length(delta), 0.0001);
    vec2 axis = delta / len;
    vec2 perp = vec2(-axis.y, axis.x);
    float hw = max(aB.w, 0.0001);
    vLength = len;
    world = from + axis * (aPos.x * (len + hw * 2.0)) + perp * (vLocal.y * hw);
  }

  vec3 clip = uCamera * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}