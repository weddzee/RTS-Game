#version 300 es
precision highp float;

// Instance flag bits, packed in AirWingMarker.ts.
const float FLAG_OWN = 1.0;
const float FLAG_PATROL = 2.0;
const float FLAG_INTERCEPT = 4.0;
const float FLAG_STRIKE = 8.0;
const float FLAG_DEPLETED = 16.0;
const float FLAG_SELECTED = 32.0;
// Region only. Not a reuse of FLAG_STRIKE: a region has no mission, and sharing
// the bit would silently couple the two flag words.
const float FLAG_CONTESTED = 64.0;

uniform float uPxPerTile;
uniform float uTime;

flat in vec2 vLocal;
flat in vec4 vColor;
flat in float vKind;
flat in float vFlags;
flat in float vShare;
flat in vec2 vSize;       // region: the rectangle's size in tiles
flat in float vHalfWidth; // line: shaft half-width in tiles
flat in float vLength;    // line: shaft length in tiles

out vec4 fragColor;

float flag(float bit) {
  return mod(floor(vFlags / bit), 2.0);
}

/** One pixel in the instance's own local units, for a stable antialiased edge. */
float localPixel() {
  return 1.0 / max(uPxPerTile, 0.0001);
}

// ---------------------------------------------------------------------------
// Region overlay
// ---------------------------------------------------------------------------

/**
 * A region's air picture, as a wash plus an edge.
 *
 * Alpha follows the leading side's SHARE rather than being a constant: a region
 * nobody is contesting is barely tinted, and one side holding the whole sky is
 * washed in its colour. A contested region pulses, because "both sides are
 * here" is the state a player most needs to notice.
 *
 * Deliberately faint. The territory layer is underneath and must stay readable —
 * an air overlay that hides the map is worse than no air overlay.
 */
void drawRegion() {
  // vLocal spans [-1,+1] across the rectangle, so `edge` is a border frame
  // drawn without any per-region geometry. Its thickness is in local units, so
  // it needs no world-to-pixel correction: it scales with the region, which is
  // what a region border should do.
  float edgeDist = 1.0 - max(abs(vLocal.x), abs(vLocal.y));
  float edgeWidth = clamp(0.02 / max(min(vSize.x, vSize.y), 0.0001), 0.004, 0.2);
  float edge = 1.0 - smoothstep(0.0, edgeWidth, edgeDist);

  float share = clamp(vShare, 0.0, 100.0);
  // Parity (50) with nobody flying reads as "no air here": leave it untinted.
  float contested = flag(FLAG_CONTESTED);
  float presence = step(0.5, abs(share - 50.0));
  float wash = (0.08 + 0.26 * (share / 100.0)) * presence;

  vec3 color = vColor.rgb;
  float alpha = wash * vColor.a;

  // The border is the readable part: it says "this is a region" without
  // tinting the ground underneath, and a contested one pulses.
  float pulse = mix(1.0, 0.55 + 0.45 * sin(uTime * 4.0), contested);
  color = mix(color, vec3(1.0), contested * 0.35);
  alpha = max(alpha, edge * vColor.a * pulse * 0.85);

  fragColor = vec4(color, alpha);
}

// ---------------------------------------------------------------------------
// Wing icon
// ---------------------------------------------------------------------------

/**
 * A wing icon: a chevron for a fighter wing, a filled delta for a bomber, with
 * a hollow core when the wing has been gutted and is rebuilding.
 *
 * One shape, no atlas, no sprite: a wing is an abstraction and so is its
 * marker. The glyph difference between the two aircraft types is the only
 * thing a player needs to read a map covered in icons.
 */
void drawMarker() {
  float px = localPixel();
  vec2 p = vLocal;

  // Chevron (pointing "up" the map) for fighters, delta for bombers. Both are
  // built from the same two half-planes so the silhouette stays crisp.
  bool bomber = flag(FLAG_STRIKE) > 0.5;
  bool depleted = flag(FLAG_DEPLETED) > 0.5;

  float d;
  if (bomber) {
    // Isoceles triangle: |x| <= (1 - y) * 0.9, tip at y = -1.
    float w = (1.0 - p.y) * 0.9;
    d = max(abs(p.x) - max(w, 0.0), -1.0 - p.y);
    d = max(d, p.y - 1.0);
  } else {
    // Chevron: a thick V, open at the bottom.
    float arm = abs(p.x) * 0.7 - (p.y + 0.15);
    d = max(arm, abs(p.y - 0.15) - 0.45);
  }

  float body = 1.0 - smoothstep(-px, px, d);
  if (body <= 0.001) discard;

  vec3 color = vColor.rgb;
  float alpha = vColor.a * body;

  if (flag(FLAG_OWN) > 0.5) {
    color = mix(color, vec3(1.0), 0.30);
  }
  if (depleted) {
    // A gutted wing reads hollow: cut the middle out rather than dimming it, so
    // "rebuilding" is legible even in a crowded region.
    float core = 1.0 - smoothstep(-px, px, d + 0.30);
    alpha *= 1.0 - core * 0.75;
  }
  if (flag(FLAG_SELECTED) > 0.5) {
    float ring = 1.0 - smoothstep(-px * 2.0, px * 2.0, abs(d + 0.16) - 0.06);
    color = mix(color, vec3(1.0), ring);
    alpha = max(alpha, ring * vColor.a);
  }
  // Intercepting fighters are the ones actually shooting this second, so they
  // get the same "engaged" pulse the ground layer uses.
  if (flag(FLAG_INTERCEPT) > 0.5) {
    alpha *= 0.78 + 0.22 * sin(uTime * 6.0);
  }

  fragColor = vec4(color, alpha);
}

// ---------------------------------------------------------------------------
// Mission line
// ---------------------------------------------------------------------------

/**
 * A wing's mission line: a shaft with an arrowhead, running from where the wing
 * is based to the region it is flying.
 *
 * vLocal.x runs 0..1 along the line and vLocal.y -1..1 across it. The head is
 * the last stretch, so the whole arrow is one quad and one draw call regardless
 * of how far the wing is flying.
 */
void drawLine() {
  float px = localPixel();
  float t = (vLocal.x + 1.0) * 0.5;
  // Shaft only: the last `headFrac` of the quad is the arrowhead.
  float headFrac = clamp(vHalfWidth * 2.0 / max(vLength + vHalfWidth * 2.0, 0.0001), 0.0, 0.5);
  float shaftT = 1.0 - headFrac;

  float shaft = 1.0 - smoothstep(0.55, 1.0, abs(vLocal.y));
  float shaftMask = step(t, shaftT) * shaft;

  // Arrowhead: a triangle whose width tapers to zero at the tip.
  float head = (1.0 - t) / max(headFrac, 0.0001);
  float headWidth = clamp(head, 0.0, 1.0);
  float headShape = 1.0 - smoothstep(headWidth - 0.08, headWidth + 0.08, abs(vLocal.y));
  float headMask = step(shaftT, t) * headShape;

  float a = max(shaftMask, headMask);
  if (a <= 0.001) discard;

  vec3 color = vColor.rgb;
  if (flag(FLAG_OWN) > 0.5) {
    color = mix(color, vec3(1.0), 0.25);
  }
  // A dash running toward the target, so the line reads as "going there"
  // instead of "connected to". Phase is a uniform, so nothing is re-uploaded.
  float dash = 0.55 + 0.45 * sin((t * vLength * 0.35 - uTime * 3.0) * 3.14159);
  fragColor = vec4(color, a * vColor.a * (0.55 + 0.45 * dash));
}

void main() {
  if (vKind < 0.5) {
    drawRegion();
  } else if (vKind < 1.5) {
    drawMarker();
  } else {
    drawLine();
  }
}