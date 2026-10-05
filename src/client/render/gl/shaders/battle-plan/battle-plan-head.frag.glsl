#version 300 es
precision highp float;

// vLocal.x: 0 at the point, 1 at the back of the head.
// vLocal.y: -1..+1 across the head.
in vec2 vLocal;
in vec4 vColor;
in float vInvalid;

uniform float uPixelSize;
uniform float uLengthPx;
uniform float uHalfWidthPx;
uniform vec4 uOutlineColor;
uniform vec4 uInvalidColor;
uniform float uInvalidMix;

out vec4 fragColor;

/**
 * Signed distance to a triangle, tip at (0, 0), back corners at
 * (uLengthPx, -uHalfWidthPx) and (uLengthPx, uHalfWidthPx).
 *
 * A proper SDF rather than a barycentric mask so the head keeps a clean
 * antialiased edge at any size, which is what stops it looking like a blurry
 * triangle when the player zooms out mid-drag.
 */
float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0;
  vec2 e1 = p2 - p1;
  vec2 e2 = p0 - p2;
  vec2 v0 = p - p0;
  vec2 v1 = p - p1;
  vec2 v2 = p - p2;
  vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))),
               vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

void main() {
  // Work in device pixels: vLocal.x is already the fraction of the head length,
  // so multiplying by uLengthPx puts it in the same units as the profile.
  vec2 p = vec2(vLocal.x * uLengthPx, vLocal.y * uHalfWidthPx);
  float d = sdTriangle(p, vec2(0.0, 0.0),
                       vec2(uLengthPx, -uHalfWidthPx),
                       vec2(uLengthPx, uHalfWidthPx));
  // The head is inset so it nests inside the ribbon's outline rather than
  // sitting on top of it.
  float inset = max(1.0, uLengthPx * 0.06);
  float alpha = 1.0 - smoothstep(-0.5, 0.5, d + inset);
  if (alpha < 0.01) discard;

  // A thin dark rim keeps the head legible over both the owner's own territory
  // colour and an enemy's.
  float rim = 1.0 - smoothstep(inset + 0.5, inset + 1.5, d);
  float blend = 1.0 - rim;
  vec4 body = mix(uOutlineColor, vColor, blend);
  body = mix(body, uInvalidColor, uInvalidMix * vInvalid);

  fragColor = vec4(body.rgb, alpha * body.a * vColor.a);
}