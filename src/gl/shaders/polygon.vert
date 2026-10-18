#version 300 es

// Marbling polygons, in marbling units (canvas heights, y down), to clip space.
// Stencil pass: the polygon's own vertices drawn as a triangle fan (aPos).
// Cover pass (uCover = 1): a quad over the polygon's bounding box, built from gl_VertexID.

in vec2 aPos;
uniform vec2 uOrigin;   // marbling point at the target's top-left
uniform vec2 uScale;    // clip units per marbling unit (2 * pixels per unit / target size)
uniform vec4 uBox;      // cover pass: minX, minY, maxX, maxY
uniform int uCover;

void main() {
  vec2 p = aPos;
  if (uCover == 1) {
    int i = gl_VertexID;
    p = vec2(i == 1 || i == 2 ? uBox.z : uBox.x, i >= 2 ? uBox.w : uBox.y);
  }
  vec2 c = (p - uOrigin) * uScale;
  gl_Position = vec4(c.x - 1.0, 1.0 - c.y, 0.0, 1.0);
}
