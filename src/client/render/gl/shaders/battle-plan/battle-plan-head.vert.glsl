#version 300 es
precision highp float;

layout(location = 0) in vec2 aQuad;    // unit quad corner, [0,1]^2

// Per-instance arrow head: a tip on the map, the direction it points, its size
// in device pixels and the colour to fill it with.
layout(location = 1) in vec4 iTipDir;  // (tipX, tipY, dirX, dirY)
layout(location = 2) in vec4 iColor;
layout(location = 3) in vec3 iSizeValid; // lengthPx, halfWidthPx, invalid flag

uniform mat3 uCamera;
uniform float uPixelSize;

out vec2 vLocal; // head-local: +x is the point, -x is the tail
out vec4 vColor;
out float vInvalid;

void main() {
  vec2 tip = iTipDir.xy;
  vec2 dir = iTipDir.zw;
  // A degenerate direction would produce NaNs through the whole basis; fall
  // back to a fixed heading rather than dropping the head.
  vec2 perp = abs(dir.x) < 0.001 && abs(dir.y) < 0.001 ? vec2(0.0, 1.0)
                                                       : vec2(-dir.y, dir.x);

  // The quad spans one head length behind the tip and twice the half-width
  // across, all in world units converted from device pixels.
  float lenWorld = iSizeValid.x * uPixelSize;
  float wideWorld = iSizeValid.y * uPixelSize;
  float along = -aQuad.x;
  float across = (aQuad.y * 2.0 - 1.0);

  vec2 world = tip + dir * (along * lenWorld) + perp * (across * wideWorld) + 0.5;

  vLocal = vec2(aQuad.x, across);
  vColor = iColor;
  vInvalid = iSizeValid.z;

  vec3 clip = uCamera * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}