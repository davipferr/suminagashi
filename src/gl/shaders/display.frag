#version 300 es
precision highp float;

// Renders paper seen through the ink (Beer-Lambert: transmitted = paper * exp(-density)).
// All lighting math is in linear light; the result is sRGB-encoded for the canvas.
// uView 1 shows the velocity field instead (dev only): hue = direction, brightness = speed.

in vec2 vUv;
uniform sampler2D uDye;       // rgb = optical density, a = coverage
uniform sampler2D uVelocity;
uniform sampler2D uPaperTex;  // r = brightness offset, gb = slope, a = absorbency (see paper.frag)
uniform vec2 uDyeTexel;
uniform vec4 uDyeRegion;      // xy offset, zw size: which part of the dye fills the output (export framing)
uniform vec2 uPaperScale;     // vUv -> paper tile coordinates
uniform vec3 uPaper;          // linear
uniform float uEdge;          // edge darkening strength
uniform float uRelief;        // raking light on the paper surface
uniform float uAbsorb;        // how much the paper's absorbency varies the ink
uniform int uView;
out vec4 outColor;

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Interleaved gradient noise: cheap, well-spread per-pixel dither.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// Ink at output position uv; outside the picture (contain framing margins) there is none.
vec4 dyeAt(vec2 uv) {
  vec2 d = uDyeRegion.xy + uv * uDyeRegion.zw;
  if (any(lessThan(d, vec2(0.0))) || any(greaterThan(d, vec2(1.0)))) return vec4(0.0);
  return texture(uDye, d);
}

void main() {
  if (uView == 1) {
    vec2 v = texture(uVelocity, vUv).xy;
    outColor = vec4(0.5 + 0.5 * tanh(v * 0.02), 0.5, 1.0);
    return;
  }

  vec4 ink = dyeAt(vUv);
  vec4 paper = texture(uPaperTex, vUv * uPaperScale);

  // Edge darkening: pigment collects at the rim of an ink shape as it settles, giving the thin dark
  // outline real ink and watercolor have. "Rim" = this texel has more ink than its neighborhood.
  // Offsets are 3 dye texels, converted into output UV.
  vec2 o = 3.0 * uDyeTexel / uDyeRegion.zw;
  float around = 0.25 * (
    dyeAt(vUv + vec2(o.x, 0.0)).a + dyeAt(vUv - vec2(o.x, 0.0)).a +
    dyeAt(vUv + vec2(0.0, o.y)).a + dyeAt(vUv - vec2(0.0, o.y)).a);
  float rim = clamp(ink.a - around, 0.0, 1.0);
  vec3 density = max(ink.rgb, 0.0) * (1.0 + uEdge * rim * 4.0);

  // Cloudy pulp drinks a little more ink, fibers resist it: the sheet's structure shows through the color
  // as pale wisps, the way kozo fibers show through suminagashi prints.
  density *= max(0.0, 1.0 + uAbsorb * (paper.a - 0.5) * 2.0);

  // Light rakes across from the upper left; slopes facing it brighten, the others darken.
  float light = 1.0 + uRelief * dot(paper.gb, normalize(vec2(-1.0, 1.0)));
  vec3 sheet = uPaper * (1.0 + paper.r) * light;

  vec3 color = sheet * exp(-density);
  // +-half an 8-bit step of noise breaks up banding in soft ink washes.
  vec3 srgb = linearToSrgb(color) + (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(srgb, 1.0);
}
