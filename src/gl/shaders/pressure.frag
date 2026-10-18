#version 300 es
precision highp float;

// One Jacobi iteration of the Poisson equation  laplacian(p) = divergence.
// Run many times; each pass spreads the pressure correction one cell further.
// Edges sample clamp-to-edge, which gives the zero-gradient (closed tank) boundary.

in vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
out vec4 outColor;

void main() {
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float div = texture(uDivergence, vUv).x;
  outColor = vec4(0.25 * (L + R + B + T - div), 0.0, 0.0, 1.0);
}
