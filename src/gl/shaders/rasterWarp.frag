#version 300 es
precision highp float;

// Updates the raster bath's coordinate map after a marbling op.
//
// The map stores, for every point of the canvas, where its ink sits in the flattened base image (base
// uv; x < -0.5 marks "no ink from the base here", e.g. inside a new drop). An op moves ink by a warp W,
// so the new map is  M'(X) = M(W^-1(X)): look up where the ink at X came from, then where that came from.
// Ops combine their symmetric copies as W = W_k o ... o W_1, so the inverses run in reverse order.
//
// Marbling coordinates: x in [0, aspect], y in [0, 1], y down. Map uv = (x / aspect, 1 - y).

in vec2 vUv;
uniform highp sampler2D uMap;   // RG32F, read with texelFetch (float textures may not be filterable)
uniform float uAspect;
uniform int uKind;              // 0 = drop / grow, 1 = stroke

uniform int uCount;             // copies in this op (<= 6)
uniform vec2 uCenters[6];       // drop / grow
uniform float uR2;
uniform vec4 uSegs[6];          // stroke: (ax, ay, bx, by)
uniform float uOffsets[12];     // comb tine offsets
uniform int uOffsetCount;
uniform float uLambda;

out vec4 outColor;

const float PI = 3.14159265358979;
const vec2 NONE = vec2(-1.0);

// Inverse of dropWarp: |P - c|^2 = |X - c|^2 - r2. Inside the new disc there is no older ink.
bool invDrop(inout vec2 X, vec2 c, float r2) {
  vec2 d = X - c;
  float d2 = dot(d, d);
  if (d2 <= r2) return false;
  X = c + d * sqrt(1.0 - r2 / d2);
  return true;
}

// Inverse of strokeWarp. Ink only moves along the stroke (a shear), by L * g(across) * window(along),
// so `across` is unchanged and `along` solves  a + L g w(a) = alongX  (monotonic: the warp never folds).
vec2 invStroke(vec2 X, vec4 seg) {
  vec2 a = seg.xy;
  vec2 d = seg.zw - seg.xy;
  float len = length(d);
  if (len == 0.0) return X;
  vec2 u = d / len;
  vec2 n = vec2(-u.y, u.x);
  vec2 r = X - a;
  float alongX = dot(r, u);
  float across = dot(r, n);
  float off = 1e9;
  for (int i = 0; i < 12; i++) {
    if (i >= uOffsetCount) break;
    off = min(off, abs(across - uOffsets[i]));
  }
  float g = uLambda / (off + uLambda);
  float reach = max(2.0 * len, 4.0 * uLambda);
  float A = alongX - len * g;  // exact if the source was alongside the segment
  for (int k = 0; k < 8; k++) {
    float beyond = A < 0.0 ? -A : (A > len ? A - len : 0.0);
    float w = 1.0;
    float dw = 0.0;
    if (beyond >= reach) {
      w = 0.0;
    } else if (beyond > 0.0) {
      float t = PI * beyond / reach;
      w = 0.5 + 0.5 * cos(t);
      dw = -0.5 * sin(t) * PI / reach * (A < 0.0 ? -1.0 : 1.0);
    }
    float f = A + len * g * w - alongX;
    A -= f / (1.0 + len * g * dw);
  }
  return a + u * A + n * across;
}

// Bilinear over the neighbours that have base ink, weights renormalized. Returns NONE only if none do.
// (Treating "any neighbour without ink" as none would grow empty regions by a texel on every op, and the
// map is updated every frame: the ink would erode away within seconds.)
vec2 sampleMap(vec2 uv) {
  ivec2 size = textureSize(uMap, 0);
  vec2 st = uv * vec2(size) - 0.5;
  ivec2 i0 = ivec2(floor(st));
  vec2 f = st - vec2(i0);
  ivec2 hi = size - 1;
  vec2 s[4];
  s[0] = texelFetch(uMap, clamp(i0, ivec2(0), hi), 0).xy;
  s[1] = texelFetch(uMap, clamp(i0 + ivec2(1, 0), ivec2(0), hi), 0).xy;
  s[2] = texelFetch(uMap, clamp(i0 + ivec2(0, 1), ivec2(0), hi), 0).xy;
  s[3] = texelFetch(uMap, clamp(i0 + ivec2(1, 1), ivec2(0), hi), 0).xy;
  float w[4];
  w[0] = (1.0 - f.x) * (1.0 - f.y);
  w[1] = f.x * (1.0 - f.y);
  w[2] = (1.0 - f.x) * f.y;
  w[3] = f.x * f.y;
  vec2 sum = vec2(0.0);
  float total = 0.0;
  for (int i = 0; i < 4; i++) {
    if (s[i].x < -0.5) continue;
    sum += s[i] * w[i];
    total += w[i];
  }
  return total > 0.0 ? sum / total : vec2(-1.0);
}

// The old map at marbling point P (manual bilinear, so it works without float filtering).
vec2 lookup(vec2 P) {
  vec2 uv = vec2(P.x / uAspect, 1.0 - P.y);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return NONE;
  return sampleMap(uv);
}

void main() {
  vec2 X = vec2(vUv.x * uAspect, 1.0 - vUv.y);
  bool ok = true;
  for (int i = 5; i >= 0; i--) {
    if (i >= uCount) continue;
    if (uKind == 0) {
      ok = ok && invDrop(X, uCenters[i], uR2);
    } else {
      X = invStroke(X, uSegs[i]);
    }
  }
  outColor = vec4(ok ? lookup(X) : NONE, 0.0, 1.0);
}
