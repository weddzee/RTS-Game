#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;
// Per-instance: centerX, centerY, quadRadiusTiles, flags
layout(location = 1) in vec4 aInstance;
// Per-instance: r, g, b (owner color)
layout(location = 2) in vec3 aColor;

uniform mat3 uCamera;

out vec2 vLocal;       // [-1,+1] within the marker
flat out vec3 vColor;
flat out float vFlags;

void main() {
  vec2 local = aPos * 2.0 - 1.0;
  vLocal = local;
  vColor = aColor;
  vFlags = aInstance.w;

  // aInstance.z is the marker radius in TILES, so the marker holds its world
  // size as the camera zooms. That is deliberate: an army should not balloon
  // into the whole screen at close zoom, and should stay findable when zoomed
  // out.
  vec2 worldPos = aInstance.xy + local * aInstance.z;

  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}