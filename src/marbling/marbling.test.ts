import { describe, expect, it } from 'vitest';
import {
  circle,
  combOffsets,
  coords,
  dropWarp,
  pointsOf,
  polygonArea,
  simplify,
  strokeWarp,
  warpPoint as wp,
  warpPolygon,
  type Warp,
} from './geometry';
import { Marbling, type MarbleOp, type RasterBackend } from './marbling';

/** Stands in for the GPU RasterBath: tracks what the model asks of it, and its saved states' references. */
class MockRaster implements RasterBackend {
  active = false;
  flattens = 0;
  warps: string[] = [];
  live = new Set<{ refs: number }>();
  flatten(): void {
    this.active = true;
    this.flattens++;
  }
  warp(op: MarbleOp): void {
    if (this.active) this.warps.push(op.op);
  }
  save(): unknown {
    if (!this.active) return null;
    const s = { refs: 1 };
    this.live.add(s);
    return s;
  }
  load(s: unknown): void {
    this.active = s !== null;
  }
  retain(s: unknown): void {
    if (s) (s as { refs: number }).refs++;
  }
  release(s: unknown): void {
    const st = s as { refs: number } | null;
    if (st && --st.refs === 0) this.live.delete(st);
  }
  clear(): void {
    this.active = false;
  }
}

const identity: Warp = (x, y, out) => {
  out.x = x;
  out.y = y;
};

const square = (cx: number, cy: number, s: number, n = 40) => {
  // Densely sampled so warps act on the true shape, not a 4-corner approximation.
  const pts = [];
  const corners = [
    [cx - s, cy - s],
    [cx + s, cy - s],
    [cx + s, cy + s],
    [cx - s, cy + s],
  ];
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = corners[k];
    const [bx, by] = corners[(k + 1) % 4];
    for (let i = 0; i < n; i++) pts.push({ x: ax + ((bx - ax) * i) / n, y: ay + ((by - ay) * i) / n });
  }
  return coords(pts);
};

describe('dropWarp', () => {
  it('opens exactly a disc of the drop radius: points move from |d| to sqrt(|d|^2 + r^2)', () => {
    const p = wp(dropWarp({ x: 0, y: 0 }, 0.09), { x: 0.4, y: 0 });
    expect(p.x).toBeCloseTo(0.5, 12);
    expect(p.y).toBe(0);
  });

  it('preserves the area of the ink it pushes aside', () => {
    const sq = square(0.6, 0.5, 0.1);
    const before = Math.abs(polygonArea(sq));
    const detail = { tol: 0.0002, maxLen: 0.05 };
    const after = Math.abs(polygonArea(warpPolygon(sq, dropWarp({ x: 0.4, y: 0.45 }, 0.15 ** 2), detail)));
    expect(after / before).toBeCloseTo(1, 2);
  });

  it('composes: two drops at one point equal one drop with the radii-squared summed', () => {
    const p = { x: 0.7, y: 0.2 };
    const c = { x: 0.5, y: 0.5 };
    const twice = wp(dropWarp(c, 0.01), wp(dropWarp(c, 0.02), p));
    const once = wp(dropWarp(c, 0.03), p);
    expect(twice.x).toBeCloseTo(once.x, 12);
    expect(twice.y).toBeCloseTo(once.y, 12);
  });
});

describe('strokeWarp', () => {
  it('drags ink under the stylus the full stroke length', () => {
    const p = wp(strokeWarp({ x: 0, y: 0 }, { x: 0.1, y: 0 }, [0], 0.01), { x: 0.05, y: 0 });
    expect(p.x).toBeCloseTo(0.15, 12);
    expect(p.y).toBe(0);
  });

  it('pulls distant ink less (lambda / (d + lambda))', () => {
    const w = strokeWarp({ x: 0, y: 0 }, { x: 0.1, y: 0 }, [0], 0.01);
    expect(wp(w, { x: 0.05, y: 0.01 }).x - 0.05).toBeCloseTo(0.05, 10);
    expect(wp(w, { x: 0.05, y: 0.09 }).x - 0.05).toBeCloseTo(0.01, 10);
  });

  it('comb: each point follows its nearest tine', () => {
    const offsets = combOffsets(3, 0.1);
    expect(offsets).toEqual([-0.1, 0, 0.1]);
    // Moving along +x the normal is +y, so the tines run at y = -0.1, 0, 0.1.
    const w = strokeWarp({ x: 0, y: 0 }, { x: 0.1, y: 0 }, offsets, 0.01);
    expect(wp(w, { x: 0.05, y: 0.1 }).x).toBeCloseTo(0.15, 10);
    expect(wp(w, { x: 0.05, y: 0.05 }).x).toBeCloseTo(0.05 + 0.1 * (0.01 / 0.06), 10);
  });

  it('only reaches a little past the ends of the stroke', () => {
    const w = strokeWarp({ x: 0, y: 0 }, { x: 0.01, y: 0 }, [0], 0.008);
    const far = { x: 0.5, y: 0 };
    expect(wp(w, far)).toEqual(far);
    expect(wp(w, { x: 0.02, y: 0 }).x).toBeGreaterThan(0.02); // just ahead: still pushed
  });

  it('never folds ink over itself, even for a long step through a thin tine', () => {
    // A row of points along the stroke line; after the warp they must still be in order.
    for (const len of [0.005, 0.03, 0.1]) {
      const w = strokeWarp({ x: 0, y: 0 }, { x: len, y: 0 }, [0], 0.008);
      let prev = -Infinity;
      for (let i = -400; i <= 400; i++) {
        const x = wp(w, { x: i * 0.001, y: 0 }).x;
        expect(x).toBeGreaterThan(prev);
        prev = x;
      }
    }
  });

  it('does nothing for a zero-length stroke', () => {
    const p = { x: 0.3, y: 0.3 };
    expect(wp(strokeWarp(p, p, [0], 0.01), p)).toEqual(p);
  });
});

describe('warpPolygon', () => {
  const ring = (pts: { x: number; y: number }[], c: { x: number; y: number }) =>
    pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
  const len = (c: Float64Array) => c.length / 2;

  it('follows a curve to within tol: a drop turns a small circle into a big one, smoothly', () => {
    const c = { x: 0.5, y: 0.5 };
    const tol = 0.0003;
    const out = pointsOf(warpPolygon(circle(c, 0.02, tol), dropWarp(c, 0.2 ** 2), { tol, maxLen: 0.05 }));
    const R = Math.hypot(0.02, 0.2);
    // Every vertex is on the new circle (to within tol: inserted points come from the pre-warp chord)...
    for (const r of ring(out, c)) expect(Math.abs(r - R)).toBeLessThanOrEqual(tol);
    // ...and every edge's midpoint sags at most ~tol below it (chord error).
    for (let i = 0; i < out.length; i++) {
      const q = out[(i + 1) % out.length];
      const mid = Math.hypot((out[i].x + q.x) / 2 - c.x, (out[i].y + q.y) / 2 - c.y);
      expect(R - mid).toBeLessThanOrEqual(tol * 1.05);
    }
  });

  it('spends points where the curve bends, not on straight runs (up to maxLen)', () => {
    // A long thin rectangle, densely sampled: a straight-sided filament after combing.
    const pts = [];
    for (let i = 0; i <= 400; i++) pts.push({ x: 0.1 + i * 0.002, y: 0.5 });
    for (let i = 400; i >= 0; i--) pts.push({ x: 0.1 + i * 0.002, y: 0.502 });
    const out = warpPolygon(coords(pts), identity, { tol: 0.0003, maxLen: 0.05 });
    // 0.8 long sides kept only every maxLen: ~17 points per side instead of 401.
    expect(len(out)).toBeLessThan(40);
    expect(Math.abs(polygonArea(out))).toBeCloseTo(0.8 * 0.002, 6);
  });

  it('stops splitting at minLen, even across a cusp', () => {
    // A comb tine yanked through a straight line makes a sharp spike.
    const line = [
      { x: 0.1, y: 0.5 },
      { x: 0.9, y: 0.5 },
      { x: 0.9, y: 0.51 },
      { x: 0.1, y: 0.51 },
    ];
    const yank = strokeWarp({ x: 0.5, y: 0.3 }, { x: 0.5, y: 0.7 }, [0], 0.008);
    const out = warpPolygon(coords(line), yank, { tol: 0.0003, maxLen: 0.012, minLen: 0.0012 });
    expect(len(out)).toBeLessThan(1500);
  });

  it('is coarser off-screen', () => {
    const c = { x: 0.5, y: 0.5 };
    const big = circle(c, 0.1, 0.0003);
    const view = { minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 }; // the circle is entirely outside this
    const onScreen = warpPolygon(big, identity, { tol: 0.0003, maxLen: 1 });
    const offScreen = warpPolygon(big, identity, { tol: 0.0003, maxLen: 1, view, offscreenScale: 8 });
    expect(len(offScreen)).toBeLessThan(len(onScreen) * 0.6);
  });
});

describe('simplify', () => {
  it('never lets a dropped point drift further than tol from the final edge', () => {
    // A gentle arc: each point alone is near-collinear with its neighbours, the run as a whole is not.
    const arc = Array.from({ length: 200 }, (_, i) => {
      const a = (i / 200) * Math.PI;
      return { x: Math.cos(a), y: Math.sin(a) };
    });
    const tol = 0.001;
    const out = pointsOf(simplify(coords(arc), tol, 10));
    const same = (p: { x: number; y: number }, q: { x: number; y: number }) => p.x === q.x && p.y === q.y;
    const distToSeg = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)));
      return Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t));
    };
    let k = 0;
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      while (!same(arc[k], b)) expect(distToSeg(arc[k++], a, b)).toBeLessThanOrEqual(tol);
    }
  });

  it('keeps corners and drops collinear points', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 0.01, y: 0 },
      { x: 0.02, y: 0 },
      { x: 0.02, y: 0.02 },
      { x: 0, y: 0.02 },
    ];
    expect(pointsOf(simplify(coords(sq), 0.0001, 1))).toEqual([sq[0], sq[2], sq[3], sq[4]]);
  });
});

describe('Marbling', () => {
  it('a drop adds a disc on top and makes room for it', () => {
    const m = new Marbling({ tol: 0.0001 });
    m.drop({ x: 0.5, y: 0.5 }, 0.1, [0, 0, 0]);
    m.drop({ x: 0.5, y: 0.5 }, 0.05, [1, 0, 0]);
    expect(m.shapes).toHaveLength(2);
    // The first disc became a ring: its outline now has radius sqrt(0.1^2 + 0.05^2).
    const r = Math.hypot(m.shapes[0].pts[0] - 0.5, m.shapes[0].pts[1] - 0.5);
    expect(r).toBeCloseTo(Math.hypot(0.1, 0.05), 6);
    expect(Math.abs(polygonArea(m.shapes[1].pts))).toBeCloseTo(Math.PI * 0.05 ** 2, 4);
  });

  it('undo restores the state before the last checkpoint', () => {
    const m = new Marbling();
    m.checkpoint();
    m.drop({ x: 0.5, y: 0.5 }, 0.1, [0, 0, 0]);
    m.checkpoint();
    m.drop({ x: 0.3, y: 0.3 }, 0.1, [0, 0, 0]);
    expect(m.undo()).toBe(true);
    expect(m.shapes).toHaveLength(1);
    expect(m.undo()).toBe(true);
    expect(m.shapes).toHaveLength(0);
    expect(m.undo()).toBe(false);
  });

  it('the budget limits fine (chord-error) splits only', () => {
    const c = { x: 0.5, y: 0.5 };
    const budget = { left: 50 };
    const before = circle(c, 0.02, 0.0003);
    // maxLen out of the way: every split here is for chord error.
    const out = warpPolygon(before, dropWarp(c, 0.4 ** 2), { tol: 0.0003, maxLen: 10, budget });
    expect(out.length / 2).toBeLessThanOrEqual(before.length / 2 + 50);
    expect(budget.left).toBeLessThanOrEqual(0);
  });

  it('always splits edges longer than maxLen, budget or not, so big shapes stay round', () => {
    const c = { x: 0.5, y: 0.5 };
    const out = warpPolygon(circle(c, 0.02, 0.0003), dropWarp(c, 0.4 ** 2), {
      tol: 0.0003,
      maxLen: 0.012,
      budget: { left: 0 },
    });
    const p = pointsOf(out);
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      expect(Math.hypot(q.x - p[i].x, q.y - p[i].y)).toBeLessThanOrEqual(0.0121);
    }
  });

  it('past the point cap, the picture is flattened into the raster bath', () => {
    const m = new Marbling({ pointCap: 200 });
    const raster = new MockRaster();
    m.raster = raster;
    m.drop({ x: 0.5, y: 0.5 }, 0.1, [0, 0, 0]);
    expect(raster.flattens).toBe(0);
    m.grow({ x: 0.5, y: 0.5 }, 0.3 ** 2); // stretches the outline well past 200 points
    expect(raster.flattens).toBe(1);
    expect(m.shapes).toHaveLength(0);
    expect(m.rasterized).toBe(true);
    // From now on ops move the raster ink too.
    m.stroke([{ a: { x: 0.2, y: 0.5 }, b: { x: 0.3, y: 0.5 } }], [0], 0.01);
    expect(raster.warps).toEqual(['stroke']);
  });

  it('undo brings back the raster state, and no saved state leaks', () => {
    const m = new Marbling({ pointCap: 200 });
    const raster = new MockRaster();
    m.raster = raster;
    m.drop({ x: 0.5, y: 0.5 }, 0.1, [0, 0, 0]);
    m.grow({ x: 0.5, y: 0.5 }, 0.3 ** 2);
    m.checkpoint();
    m.clear(); // also clears the raster
    expect(m.rasterized).toBe(false);
    expect(m.undo()).toBe(true);
    expect(m.rasterized).toBe(true);
    // Only the first checkpoint's state is still held (by the undo stack); clear()'s was consumed.
    expect(raster.live.size).toBe(1);

    // Snapshot / reset / restore (replay) keeps references balanced too.
    m.checkpoint();
    const snap = m.snapshot();
    m.reset();
    expect(m.rasterized).toBe(false);
    m.restore(snap);
    expect(m.rasterized).toBe(true);
    m.reset();
    expect(raster.live.size).toBe(0);
  });

  it('forgets shapes pushed completely out of view', () => {
    const m = new Marbling({ cullMargin: 0.1 });
    m.drop({ x: 0.95, y: 0.5 }, 0.02, [0, 0, 0]);
    m.grow({ x: 0.5, y: 0.5 }, 2); // a huge drop in the middle shoves it far right
    expect(m.shapes).toHaveLength(0);
  });

  it('a circle polygon has the right area', () => {
    expect(Math.abs(polygonArea(circle({ x: 0, y: 0 }, 0.2, 0.00002)))).toBeCloseTo(Math.PI * 0.04, 4);
  });
});
