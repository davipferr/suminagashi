import { describe, expect, it } from 'vitest';
import { windingTriangleFloats, windingTriangles } from './fan';
import { coords } from './geometry';
import { mulberry32 } from '../paper/random';
import type { Point } from '../input/stroke';

/** Winding number of a closed polygon around q (standard crossing count, signed). */
function winding(pts: readonly Point[], q: Point): number {
  let w = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const side = (b.x - a.x) * (q.y - a.y) - (q.x - a.x) * (b.y - a.y);
    if (a.y <= q.y && b.y > q.y && side > 0) w++;
    else if (a.y > q.y && b.y <= q.y && side < 0) w--;
  }
  return w;
}

/** Sum of signed triangle coverage at q: what the stencil ends up holding. */
function coverage(tris: Float32Array, n: number, q: Point): number {
  let w = 0;
  for (let i = 0; i < n; i += 6) {
    const tri = [
      { x: tris[i], y: tris[i + 1] },
      { x: tris[i + 2], y: tris[i + 3] },
      { x: tris[i + 4], y: tris[i + 5] },
    ];
    w += winding(tri, q);
  }
  return w;
}

describe('windingTriangles', () => {
  it('reproduces the winding number of a messy self-overlapping polygon everywhere', () => {
    const rand = mulberry32(5);
    // A long random walk folded over itself many times: like a heavily combed shape.
    const pts: Point[] = Array.from({ length: 1500 }, (_, i) => ({
      x: 0.5 + 0.4 * Math.sin(i * 0.37) * Math.cos(i * 0.011) + 0.05 * (rand() - 0.5),
      y: 0.5 + 0.4 * Math.cos(i * 0.23) + 0.05 * (rand() - 0.5),
    }));
    const out = new Float32Array(windingTriangleFloats(pts.length));
    const n = windingTriangles(coords(pts), out, 0);
    for (let k = 0; k < 300; k++) {
      const q = { x: rand(), y: rand() };
      expect(coverage(out, n, q)).toBe(winding(pts, q));
    }
  });

  it('a small convex polygon is a plain fan', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const out = new Float32Array(windingTriangleFloats(4));
    expect(windingTriangles(coords(square), out, 0)).toBe(12); // two triangles
  });

  it('stays within its size estimate', () => {
    for (const n of [3, 31, 32, 33, 1000, 70000]) {
      const pts = Array.from({ length: n }, (_, i) => ({ x: Math.cos(i), y: Math.sin(i) }));
      const out = new Float32Array(windingTriangleFloats(n));
      expect(windingTriangles(coords(pts), out, 0)).toBeLessThanOrEqual(out.length);
    }
  });
});
