#version 300 es
precision highp float;

// Converts the rasterized marbling layer (sRGB color, premultiplied by coverage after MSAA resolve)
// into the same dye format the fluid uses (rgb = optical density, a = coverage), so both modes share
// the display.

in vec2 vUv;
uniform sampler2D uInk;
out vec4 outColor;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  vec4 c = texture(uInk, vUv);
  if (c.a <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  // Same as inkDensity() in color.ts: paper * exp(-density) shows exactly the ink color.
  vec3 density = -log(max(srgbToLinear(c.rgb / c.a), vec3(0.01)));
  outColor = vec4(density * c.a, c.a);
}
