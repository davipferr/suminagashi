#version 300 es
precision highp float;

// Vorticity confinement: numerical diffusion smears small eddies away, so push velocity
// around existing curl to keep the swirls alive. This is what makes ink curl instead of blur.

in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uDt;
out vec4 outColor;

void main() {
  float L = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float C = texture(uCurl, vUv).x;

  // N points toward stronger spin; the force is N x curl, i.e. N turned 90 degrees and scaled by the curl.
  vec2 N = 0.5 * vec2(abs(R) - abs(L), abs(T) - abs(B));
  N /= length(N) + 1e-5;
  vec2 force = uStrength * C * vec2(N.y, -N.x);

  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  outColor = vec4(vel, 0.0, 1.0);
}
