#version 300 es
precision highp float;

// MacCormack advection (Selle et al. 2008). Plain semi-Lagrangian advection blurs a little every
// step because of bilinear sampling; over hundreds of frames ink turns to fog. Here we advect forward
// (phiHat), advect that back again (phiBar), and the difference phi - phiBar estimates the blur
// error, half of which we add back. The result is clamped to the four source texels around the
// back-traced point, so the correction can never create new extremes (no ringing, no negative ink).

in vec2 vUv;
uniform sampler2D uVelocity;  // in sim cells per second
uniform sampler2D uSource;    // phi at time n
uniform sampler2D uForward;   // phiHat: phi advected forward
uniform sampler2D uBackward;  // phiBar: phiHat advected backward
uniform vec2 uTexel;          // sim cell size in UV
uniform vec2 uDyeTexel;       // dye texel size in UV
uniform float uDt;
uniform float uKeep;
out vec4 outColor;

void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;

  vec2 c0 = (floor(coord / uDyeTexel - 0.5) + 0.5) * uDyeTexel;
  vec4 s00 = texture(uSource, c0);
  vec4 s10 = texture(uSource, c0 + vec2(uDyeTexel.x, 0.0));
  vec4 s01 = texture(uSource, c0 + vec2(0.0, uDyeTexel.y));
  vec4 s11 = texture(uSource, c0 + uDyeTexel);
  vec4 lo = min(min(s00, s10), min(s01, s11));
  vec4 hi = max(max(s00, s10), max(s01, s11));

  vec4 corrected = texture(uForward, vUv) + 0.5 * (texture(uSource, vUv) - texture(uBackward, vUv));
  outColor = clamp(corrected, lo, hi) * uKeep;
}
