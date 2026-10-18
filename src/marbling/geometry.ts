import type { Point } from '../input/stroke';

/**
 * Mathematical marbling after Aubrey Jaffer ("Mathematical Marbling", 2012+).
 * Ink shapes are closed polygons; every tool is a continuous map of the plane ("warp") applied to
 * every vertex. Marbling coordinates are in canvas-height units, y down: x in [0, aspect], y in [0, 1].
 *
 * Performance note: every op warps every point of the picture, up to tens of thousands per frame. Points
 * are therefore stored as flat coordinates and warps write into a caller-owned scratch object; one JS
 * object per point per frame made the garbage collector the bottleneck (pauses of 50-100 ms).
 */

/** A polygon as flat coordinates [x0, y0, x1, y1, ...]. Never mutated once built (undo keeps references). */
export type Coords = Float64Array;

/** A writable point, reused to receive warp results. */
export interface XY {
  x: number;
  y: number;
}

/** Maps (x, y) and writes the result into `out`. Must not hold on to `out`. */
export type Warp = (x: number, y: number, out: XY) => void;

export function coords(points: readonly Point[]): Coords {
  const c = new Float64Array(points.length * 2);
  points.forEach((p, i) => {
    c[2 * i] = p.x;
    c[2 * i + 1] = p.y;
  });
  return c;
}

export function pointsOf(c: Coords): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < c.length; i += 2) out.push({ x: c[i], y: c[i + 1] });
  return out;
}

/** Warps a single point (convenience; the hot paths call warps directly). */
export function warpPoint(warp: Warp, p: Point): Point {
  const out = { x: 0, y: 0 };
  warp(p.x, p.y, out);
  return out;
}

/**
 * A drop of radius sqrt(r2) landing at c. Every point is pushed straight away from c so that
 * |P' - c|^2 = |P - c|^2 + r2: exactly enough room opens up for the new disc, and the map preserves
 * area, so older ink is stretched into rings around the drop instead of being covered.
 * Drops compose: r2 values add, which lets a held drop grow in small steps.
 */
export function dropWarp(c: Point, r2: number): Warp {
  const cx = c.x;
  const cy = c.y;
  return (x, y, out) => {
    const dx = x - cx;
    const dy = y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-18) {
      out.x = cx + Math.sqrt(r2);
      out.y = cy;
      return;
    }
    const s = Math.sqrt(1 + r2 / d2);
    out.x = cx + dx * s;
    out.y = cy + dy * s;
  };
}

/**
 * A stylus (or several, side by side) moved from a to b. Points are dragged along the motion by
 * |ab| * lambda / (d + lambda) * window, d = distance across the stroke to the nearest stylus line:
 * ink touching the stylus travels with it, ink further away is pulled less. This is Jaffer's tine
 * line (a shear), localized to the stroke by `window`: 1 alongside the segment, easing to 0 over
 * `reach` beyond either end. `offsets` place extra styluses along the stroke's normal (a comb);
 * [0] is a single tine. `lambda` sets how wide the pull reaches across.
 *
 * The map must never fold ink over itself (folds become tangles that cost thousands of points):
 * every point moves along the stroke, by an amount that changes along the stroke at most
 * |ab| * pi / (2 reach) per unit, which `reach` >= 2|ab| keeps below 1.
 *
 * The nearest of several parallel tines is just the nearest offset across the stroke.
 */
export function strokeWarp(a: Point, b: Point, offsets: readonly number[], lambda: number): Warp {
  const ax = a.x;
  const ay = a.y;
  const dx = b.x - ax;
  const dy = b.y - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return (x, y, out) => {
      out.x = x;
      out.y = y;
    };
  }
  const ux = dx / len;
  const uy = dy / len;
  const reach = Math.max(2 * len, 4 * lambda);
  // Normal (-uy, ux), matching the side the offsets are measured on.
  const tines = Float64Array.from(offsets);
  return (x, y, out) => {
    const rx = x - ax;
    const ry = y - ay;
    const along = rx * ux + ry * uy;
    const beyond = along < 0 ? -along : along > len ? along - len : 0;
    if (beyond >= reach) {
      out.x = x;
      out.y = y;
      return;
    }
    const across = ux * ry - uy * rx;
    let off = Infinity;
    for (let i = 0; i < tines.length; i++) {
      const o = Math.abs(across - tines[i]);
      if (o < off) off = o;
    }
    const window = beyond === 0 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * beyond) / reach);
    const f = (lambda / (off + lambda)) * window;
    out.x = x + dx * f;
    out.y = y + dy * f;
  };
}

/** Several warps applied one after another, as one: a single pass over the points instead of one per warp. */
export function composeWarps(warps: readonly Warp[]): Warp {
  if (warps.length === 1) return warps[0];
  return (x, y, out) => {
    out.x = x;
    out.y = y;
    for (const w of warps) w(out.x, out.y, out);
  };
}

/** Evenly spaced tine offsets centered on the stroke. */
export function combOffsets(count: number, spacing: number): number[] {
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);
}

/** How finely polygons follow the true (warped) curves. Lengths in canvas heights. */
export interface Detail {
  /**
   * How many fine-detail points this warp may still add (shared across all the shapes of one warp, and
   * counted down as they're inserted). It only limits splits for chord error (sub-pixel detail); edges
   * longer than `maxLen` are always split, or big shapes would turn into polygons and, under-sampled,
   * their edges could cross and open holes. Omit for no limit.
   */
  budget?: { left: number };
  /**
   * Largest allowed gap between the polygon and the true curve (chord error). ~0.3 px on a
   * 1000 px canvas: below what the eye can see, so it decides how many points a curve needs.
   */
  tol: number;
  /**
   * Longest edge, even on straight runs. Keeps later warps well sampled, and keeps a drop that grows in
   * many small steps round (each step bends its edges too little to trigger a split on its own).
   */
  maxLen: number;
  /**
   * Shortest edge worth splitting (~1 px). A comb's pull has a sharp cusp on each tine path; by chord
   * error alone a cusp is never "flat enough" and splitting would run to the recursion limit.
   */
  minLen?: number;
  /** The visible area; edges entirely outside it may be `offscreenScale` times coarser. */
  view?: { minX: number; minY: number; maxX: number; maxY: number };
  offscreenScale?: number;
}

/** Recursion limit for subdividing one edge (2^12 pieces). */
const MAX_DEPTH = 12;
/** Most consecutive points simplify may merge into one edge. */
const MAX_SIMPLIFY_RUN = 32;

function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return dx * dx + dy * dy;
}

/** Growable scratch buffer for building polygons without per-point allocation. */
class Builder {
  buf = new Float64Array(1024);
  n = 0; // floats used

  reset(): void {
    this.n = 0;
  }

  push(x: number, y: number): void {
    if (this.n + 2 > this.buf.length) {
      const bigger = new Float64Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.n++] = x;
    this.buf[this.n++] = y;
  }
}

const refined = new Builder();
const simplified = new Builder();
const scratchA: XY = { x: 0, y: 0 };

type Offscreen = (x: number, y: number) => boolean;

/**
 * Applies a warp to a closed polygon, keeping it as accurate as `detail` asks with as few points as
 * possible. Point count is what makes marbling slow (every op warps every point, and combing multiplies
 * edge length each pass), so:
 * - an edge is split only where the curve actually bends away from it: its pre-warp midpoint is warped
 *   and, if that lands further than `tol` from the warped edge (and the edge is longer than `minLen`), or
 *   the edge is longer than `maxLen`, the edge is split there, recursively;
 * - then points that sit on a straight line between their neighbours are removed;
 * - off-screen, both happen with a coarser tolerance.
 */
export function warpPolygon(pts: Coords, warp: Warp, detail: Detail): Coords {
  const { maxLen, view } = detail;
  const minLen2 = (detail.minLen ?? 0) ** 2;
  const tol2 = detail.tol * detail.tol;
  const offScale = detail.offscreenScale ?? 1;
  const offTol2 = tol2 * offScale * offScale;
  const maxLen2 = maxLen * maxLen;
  const offscreen: Offscreen = view
    ? (x, y) => x < view.minX || x > view.maxX || y < view.minY || y > view.maxY
    : () => false;
  const budget = detail.budget;

  const n = pts.length >> 1;
  const warped = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    warp(pts[i], pts[i + 1], scratchA);
    warped[i] = scratchA.x;
    warped[i + 1] = scratchA.y;
  }

  refined.reset();
  const subdivide = (
    px: number,
    py: number,
    qx: number,
    qy: number,
    tpx: number,
    tpy: number,
    tqx: number,
    tqy: number,
    depth: number,
  ): void => {
    if (depth >= MAX_DEPTH) return;
    const mx = (px + qx) / 2;
    const my = (py + qy) / 2;
    warp(mx, my, scratchA);
    const tmx = scratchA.x;
    const tmy = scratchA.y;
    const len2 = (tqx - tpx) ** 2 + (tqy - tpy) ** 2;
    if (len2 <= maxLen2) {
      if (len2 <= minLen2 || (budget && budget.left <= 0)) return;
      const t2 = offscreen(tpx, tpy) && offscreen(tqx, tqy) ? offTol2 : tol2;
      if (segmentDistanceSq(tmx, tmy, tpx, tpy, tqx, tqy) <= t2) return;
    }
    if (budget) budget.left--;
    subdivide(px, py, mx, my, tpx, tpy, tmx, tmy, depth + 1);
    refined.push(tmx, tmy);
    subdivide(mx, my, qx, qy, tmx, tmy, tqx, tqy, depth + 1);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    refined.push(warped[2 * i], warped[2 * i + 1]);
    subdivide(
      pts[2 * i],
      pts[2 * i + 1],
      pts[2 * j],
      pts[2 * j + 1],
      warped[2 * i],
      warped[2 * i + 1],
      warped[2 * j],
      warped[2 * j + 1],
      0,
    );
  }
  return simplifyInto(refined.buf, refined.n >> 1, detail.tol * 0.5, maxLen, offscreen, offScale);
}

/**
 * Drops points that lie (within `tol`) on the line between the last kept point and the next one, as long
 * as the merged edge stays under `maxLen`. Every point dropped since the last kept one is re-checked against
 * the longer chord, so error can't creep up along a gentle curve. Use half the refinement tolerance, so
 * refine and simplify don't fight over the same points from one warp to the next.
 */
export function simplify(pts: Coords, tol: number, maxLen: number): Coords {
  return simplifyInto(pts, pts.length >> 1, tol, maxLen, () => false, 1);
}

function simplifyInto(
  pts: Float64Array,
  n: number,
  tol: number,
  maxLen: number,
  offscreen: Offscreen,
  offscreenScale: number,
): Coords {
  if (n <= 3) return pts.slice(0, n * 2);
  const tol2 = tol * tol;
  const offTol2 = tol2 * offscreenScale * offscreenScale;
  const maxLen2 = maxLen * maxLen;
  simplified.reset();
  simplified.push(pts[0], pts[1]);
  /** Index of the last kept point; everything after it up to i is being considered for removal. */
  let kept = 0;
  for (let i = 1; i < n; i++) {
    const ax = pts[2 * kept];
    const ay = pts[2 * kept + 1];
    const k = ((i + 1) % n) * 2;
    const bx = pts[k];
    const by = pts[k + 1];
    const t2 = offscreen(ax, ay) && offscreen(bx, by) ? offTol2 : tol2;
    const span2 = (bx - ax) ** 2 + (by - ay) ** 2;
    // The re-check below is O(run); capping the run keeps simplify linear overall.
    let fits = span2 <= maxLen2 && i - kept <= MAX_SIMPLIFY_RUN;
    for (let j = kept + 1; fits && j <= i; j++) {
      fits = segmentDistanceSq(pts[2 * j], pts[2 * j + 1], ax, ay, bx, by) <= t2;
    }
    if (fits) continue;
    simplified.push(pts[2 * i], pts[2 * i + 1]);
    kept = i;
  }
  return simplified.n >= 6 ? simplified.buf.slice(0, simplified.n) : pts.slice(0, n * 2);
}

/** A circle as a polygon that strays at most `tol` from the true circle. */
export function circle(c: Point, r: number, tol: number): Coords {
  // Chord of length L sags r - sqrt(r^2 - L^2/4) ~= L^2 / 8r below the arc.
  const seg = Math.sqrt(8 * r * Math.min(tol, r));
  const n = Math.max(16, Math.ceil((2 * Math.PI * r) / seg));
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out[2 * i] = c.x + r * Math.cos(a);
    out[2 * i + 1] = c.y + r * Math.sin(a);
  }
  return out;
}

/** Signed shoelace area (positive for counter-clockwise in a y-up frame). */
export function polygonArea(pts: Coords): number {
  const n = pts.length >> 1;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = ((i + 1) % n) * 2;
    s += pts[2 * i] * pts[j + 1] - pts[j] * pts[2 * i + 1];
  }
  return s / 2;
}

export function bounds(pts: Coords): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
