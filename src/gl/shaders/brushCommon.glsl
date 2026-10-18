// Shared by bristle.frag and bleed.frag (prepended at load time).

float cro(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}

// Inigo Quilez's uneven capsule, arbitrary orientation (same as capsule.frag).
float sdUnevenCapsule(vec2 p, vec2 pa, vec2 pb, float ra, float rb) {
  p -= pa;
  pb -= pa;
  float h = dot(pb, pb);
  float b = ra - rb;
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

// Where p falls along the segment a -> b, 0..1.
float along(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float h = dot(ab, ab);
  return h < 1e-14 ? 0.0 : clamp(dot(p - a, ab) / h, 0.0, 1.0);
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Value noise in canvas units, so the grain is the same at any resolution.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
