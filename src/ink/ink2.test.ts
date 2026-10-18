import { describe, expect, it } from 'vitest';
import { buildStroke, G_PEN, MARU_PEN, PENS, scaledPen, WHITE_OUT, type PenSample } from './pen';
import { inkToSvg, strokePath } from './svg';
import { inkReplayAt, inkTimeline, inkTimelineLength } from './replay';
import type { InkStroke } from './ink';
import { sanitize } from '../settings';

const line = (x0: number, t0: number, speed = 0.5, pressure: number | null = 0.7): PenSample[] =>
  Array.from({ length: 49 }, (_, i) => ({ x: x0 + i * 0.005, y: 0.5, t: t0 + (i * 0.005) / speed, pressure }));

describe('pens', () => {
  it('Maru is finer and steadier than G: thinner, with a narrower width range', () => {
    const range = (pen: typeof G_PEN) => {
      const light = buildStroke(line(0.1, 0, 0.5, 0.15), pen, 0.002, false);
      const firm = buildStroke(line(0.1, 0, 0.5, 0.95), pen, 0.002, false);
      const mid = (p: { r: number }[]) => p[Math.floor(p.length / 2)].r;
      return { light: mid(light), firm: mid(firm) };
    };
    const g = range(G_PEN);
    const maru = range(MARU_PEN);
    expect(maru.firm).toBeLessThan(g.firm);
    expect(maru.firm / maru.light).toBeLessThan(g.firm / g.light);
  });

  it('white-out erases; pens are found by name; width scales', () => {
    expect(WHITE_OUT.erase).toBe(true);
    expect(G_PEN.erase).toBeFalsy();
    expect(PENS.maru).toBe(MARU_PEN);
    expect(scaledPen(G_PEN, 2).width).toBeCloseTo(G_PEN.width * 2, 12);
    expect(G_PEN.width).toBe(0.0045); // not mutated
  });

  it('ink settings are clamped from storage', () => {
    expect(sanitize({ inkWidth: 99, inkStabilizer: -1 })).toMatchObject({ inkWidth: 3, inkStabilizer: 0 });
  });
});

describe('ink SVG', () => {
  const stroke: InkStroke = { pen: G_PEN, samples: line(0.1, 0) };

  /** Signed area of each straight subpath (the tangent quads), y down: positive = clockwise on screen. */
  const quadAreas = (d: string) =>
    d
      .split('Z')
      .filter((s) => s.startsWith('M') && !s.includes('A'))
      .map((s) => {
        const pts = s.slice(1).split('L').map((p) => p.split(' ').map(Number));
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
          const [x0, y0] = pts[i];
          const [x1, y1] = pts[(i + 1) % pts.length];
          a += x0 * y1 - x1 * y0;
        }
        return a / 2;
      });

  it('draws segments as tangent quads, with round caps and joins, all wound the same way', () => {
    const d = strokePath(stroke, 0.004);
    const pts = buildStroke(stroke.samples, G_PEN, 0.004, true);
    const circles = (d.match(/A/g) ?? []).length / 2;
    expect(circles).toBeGreaterThanOrEqual(2); // round caps at both ends
    expect(circles).toBeLessThanOrEqual(pts.filter((p) => p.r > 0).length); // joins only where needed
    const areas = quadAreas(d);
    expect(areas.length).toBeGreaterThan(pts.length / 2);
    for (const a of areas) expect(a).toBeGreaterThanOrEqual(0); // nonzero fill = union
  });

  it('tangent quads touch both circles exactly', () => {
    const two: InkStroke = {
      pen: { ...G_PEN, entryTaper: 1e-9, exitTaper: 0 },
      samples: [
        { x: 0.2, y: 0.5, t: 0, pressure: 1 },
        { x: 0.3, y: 0.5, t: 1, pressure: 1 },
      ],
    };
    const pts = buildStroke(two.samples, two.pen, 1, true); // spacing 1: just the two ends
    const quad = strokePath(two, 1)
      .split('Z')
      .find((s) => s.startsWith('M') && !s.includes('A'))!;
    const corners = quad.slice(1).split('L').map((p) => p.split(' ').map(Number));
    for (const [x, y] of corners) {
      const da = Math.abs(Math.hypot(x - pts[0].x, y - pts[0].y) - pts[0].r);
      const db = Math.abs(Math.hypot(x - pts[1].x, y - pts[1].y) - pts[1].r);
      expect(Math.min(da, db)).toBeLessThan(2e-5);
    }
  });

  it('writes black ink and paper-colored white-out, in order', () => {
    const svg = inkToSvg(
      [stroke, { pen: WHITE_OUT, samples: line(0.2, 2) }],
      1.5,
      { x: 0, y: 0, w: 1, h: 1 },
      1500,
      1000,
      [1, 1, 1],
    );
    const fills = [...svg.matchAll(/<path fill="(#\w+)"/g)].map((m) => m[1]);
    expect(fills).toEqual(['#000000', '#ffffff']);
    expect(svg).toContain('viewBox="0 0 1.5 1"');
  });
});

describe('ink replay', () => {
  const a: InkStroke = { pen: G_PEN, samples: line(0.1, 0) }; // drawn over 0.48 s
  const b: InkStroke = { pen: G_PEN, samples: line(0.1, 10) }; // after a 9.5 s pause

  it('keeps each stroke’s own pace and shortens long pauses', () => {
    const tl = inkTimeline([a, b]);
    expect(tl[0]).toEqual({ start: 0, duration: expect.closeTo(0.48, 6) });
    expect(tl[1].start).toBeCloseTo(0.48 + 0.25, 6);
    expect(inkTimelineLength(tl)).toBeCloseTo(0.48 + 0.25 + 0.48, 6);
  });

  it('shows finished strokes plus the growing part of the current one', () => {
    const tl = inkTimeline([a, b]);
    const early = inkReplayAt([a, b], tl, 0.24);
    expect(early.done).toBe(0);
    expect(early.partial!.samples.length).toBeGreaterThan(10);
    expect(early.partial!.samples.length).toBeLessThan(a.samples.length);
    const pause = inkReplayAt([a, b], tl, 0.6);
    expect(pause).toEqual({ done: 1, partial: null });
    expect(inkReplayAt([a, b], tl, 99)).toEqual({ done: 2, partial: null });
  });
});
