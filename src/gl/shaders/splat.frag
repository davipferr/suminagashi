#version 300 es
precision highp float;

// Drops a round blob of ink into the dye field.
// Dye stores rgb = optical density per channel (absorbance), a = ink coverage (0..1).
// A drop displaces what was there, so inside the blob the field moves toward the new ink.

in vec2 vUv;
uniform sampler2D uTarget;
uniform float uAspect;   // width / height, so drops stay round
uniform vec2 uPoint;     // drop center in UV
uniform vec3 uDensity;   // ink absorbance per channel
uniform float uRadius;   // as a fraction of the canvas height
uniform float uHardness; // 0 = soft gaussian-like falloff, 1 = razor edge
out vec4 outColor;

void main() {
  vec2 d = vUv - uPoint;
  d.x *= uAspect;
  float r = length(d) / uRadius;
  float a = 1.0 - smoothstep(uHardness * 0.95, 1.0, r);
  vec4 base = texture(uTarget, vUv);
  outColor = mix(base, vec4(uDensity, 1.0), a);
}
