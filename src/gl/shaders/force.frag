#version 300 es
precision highp float;

// Adds a soft round push to the velocity field (what your finger does to the water).

in vec2 vUv;
uniform sampler2D uTarget;
uniform float uAspect;   // width / height, so the push stays round
uniform vec2 uPoint;     // center in UV
uniform vec2 uForce;     // in sim cells per second
uniform float uRadius;   // as a fraction of the canvas height
out vec4 outColor;

void main() {
  vec2 d = vUv - uPoint;
  d.x *= uAspect;
  float a = exp(-dot(d, d) / (uRadius * uRadius));
  vec2 vel = texture(uTarget, vUv).xy + uForce * a;
  outColor = vec4(vel, 0.0, 1.0);
}
