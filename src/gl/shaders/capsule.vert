#version 300 es

// One stroke segment per instance: a quad over the bounding box of its two end circles (plus an
// antialiasing margin). The fragment shader cuts the exact tapered-capsule shape out of it.
// Positions in canvas heights, y down.

in vec3 aA;  // x, y, radius at the segment start
in vec3 aB;  // x, y, radius at the segment end
uniform vec2 uOrigin;  // canvas point at the target's top-left
uniform float uScale;  // target pixels per canvas unit
uniform vec2 uSize;    // target size in pixels

out vec2 vP;
flat out vec3 vA;
flat out vec3 vB;

void main() {
  float pad = 1.5 / uScale;
  vec2 lo = min(aA.xy - aA.z, aB.xy - aB.z) - pad;
  vec2 hi = max(aA.xy + aA.z, aB.xy + aB.z) + pad;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 p = mix(lo, hi, corner);
  vP = p;
  vA = aA;
  vB = aB;
  vec2 px = (p - uOrigin) * uScale;
  gl_Position = vec4(px.x / uSize.x * 2.0 - 1.0, 1.0 - px.y / uSize.y * 2.0, 0.0, 1.0);
}
