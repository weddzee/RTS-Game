#version 300 es
precision highp float;

// Instance flag bits, packed in ArmyMarkerPass.
const float FLAG_OWN = 1.0;
const float FLAG_FRIENDLY = 2.0;
const float FLAG_SELECTED = 4.0;
const float FLAG_MOVING = 8.0;
const float FLAG_ENGAGING = 16.0;
const float FLAG_ATTACKING = 32.0;
const float FLAG_NEAR = 64.0;

uniform float uPxPerTile;
uniform float uNearZoom;
uniform float uTime;

in vec2 vLocal;
flat in vec3 vColor;
flat in float vFlags;

out vec4 fragColor;

float flag(float bit) {
  return mod(floor(vFlags / bit), 2.0);
}

/**
 * The marker body: a rounded diamond (a "kite"), the shape OpenFront's troop
 * counters use. Signed distance to a rhombus, so the edge is a crisp
 * antialiased line rather than a blurry blob.
 */
float kiteSdf(vec2 p) {
  vec2 q = abs(p);
  // Rotated square: |x| + |y| <= 1 is the distance-free form; the small
  // rounding term keeps the tip from aliasing into a needle.
  float d = (q.x + q.y - 0.82) * 0.70710678;
  return d - 0.04;
}

void main() {
  bool own = flag(FLAG_OWN) > 0.5;
  bool friendly = flag(FLAG_FRIENDLY) > 0.5;
  bool selected = flag(FLAG_SELECTED) > 0.5;
  bool moving = flag(FLAG_MOVING) > 0.5;
  bool engaging = flag(FLAG_ENGAGING) > 0.5;
  bool attacking = flag(FLAG_ATTACKING) > 0.5;
  bool near = flag(FLAG_NEAR) > 0.5;

  // One pixel of the marker, in local units, for a stable antialiased edge at
  // any zoom.
  float px = 1.0 / max(uPxPerTile, 0.0001);

  float d = kiteSdf(vLocal);
  float bodyAlpha = 1.0 - smoothstep(-px, px, d);
  if (bodyAlpha <= 0.001) discard;

  vec3 color = vColor;
  // Own armies read brighter, so the player's own forces are findable in a
  // crowd without needing a border or a label.
  if (own) color = mix(color, vec3(1.0), 0.28);
  else if (friendly) color = mix(color, vec3(1.0), 0.12);

  // The kite is "filled" toward the top so its facing is legible: a moving or
  // attacking army gets a lighter leading edge.
  if (moving || attacking) {
    float head = smoothstep(0.0, -0.9, vLocal.y);
    color = mix(color, vec3(1.0), head * 0.45);
  }

  float alpha = bodyAlpha;

  // Detail ring at close zoom only: a thin dark outline plus a selection halo.
  if (near) {
    float outline = 1.0 - smoothstep(-px * 2.0, px * 2.0, d + 0.09);
    color = mix(color, vec3(0.05), outline * 0.85);
    alpha = max(alpha, outline * 0.85);
  }
  if (selected) {
    float ring = 1.0 - smoothstep(-px * 2.0, px * 2.0, abs(d + 0.16) - 0.045);
    color = mix(color, vec3(1.0), 0.9);
    alpha = max(alpha, ring);
  }

  // Status icon at close zoom: a slash through the kite for an army that is
  // actively attacking or in melee. Cheap, unmistakable, and no sprite atlas.
  if (near && (attacking || engaging)) {
    float slash = 1.0 - smoothstep(-px * 2.0, px * 2.0, abs(vLocal.y + vLocal.x * 0.35) - 0.09);
    slash *= step(d, 0.0);
    color = mix(color, vec3(1.0), slash * 0.95);
    alpha = max(alpha, slash);
  }

  // A slow pulse while engaged, so a fight in progress is visible even when the
  // player is looking at the whole map.
  if (engaging) {
    alpha *= 0.75 + 0.25 * sin(uTime * 6.0);
  }

  fragColor = vec4(color, alpha);
}