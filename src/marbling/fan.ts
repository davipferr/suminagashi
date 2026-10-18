import type { Coords } from './geometry';

/** Vertices per run at each level of the hierarchy. */
const RUN = 32;

/**
 * Triangles whose signed coverage adds up to a polygon's winding number, for a stencil fill.
 *
 * A plain fan from one vertex works for any polygon, but every triangle reaches back to that vertex:
 * for a polygon folded into long filaments across the canvas, each pixel ends up covered by hundreds of
 * triangles, and the GPU spends its time filling them. Here the outline is cut into runs of RUN
 * consecutive vertices; each run is closed on itself and fanned from its own first vertex (small, local
 * triangles), and the runs are joined by a coarse "skeleton" polygon through their end points, which is
 * filled the same way, recursively. Winding numbers add: the closing edge of each run cancels the matching
 * skeleton edge, so the total is exactly the original polygon's winding everywhere.
 *
 * Writes (x, y) triples per triangle into `out` starting at `at`; returns the new end.
 */
export function windingTriangles(pts: Coords, out: Float32Array, at: number): number {
  const n = pts.length >> 1;
  if (n < 3) return at;
  if (n <= RUN) return fan(pts, 0, n, true, out, at);

  const skeleton = new Float64Array(Math.ceil(n / RUN) * 2);
  let k = 0;
  for (let start = 0; start < n; start += RUN) {
    const end = Math.min(start + RUN, n); // run covers edges start..end (end wraps to 0 for the last run)
    skeleton[k++] = pts[2 * start];
    skeleton[k++] = pts[2 * start + 1];
    at = fan(pts, start, end, false, out, at);
  }
  return windingTriangles(skeleton, out, at);
}

/**
 * Fan from vertex `start` over the edges start -> start+1 -> ... -> end (end taken mod n). `closed` means the
 * range is the whole polygon; otherwise the run is implicitly closed by its chord back to vertex `start`,
 * which contributes nothing (a degenerate triangle).
 */
function fan(pts: Coords, start: number, end: number, closed: boolean, out: Float32Array, at: number): number {
  const n = pts.length >> 1;
  const px = pts[2 * start];
  const py = pts[2 * start + 1];
  const last = closed ? end - 1 : end;
  for (let i = start + 1; i < last; i++) {
    const j = ((i + 1) % n) * 2;
    out[at++] = px;
    out[at++] = py;
    out[at++] = pts[2 * i];
    out[at++] = pts[2 * i + 1];
    out[at++] = pts[j];
    out[at++] = pts[j + 1];
  }
  return at;
}

/** Upper bound on floats windingTriangles may write for a polygon of n vertices. */
export function windingTriangleFloats(n: number): number {
  // n triangles at the first level, n / RUN at the next, ...: below 2n triangles, 6 floats each.
  return 12 * n + 36;
}
