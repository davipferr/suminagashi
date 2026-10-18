// Wet ink wicking out from under the brush into the paper (滲み): a pale halo past the stroke's core, up to
// `reach` away. Its edge is shaped by the paper — thirsty pulp carries ink further, fibers and sizing stop it —
// so it feathers along the sheet's structure instead of growing as a clean offset outline. The display's edge
// darkening then gives it the tide line real bleeds dry with.

in vec2 vP;
flat in vec4 vA;  // x, y, core radius, reach at the start
flat in vec4 vB;  // ... at the end
uniform float uScale;        // pixels per canvas unit
uniform sampler2D uPaperTex; // the display's paper (a = absorbency); one tile spans the target height
uniform vec2 uSize;          // target size in pixels
uniform float uWick;         // how far this paper lets ink travel (sized, smooth paper: little)
uniform float uHalo;         // halo darkness, as coverage
out vec4 outColor;

void main() {
  float d = sdUnevenCapsule(vP, vA.xy, vB.xy, vA.z, vB.z);
  float reach = mix(vA.w, vB.w, along(vP, vA.xy, vB.xy)) * uWick;
  if (reach * uScale < 0.5) discard;
  float u = max(d, 0.0) / reach;

  float paper = texture(uPaperTex, gl_FragCoord.xy / uSize.y).a;
  // Coarse noise makes the halo come and go along the stroke; fine noise and the paper fray its edge.
  float patches = vnoise(vP * 45.0);
  float wisp = vnoise(vP * 160.0) * 0.55 + vnoise(vP * 520.0) * 0.3 + vnoise(vP * 1500.0) * 0.15;
  float limit = clamp(0.7 + (patches - 0.5) * 0.9 + (paper - 0.5) * 0.9 + (wisp - 0.5) * 0.7, 0.1, 1.4);
  float soft = max(0.08, 1.2 / (reach * uScale));
  // Pigment thins out as the water carries it away from the stroke.
  float c = uHalo * (1.0 - smoothstep(limit - soft, limit, u)) * mix(1.0, 0.45, clamp(u / limit, 0.0, 1.0));
  if (c <= 0.0) discard;
  outColor = vec4(c);
}
