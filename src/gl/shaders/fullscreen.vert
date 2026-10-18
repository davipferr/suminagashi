#version 300 es

// One oversized triangle that covers the whole viewport, built from gl_VertexID (no vertex buffer).
// Vertices: (0,0), (2,0), (0,2) in UV space -> clip space (-1,-1), (3,-1), (-1,3).
out vec2 vUv;

void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
