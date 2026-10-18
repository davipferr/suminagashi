#version 300 es
precision highp float;

// Bakes one tile of paper. Output:
//   r  = brightness offset (multiplies the paper color by 1 + r)
//   gb = surface slope (height gradient per texel), lit in the display shader
//   a  = absorbency 0..1: cloudy pulp drinks more ink, fibers (sized, raised) resist it
// Everything is periodic over the tile, so it repeats without seams.

in vec2 vUv;
uniform sampler2D uFibers;  // r = fibers, g = specks; drawn tileable on Canvas 2D
uniform float uSize;        // texels per tile
uniform float uSeed;
uniform float uFiberTone;
uniform float uMottle;
uniform float uGrain;
uniform float uTooth;
uniform float uFiberRelief; // how raised fibers are; low, or 1-px strands read as dark scratches
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21) + uSeed);
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Value noise with an integer period, so it tiles.
float vnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(mod(i, period));
  float b = hash(mod(i + vec2(1.0, 0.0), period));
  float c = hash(mod(i + vec2(0.0, 1.0), period));
  float d = hash(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 0..1, starting at `freq` cells per tile and doubling each octave.
float fbm(vec2 uv, float freq) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int k = 0; k < 5; k++) {
    sum += amp * vnoise(uv * freq, freq);
    norm += amp;
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}

float heightAt(vec2 uv) {
  float fibers = texture(uFibers, uv).r;
  float tooth = fbm(uv, 48.0);
  return uFiberRelief * fibers + uTooth * tooth;
}

void main() {
  vec2 uv = vUv;
  float t = 1.0 / uSize;
  vec2 slope = 0.5 * vec2(
    heightAt(uv + vec2(t, 0.0)) - heightAt(uv - vec2(t, 0.0)),
    heightAt(uv + vec2(0.0, t)) - heightAt(uv - vec2(0.0, t)));

  vec2 f = texture(uFibers, uv).rg;
  float tone =
    (fbm(uv, 3.0) - 0.5) * 2.0 * uMottle +
    (hash(floor(uv * uSize)) - 0.5) * 2.0 * uGrain +
    f.r * uFiberTone -
    f.g * 0.35;

  float absorb = clamp(0.5 + 0.5 * (fbm(uv, 12.0) - 0.5) - 0.6 * f.r, 0.0, 1.0);
  outColor = vec4(tone, slope, absorb);
}
