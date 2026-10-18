import { describe, expect, it } from 'vitest';
import { BLEED_FLOATS, BRISTLE_FLOATS, simulateBrush, type BrushStroke } from './brush';
import { BROAD_EDGE, G_PEN, PENS, QALAM, SUMI_BRUSH, tunedPen, type PenParams, type PenSample } from './pen';
import { InkModel, type InkStroke } from './ink';
import { inkReplayAt, inkTimeline } from './replay';
import { chiselPath, inkToSvg } from './svg';
import { sanitize } from '../settings';

const SPACING = 0.002;

/** A straight stroke from (x0, y0) along (dx, dy), `length` long, at constant speed and pressure. */
function line(
  { x0 = 0.2, y0 = 0.5, dx = 1, dy = 0, length = 0.4, speed = 0.4, pressure = 0.8 as number | null } = {},
): PenSample[] {
  const n = Math.max(2, Math.round(length / 0.005));
  return Array.from({ length: n + 1 }, (_, i) => {
    const s = (i / n) * length;
    return { x: x0 + dx * s, y: y0 + dy * s, t: s / speed, pressure };
  });
}

const stroke = (pen: PenParams, samples: PenSample[], extra: Partial<BrushStroke> = {}): BrushStroke => ({
  pen,
  samples,
  seed: 42,
  ...extra,
});

/** Per bristle segment: [x0, y0, r0, a0, x1, y1, r1, a1]. */
const segments = (data: Float32Array) =>
  Array.from({ length: data.length / BRISTLE_FLOATS }, (_, i) => Array.from(data.subarray(i * 8, i * 8 + 8)));

/** Average ink laid by the bristle segments whose end lies in [from, to) along x. */
const inkBetween = (data: Float32Array, from: number, to: number) => {
  const inside = segments(data).filter((s) => s[4] >= from && s[4] < to);
  return inside.reduce((sum, s) => sum + s[7], 0) / Math.max(inside.length, 1);
};

/** Spread of the bristle tracks across a stroke: max - min of the coordinate perpendicular to travel. */
const spread = (data: Float32Array, axis: 0 | 1) => {
  const segs = segments(data);
  const mid = segs.slice(Math.floor(segs.length * 0.4), Math.floor(segs.length * 0.6));
  const vals = mid.map((s) => s[4 + axis]);
  return Math.max(...vals) - Math.min(...vals);
};

/** Largest bleed reach in the stroke's last few bleed segments, and overall. */
const reaches = (data: Float32Array) => {
  const r: number[] = [];
  for (let i = 0; i < data.length / BLEED_FLOATS; i++) r.push(data[i * 8 + 3], data[i * 8 + 7]);
  return { last: r.length ? Math.max(...r.slice(-4)) : 0, max: r.length ? Math.max(...r) : 0 };
};

describe('brush simulation', () => {
  it('is deterministic for a seed, and the seed changes the hairs', () => {
    const a = simulateBrush(stroke(SUMI_BRUSH, line()), SPACING, true);
    const b = simulateBrush(stroke(SUMI_BRUSH, line()), SPACING, true);
    const c = simulateBrush(stroke(SUMI_BRUSH, line(), { seed: 7 }), SPACING, true);
    expect(Array.from(a.bristles)).toEqual(Array.from(b.bristles));
    expect(Array.from(a.bristles)).not.toEqual(Array.from(c.bristles));
  });

  it('a round brush swells with pressure', () => {
    const light = simulateBrush(stroke(SUMI_BRUSH, line({ pressure: 0.2 })), SPACING, false);
    const firm = simulateBrush(stroke(SUMI_BRUSH, line({ pressure: 0.95 })), SPACING, false);
    expect(spread(firm.bristles, 1)).toBeGreaterThan(spread(light.bristles, 1) * 2);
  });

  it('a chisel nib is broad or thin by direction: qalam horizontals are broad, broad-edge verticals are', () => {
    const across = (pen: PenParams, dir: 'h' | 'v') => {
      const samples = dir === 'h' ? line() : line({ x0: 0.5, y0: 0.2, dx: 0, dy: 1 });
      return spread(simulateBrush(stroke(pen, samples), SPACING, false).bristles, dir === 'h' ? 1 : 0);
    };
    expect(across(QALAM, 'h')).toBeGreaterThan(across(QALAM, 'v') * 2);
    expect(across(BROAD_EDGE, 'v')).toBeGreaterThan(across(BROAD_EDGE, 'h'));
  });

  it('runs dry along a long stroke, and sooner with less ink', () => {
    const long = line({ x0: 0.1, length: 1.6, speed: 0.8 });
    const full = simulateBrush(stroke(SUMI_BRUSH, long), SPACING, false).bristles;
    expect(inkBetween(full, 1.5, 1.7)).toBeLessThan(inkBetween(full, 0.1, 0.3));
    const low = simulateBrush(stroke(tunedPen(SUMI_BRUSH, { ink: 0.3, bleed: 1, angle: 0 }), long), SPACING, false).bristles;
    expect(inkBetween(low, 1.5, 1.7)).toBeLessThan(inkBetween(full, 1.5, 1.7));
  });

  it('a fast stroke skims: less ink than a slow one (飛白)', () => {
    const slow = simulateBrush(stroke(SUMI_BRUSH, line({ speed: 0.2 })), SPACING, false).bristles;
    const fast = simulateBrush(stroke(SUMI_BRUSH, line({ speed: 4 })), SPACING, false).bristles;
    expect(inkBetween(fast, 0.3, 0.6)).toBeLessThan(inkBetween(slow, 0.3, 0.6) * 0.8);
  });

  it('bleeds more where it lingers: slow strokes feather, a rest before lifting leaves a blot', () => {
    const slow = reaches(simulateBrush(stroke(SUMI_BRUSH, line({ speed: 0.1 })), SPACING, true).bleed);
    const fast = reaches(simulateBrush(stroke(SUMI_BRUSH, line({ speed: 3 })), SPACING, true).bleed);
    expect(slow.max).toBeGreaterThan(fast.max);

    const samples = line();
    const end = samples[samples.length - 1].t;
    const lifted = reaches(simulateBrush(stroke(SUMI_BRUSH, samples, { lift: end }), SPACING, true).bleed);
    const rested = reaches(simulateBrush(stroke(SUMI_BRUSH, samples, { lift: end + 1.5 }), SPACING, true).bleed);
    expect(rested.last).toBeGreaterThan(lifted.last * 1.5);
  });

  it('a nib barely bleeds compared with the sumi brush', () => {
    const slow = line({ speed: 0.15 });
    const sumi = reaches(simulateBrush(stroke(SUMI_BRUSH, slow), SPACING, true).bleed).max;
    const nib = reaches(simulateBrush(stroke(BROAD_EDGE, slow), SPACING, true).bleed).max;
    expect(nib).toBeLessThan(sumi * 0.3);
  });

  it('a tap prints a dot (every hair plus the belly), and soaks in while it rests', () => {
    const tap = [{ x: 0.5, y: 0.5, t: 0, pressure: 0.9 }];
    const quick = simulateBrush(stroke(SUMI_BRUSH, tap, { lift: 0 }), SPACING, true);
    const held = simulateBrush(stroke(SUMI_BRUSH, tap, { lift: 1 }), SPACING, true);
    expect(quick.bristles.length / BRISTLE_FLOATS).toBe(SUMI_BRUSH.brush!.bristles + 1);
    expect(reaches(held.bleed).max).toBeGreaterThan(reaches(quick.bleed).max);
  });

  it('plain pens have no brush marks', () => {
    const marks = simulateBrush(stroke(G_PEN, line()), SPACING, true);
    expect(marks.bristles.length + marks.bleed.length).toBe(0);
  });
});

describe('brush pens and model', () => {
  it('presets are found by name; tuning scales ink and bleed and turns only nibs', () => {
    expect(PENS.sumi).toBe(SUMI_BRUSH);
    expect(PENS.qalam).toBe(QALAM);
    expect(PENS.broad).toBe(BROAD_EDGE);
    const t = { ink: 2, bleed: 0.5, angle: 10 };
    const q = tunedPen(QALAM, t).brush!;
    expect(q.capacity).toBeCloseTo(QALAM.brush!.capacity * 2, 12);
    expect(q.bleed).toBeCloseTo(QALAM.brush!.bleed * 0.5, 12);
    expect(q.angle).toBeCloseTo(QALAM.brush!.angle + Math.PI / 18, 12);
    expect(tunedPen(SUMI_BRUSH, t).brush!.angle).toBe(SUMI_BRUSH.brush!.angle);
    expect(tunedPen(G_PEN, t)).toBe(G_PEN);
  });

  it('a brush stroke gets a seed and its lift time; holding still keeps it changing', () => {
    const m = new InkModel();
    m.begin({ x: 0.1, y: 0.5 }, 0, 0.7, SUMI_BRUSH);
    for (let i = 1; i <= 20; i++) m.add({ x: 0.1 + i * 0.01, y: 0.5 }, i / 60, 0.7);
    const before = m.liveVersion;
    m.hold(1);
    expect(m.liveVersion).toBe(before + 1);
    expect(m.current!.lift).toBe(1);
    m.end(1.5);
    const s = m.strokes[0];
    expect(typeof s.seed).toBe('number');
    expect(s.lift).toBe(1.5);

    // Pens don't carry brush state.
    m.begin({ x: 0.1, y: 0.6 }, 2, 0.7, G_PEN);
    const v = m.liveVersion;
    m.hold(3);
    expect(m.liveVersion).toBe(v);
    m.end(3);
    expect(m.strokes[1].seed).toBeUndefined();
  });

  it('replay keeps the seed, runs the soak clock, and gives a rest its time', () => {
    const samples = line({ length: 0.2 });
    const end = samples[samples.length - 1].t;
    const s: InkStroke = { pen: SUMI_BRUSH, samples, seed: 9, lift: end + 1 };
    const timeline = inkTimeline([s]);
    expect(timeline[0].duration).toBeCloseTo(end + 1, 9);
    const mid = inkReplayAt([s], timeline, end + 0.5).partial!;
    expect(mid.seed).toBe(9);
    expect(mid.lift).toBeCloseTo(end + 0.5, 9);
  });

  it('brush settings are clamped from storage', () => {
    expect(sanitize({ brushInk: 99, brushBleed: -1, nibAngle: 200 })).toMatchObject({ brushInk: 2.5, brushBleed: 0, nibAngle: 45 });
  });
});

describe('chisel SVG', () => {
  const areas = (d: string) =>
    d
      .split('Z')
      .filter((p) => p.startsWith('M'))
      .map((p) => {
        const pts = p.slice(1).split('L').map((q) => q.split(' ').map(Number));
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
          const [x0, y0] = pts[i];
          const [x1, y1] = pts[(i + 1) % pts.length];
          a += x0 * y1 - x1 * y0;
        }
        return a / 2;
      });

  it('outlines the swept nib as hulls all wound clockwise, so they union', () => {
    const d = chiselPath({ pen: QALAM, samples: line() }, 0.004);
    const a = areas(d);
    expect(a.length).toBeGreaterThan(10);
    for (const v of a) expect(v).toBeGreaterThan(0);
  });

  it('a stroke along the edge still has its hairline thickness', () => {
    const e = { x: Math.cos(QALAM.brush!.angle), y: -Math.sin(QALAM.brush!.angle) };
    const d = chiselPath({ pen: QALAM, samples: line({ dx: e.x, dy: e.y, length: 0.2 }) }, 0.004);
    expect(areas(d).reduce((s, v) => s + v, 0)).toBeGreaterThan(0);
  });

  it('the ink SVG uses the chisel outline for nibs and the round one for the sumi brush', () => {
    const region = { x: 0, y: 0, w: 1, h: 1 };
    const svg = inkToSvg([{ pen: QALAM, samples: line() }, { pen: SUMI_BRUSH, samples: line({ y0: 0.7 }) }], 1, region, 100, 100, [1, 1, 1]);
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('A'); // the sumi stroke's round caps
  });
});
