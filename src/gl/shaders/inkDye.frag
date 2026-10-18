#version 300 es
precision highp float;

// Ink coverage (finished strokes + the stroke being drawn) -> the dye format the display shader reads
// (rgb = optical density, a = coverage), so line art sits on the same paper as the other modes.

in vec2 vUv;
uniform sampler2D uCommitted;
uniform sampler2D uLive;
uniform vec3 uDensity;  // ink density at full coverage
uniform int uLiveErase; // the stroke in progress is white-out: it removes coverage
out vec4 outColor;

void main() {
  float c = texture(uCommitted, vUv).r;
  float live = texture(uLive, vUv).r;
  c = uLiveErase == 1 ? min(c, 1.0 - live) : max(c, live);
  outColor = vec4(uDensity * c, c);
}
