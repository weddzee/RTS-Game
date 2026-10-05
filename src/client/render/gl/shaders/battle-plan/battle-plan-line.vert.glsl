#version 300 es
precision highp float;

// Strip vertex, expanded from a centreline sample into two ribbon edges.
layout(location = 0) in vec2 aCenter; // world tile coords
layout(location = 1) in vec2 aPerp;   // unit perpendicular to the tangent
layout(location = 2) in vec4 aColor;  // owner colour, alpha already applied
// (arc distance in world units, ribbon side -1/+1, is-dashed, has-teeth)
layout(location = 3) in vec4 aMeta;

uniform mat3 uCamera;
uniform float uPixelSize;      // world units per device pixel
uniform float uHalfWidthPx;    // ribbon half-width, device px

out float vArcDist;
out float vSide;
out vec4 vColor;
out float vDashed;
out float vTeeth;

void main() {
  float halfWidth = uHalfWidthPx * uPixelSize;
  vec2 world = aCenter + aPerp * (aMeta.y * halfWidth) + 0.5;

  vArcDist = aMeta.x;
  vSide = aMeta.y;
  vColor = aColor;
  vDashed = aMeta.z;
  vTeeth = aMeta.w;

  vec3 clip = uCamera * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}