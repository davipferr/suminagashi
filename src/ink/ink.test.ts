import { describe, expect, it } from 'vitest';
import { OneEuro2D } from './oneEuro';
import { buildStroke, G_PEN, strokeSegments, type PenSample } from './pen';
import { InkModel, stabilizerParams } from './ink';
import { mulberry32 } from '../paper/random';

/** A straight horizontal line, sampled at 240 Hz, at `speed` canvas heights per second. */
const line = (speed: number, length: number, pressure: number | null = 0.7): PenSample[] => {
  const n = Math.max(2, Math.round((length / speed) * 240));
  return Array.from({ length: n }, (_, i) => ({ x: 0.1 + (length * i) / (n - 1), y: 0.5, t: i / 240, pressure }));
};

describe('OneEuro2D', () => {
  // The app's default stabilizer.
  const app = () => {
    const { minCutoff, beta } = stabilizerParams(0.5);
    return new OneEuro2D(minCutoff, beta);
  };

  it('removes hand tremor from a slow line', () => {
    const rand = mulberry32(3);
    const f = app();
    let rawJitter = 0;
    let outJitter = 0;
    for (let i = 0; i < 480; i++) {
      const noise = (rand() - 0.5) * 0.004;
      const out = f.filter({ x: 0.1 + i * 0.0002, y: 0.5 + noise }, i / 240); // 0.05 heights/s
      if (i > 60) {
        rawJitter += Math.abs(noise);
        outJitter += Math.abs(out.y - 0.5);
      }
    }
    expect(outJitter).toBeLessThan(rawJitter / 2.5);
  });

  it('barely lags a fast stroke', () => {
    const f = app();
    let out = { x: 0, y: 0 };
    for (let i = 0; i <= 60; i++) out = f.filter({ x: i * 0.0125, y: 0.5 }, i / 240); // 3 heights/s
    const lagSeconds = (60 * 0.0125 - out.x) / 3;
    expect(lagSeconds).toBeLessThan(0.005); // under a third of a frame
  });

  it('stabilizer strength maps to smoother (lower) cutoffs', () => {
    expect(stabilizerParams(1).minCutoff).toBeLessThan(stabilizerParams(0).minCutoff);
  });
});

describe('buildStroke (G-pen)', () => {
  const spacing = 0.002;
  const maxR = (pts: { r: number }[]) => Math.max(...pts.map((p) => p.r));
  const midR = (pts: { r: number }[]) => pts[Math.floor(pts.length / 2)].r;

  it('presses thicker', () => {
    const light = buildStroke(line(0.5, 0.3, 0.2), G_PEN, spacing, false);
    const firm = buildStroke(line(0.5, 0.3, 0.9), G_PEN, spacing, false);
    expect(maxR(firm)).toBeGreaterThan(maxR(light) * 2);
  });

  it('thins out when drawn fast, even at the same pressure', () => {
    const slow = buildStroke(line(0.2, 0.3), G_PEN, spacing, false);
    const fast = buildStroke(line(4, 0.3), G_PEN, spacing, false);
    expect(midR(fast)).toBeLessThan(midR(slow) * 0.6);
    expect(maxR(fast)).toBeLessThan(maxR(slow) * 0.6); // no fat blob at the start either
  });

  it('starts from a point (entry taper)', () => {
    const pts = buildStroke(line(0.5, 0.3), G_PEN, spacing, false);
    expect(pts[0].r).toBeLessThan(pts[Math.floor(pts.length / 2)].r * 0.3);
  });

  it('a flick ends in a needle; a careful stop ends blunt', () => {
    const flick = buildStroke(line(3, 0.4), G_PEN, spacing, true);
    const stop = buildStroke(line(0.05, 0.1), G_PEN, spacing, true);
    expect(flick[flick.length - 1].r).toBeLessThan(1e-6);
    expect(stop[stop.length - 1].r).toBeGreaterThan(midR(stop) * 0.9);
  });

  it('resamples smoothly between samples: no gap longer than the spacing', () => {
    const sparse: PenSample[] = [
      { x: 0.1, y: 0.5, t: 0, pressure: 0.6 },
      { x: 0.2, y: 0.4, t: 0.05, pressure: 0.6 },
      { x: 0.3, y: 0.5, t: 0.1, pressure: 0.6 },
    ];
    const pts = buildStroke(sparse, G_PEN, spacing, false);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)).toBeLessThanOrEqual(spacing * 1.2);
    }
  });

  it('mouse input (no pressure) still varies with speed', () => {
    const slow = buildStroke(line(0.2, 0.3, null), G_PEN, spacing, false);
    const fast = buildStroke(line(4, 0.3, null), G_PEN, spacing, false);
    expect(midR(fast)).toBeLessThan(midR(slow) * 0.6);
  });

  it('packs segments for the GPU; a tap is a dot', () => {
    const pts = buildStroke(line(0.5, 0.1), G_PEN, spacing, true);
    expect(strokeSegments(pts).length).toBe((pts.length - 1) * 6);
    const dot = strokeSegments(buildStroke([{ x: 0.5, y: 0.5, t: 0, pressure: 0.5 }], G_PEN, spacing, true));
    expect(dot.length).toBe(6);
    expect(dot[0]).toBe(dot[3]);
  });
});

describe('InkModel', () => {
  const draw = (m: InkModel, y: number) => {
    m.begin({ x: 0.1, y }, 0, 0.5, G_PEN);
    for (let i = 1; i <= 30; i++) m.add({ x: 0.1 + i * 0.01, y }, i / 120, 0.5);
    m.end();
  };

  it('keeps finished strokes, and undo / clear work', () => {
    const m = new InkModel();
    draw(m, 0.3);
    draw(m, 0.6);
    expect(m.strokes).toHaveLength(2);
    expect(m.current).toBeNull();
    m.clear();
    expect(m.strokes).toHaveLength(0);
    expect(m.undo()).toBe(true); // undo the clear
    expect(m.strokes).toHaveLength(2);
    expect(m.undo()).toBe(true);
    expect(m.strokes).toHaveLength(1);
  });

  it('a careful, slow stroke ends blunt even with a heavy stabilizer (the catch-up is no flick)', () => {
    const m = new InkModel();
    m.setStabilizer(1);
    m.begin({ x: 0.1, y: 0.5 }, 0, 0.6, G_PEN);
    for (let i = 1; i <= 240; i++) m.add({ x: 0.1 + i * 0.0002, y: 0.5 }, i / 240, 0.6); // 0.05 heights/s
    m.end();
    const pts = buildStroke(m.strokes[0].samples, G_PEN, 0.001, true);
    expect(pts[pts.length - 1].r).toBeGreaterThan(pts[Math.floor(pts.length / 2)].r * 0.8);
  });

  it('the finished line reaches where the pen left the paper', () => {
    const m = new InkModel();
    m.setStabilizer(1); // heavy smoothing: the filtered point trails the pen
    draw(m, 0.5);
    const s = m.strokes[0].samples;
    expect(s[s.length - 1].x).toBeCloseTo(0.4, 6);
  });
});
