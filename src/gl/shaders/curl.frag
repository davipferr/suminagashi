#version 300 es
precision highp float;

// Curl (scalar vorticity) of the velocity field: how much the water is spinning at each cell.

in vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
out vec4 outColor;

void main() {
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  outColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}
