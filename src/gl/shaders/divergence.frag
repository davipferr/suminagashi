#version 300 es
precision highp float;

// Divergence of the velocity: how much water flows out of (or into) each cell.
// Walls: a neighbor outside the tank mirrors the center velocity, so nothing flows through the edge.

in vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
out vec4 outColor;

void main() {
  vec2 C = texture(uVelocity, vUv).xy;
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;

  if (vUv.x - uTexel.x < 0.0) L = -C.x;
  if (vUv.x + uTexel.x > 1.0) R = -C.x;
  if (vUv.y - uTexel.y < 0.0) B = -C.y;
  if (vUv.y + uTexel.y > 1.0) T = -C.y;

  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}
