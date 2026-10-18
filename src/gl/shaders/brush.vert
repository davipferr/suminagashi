#version 300 es

// Brush marks, one segment per instance (see brush.ts): a bristle track (xy, radius, ink) or a stretch of
// bleed halo (xy, core radius, reach). A quad covers both end circles plus the halo and an antialiasing
// margin; the fragment shaders cut the shape out. Positions in canvas heights, y down.

in vec4 aA;
in vec4 aB;
uniform vec2 uOrigin;     // canvas point at the target's top-left
uniform float uScale;     // target pixels per canvas unit
uniform vec2 uSize;       // target size in pixels
uniform float uReachPad;  // bleed: how far past the core the halo can reach, in multiples of `reach` (0 for bristles)

out vec2 vP;
flat out vec4 vA;
flat out vec4 vB;

void main() {
  float ra = aA.z + aA.w * uReachPad;
  float rb = aB.z + aB.w * uReachPad;
  float pad = 1.5 / uScale;
  vec2 lo = min(aA.xy - ra, aB.xy - rb) - pad;
  vec2 hi = max(aA.xy + ra, aB.xy + rb) + pad;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 p = mix(lo, hi, corner);
  vP = p;
  vA = aA;
  vB = aB;
  vec2 px = (p - uOrigin) * uScale;
  gl_Position = vec4(px.x / uSize.x * 2.0 - 1.0, 1.0 - px.y / uSize.y * 2.0, 0.0, 1.0);
}
