#version 300 es
precision highp float;

// Multiplies a field by a constant. Used to decay last frame's pressure, which then
// seeds the Jacobi solve (warm start) so fewer iterations are needed.

in vec2 vUv;
uniform sampler2D uTarget;
uniform float uKeep;
out vec4 outColor;

void main() {
  outColor = texture(uTarget, vUv) * uKeep;
}
