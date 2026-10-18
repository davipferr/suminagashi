#version 300 es
precision highp float;

// Coverage of a tapered capsule (two circles of different radius joined by their tangent lines), from its
// exact signed distance. Strokes are unions of these, accumulated with MAX blending: overlaps (a stroke
// crossing itself, consecutive segments) never darken twice, and sharp turns stay clean — no ribbon
// normals to fold into bow-ties.

in vec2 vP;
flat in vec3 vA;
flat in vec3 vB;
uniform float uScale;  // pixels per canvas unit
uniform int uErase;    // white-out: written as 1 - coverage and combined with MIN blending
out vec4 outColor;

float cro(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}

// Inigo Quilez's uneven capsule, arbitrary orientation.
float sdUnevenCapsule(vec2 p, vec2 pa, vec2 pb, float ra, float rb) {
  p -= pa;
  pb -= pa;
  float h = dot(pb, pb);
  float b = ra - rb;
  // Degenerate: a dot, or one end circle swallowing the other.
  if (h < 1e-14 || b * b >= h) return min(length(p) - ra, length(p - pb) - rb);
  vec2 q = vec2(dot(p, vec2(pb.y, -pb.x)), dot(p, pb)) / h;
  q.x = abs(q.x);
  vec2 c = vec2(sqrt(h - b * b), b);
  float k = cro(c, q);
  float m = dot(c, q);
  float n = dot(q, q);
  if (k < 0.0) return sqrt(h * n) - ra;
  if (k > c.x) return sqrt(h * (n + 1.0 - 2.0 * q.y)) - rb;
  return m - ra;
}

void main() {
  float d = sdUnevenCapsule(vP, vA.xy, vB.xy, vA.z, vB.z) * uScale;  // in pixels
  // One-pixel-wide edge ramp: crisp like nib ink, no stair steps. Hairlines thinner than a pixel fade
  // instead of breaking up.
  float coverage = clamp(0.5 - d, 0.0, 1.0);
  if (coverage <= 0.0) discard;
  outColor = vec4(uErase == 1 ? 1.0 - coverage : coverage);
}
