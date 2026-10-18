#version 300 es
precision highp float;

// Draws the raster bath (the flattened base image seen through the coordinate map) as the background of
// the marbling layer. Output is premultiplied, like the resolved polygon layer it's drawn into.

uniform highp sampler2D uMap;   // RG32F, texelFetch only
uniform sampler2D uBase;        // RGBA8, premultiplied ink colors
uniform float uAspect;
uniform vec2 uOrigin;           // marbling point at the target's top-left
uniform float uScale;           // target pixels per marbling unit
uniform float uHeight;          // target height in pixels
out vec4 outColor;

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

void main() {
  // Pixel -> marbling point (GL rows start at the bottom).
  vec2 X = uOrigin + vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y) / uScale;
  vec2 uv = vec2(X.x / uAspect, 1.0 - X.y);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
    outColor = vec4(0.0);
    return;
  }
  vec2 src = sampleMap(uv);
  outColor = src.x < -0.5 ? vec4(0.0) : texture(uBase, src);
}
