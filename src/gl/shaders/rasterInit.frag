#version 300 es
precision highp float;

// Identity coordinate map: right after flattening, every point's ink is where the base image has it.
in vec2 vUv;
out vec4 outColor;

void main() {
  outColor = vec4(vUv, 0.0, 1.0);
}
