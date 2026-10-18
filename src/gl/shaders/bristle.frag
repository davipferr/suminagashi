// One stretch of a bristle's track: a thin tapered capsule, as dark as the ink the bristle still carries.
// A dry bristle only touches the paper's high spots (its tooth and fibers), so its track breaks up into the
// streaky texture of dry brush (飛白); a loaded one fills the valleys too and leaves solid ink.

in vec2 vP;
flat in vec4 vA;  // x, y, radius, ink at the start
flat in vec4 vB;  // ... at the end
uniform float uScale;        // pixels per canvas unit
uniform sampler2D uPaperTex; // the display's paper (a = absorbency); one tile spans the target height
uniform vec2 uSize;          // target size in pixels
out vec4 outColor;

void main() {
  float d = sdUnevenCapsule(vP, vA.xy, vB.xy, vA.z, vB.z) * uScale;
  float coverage = clamp(0.5 - d, 0.0, 1.0);
  if (coverage <= 0.0) discard;
  float ink = mix(vA.w, vB.w, along(vP, vA.xy, vB.xy));

  // Paper height at this point: the sheet's own structure plus fine grain, drawn out along the stroke (the
  // hair drags pigment along the tooth). Ink reaches down to 1 - ink.
  vec2 dir = vB.xy - vA.xy;
  dir = dot(dir, dir) > 1e-14 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 local = vec2(dot(vP, dir), dot(vP, vec2(-dir.y, dir.x)));
  float paper = texture(uPaperTex, gl_FragCoord.xy / uSize.y).a;
  float grain = vnoise(local * vec2(250.0, 1400.0)) * 0.6 + vnoise(local * vec2(700.0, 3000.0)) * 0.4;
  float height = clamp(0.5 + (paper - 0.5) * 1.0 + (grain - 0.5) * 0.7, 0.0, 1.0);
  float touch = smoothstep(height - 0.15, height + 0.15, ink * 1.25 - 0.1);
  float c = coverage * touch * (0.55 + 0.45 * ink);
  if (c <= 0.0) discard;
  outColor = vec4(c);
}
