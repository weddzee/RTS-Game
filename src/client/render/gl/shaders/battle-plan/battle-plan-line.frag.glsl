#version 300 es
precision highp float;

in float vArcDist;
in float vSide;
in vec4 vColor;
in float vDashed;
in float vTeeth;

uniform float uPixelSize;      // world units per device pixel
uniform float uHalfWidthPx;    // ribbon half-width, device px
uniform float uCoreHalfPx;     // solid core half-width, device px
uniform float uDashPeriodPx;   // dash + gap, device px
uniform float uDashDuty;       // fraction of the period that is drawn
uniform float uDashOffsetPx;   // animation phase, device px
uniform float uToothPeriodWorld; // tooth pitch for a frontline, world units
uniform vec4 uOutlineColor;
uniform vec4 uInvalidColor;
uniform float uInvalidMix;     // 0..1, how much invalid tint to apply

out vec4 fragColor;

/**
 * Teeth on the enemy side of a frontline: the band is cut back to a fraction of
 * its width every other period, which reads as the serrated front line in 4.2.
 * Only the +side is cut, so the teeth point outward from the player's own edge.
 */
float teethMask(float arcDist, float side) {
  float phase = fract(arcDist / uToothPeriodWorld);
  // Reach grows through the pitch, so each tooth ramps out and snaps back.
  float reach = mix(0.34, 1.0, smoothstep(0.55, 0.95, phase));
  float across = 1.0 - abs(side);
  float cut = step(side, 0.0) + step(0.0, side) * step(across, reach);
  return mix(1.0, cut, vTeeth);
}

void main() {
  float d = abs(vSide) * uHalfWidthPx;

  // Core + outline, both antialiased in device pixels so the line keeps the same
  // weight at every zoom level.
  float coreAlpha = 1.0 - smoothstep(uCoreHalfPx - 0.5, uCoreHalfPx + 0.5, d);
  float outlineAlpha = 1.0 - smoothstep(uHalfWidthPx - 0.5, uHalfWidthPx + 0.5, d);
  float alpha = outlineAlpha;

  // Dash flow, in pixel space off the CPU's cumulative arc length, so the dash
  // pattern stays a constant size on screen however far the line runs.
  if (vDashed > 0.5) {
    float pixelDist = vArcDist / uPixelSize - uDashOffsetPx;
    float phase = mod(pixelDist, uDashPeriodPx);
    alpha *= 1.0 - smoothstep(uDashDuty * uDashPeriodPx - 0.5,
                             uDashDuty * uDashPeriodPx + 0.5, phase);
  }

  alpha *= teethMask(vArcDist, vSide);
  if (alpha < 0.01) discard;

  // Blend core over outline by their relative coverage.
  float blend = outlineAlpha > 0.01 ? coreAlpha / outlineAlpha : 1.0;
  vec4 body = mix(uOutlineColor, vColor, blend);
  // An illegal section of a gesture is tinted rather than recoloured, so the
  // owner's colour still reads as the owner.
  body = mix(body, uInvalidColor, uInvalidMix);

  fragColor = vec4(body.rgb, alpha * body.a * vColor.a);
}