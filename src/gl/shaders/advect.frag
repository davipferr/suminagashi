#version 300 es
precision highp float;

// Semi-Lagrangian advection: trace each texel backwards along the velocity and sample what was there.
// Works for any field (velocity or dye) at any resolution, since UVs are resolution independent.

in vec2 vUv;
uniform sampler2D uVelocity;  // in sim cells per second
uniform sampler2D uSource;
uniform vec2 uTexel;          // size of one sim cell in UV
uniform float uDt;
uniform float uKeep;          // fraction of the field kept this step (dissipation)
out vec4 outColor;

void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  outColor = texture(uSource, coord) * uKeep;
}
