#version 300 es
precision highp float;

uniform vec3 uColor;  // sRGB
out vec4 outColor;

void main() {
  outColor = vec4(uColor, 1.0);
}
