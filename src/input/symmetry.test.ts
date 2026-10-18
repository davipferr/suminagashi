import { describe, expect, it } from 'vitest';
import { distinctCopies, symmetryCopies } from './symmetry';
import { Marbling } from '../marbling/marbling';
import { MarbleController } from '../marbling/controller';

const c = { x: 0.5, y: 0.5 };
const round = (p: { x: number; y: number }) => ({ x: +p.x.toFixed(9), y: +p.y.toFixed(9) });

describe('symmetryCopies', () => {
  it('off is just the original', () => {
    const copies = symmetryCopies('off', c);
    expect(copies).toHaveLength(1);
    expect(copies[0].point({ x: 0.2, y: 0.3 })).toEqual({ x: 0.2, y: 0.3 });
  });

  it('mirror reflects across the vertical center line, flipping horizontal motion', () => {
    const [id, m] = symmetryCopies('mirror', c);
    expect(id.point({ x: 0.2, y: 0.3 })).toEqual({ x: 0.2, y: 0.3 });
    expect(round(m.point({ x: 0.2, y: 0.3 }))).toEqual({ x: 0.8, y: 0.3 });
    expect(m.dir({ x: 1, y: 2 })).toEqual({ x: -1, y: 2 });
  });

  it('quad covers all four quadrants', () => {
    const pts = symmetryCopies('quad', c).map((t) => round(t.point({ x: 0.2, y: 0.3 })));
    expect(pts).toEqual([
      { x: 0.2, y: 0.3 },
      { x: 0.8, y: 0.3 },
      { x: 0.2, y: 0.7 },
      { x: 0.8, y: 0.7 },
    ]);
  });

  it('radial makes 6 copies on one circle, 60 degrees apart, with motion turning along', () => {
    const copies = symmetryCopies('radial', c);
    expect(copies).toHaveLength(6);
    const pts = copies.map((t) => t.point({ x: 0.8, y: 0.5 }));
    for (const p of pts) expect(Math.hypot(p.x - 0.5, p.y - 0.5)).toBeCloseTo(0.3, 12);
    expect(round(pts[1])).toEqual(round({ x: 0.5 + 0.3 * Math.cos(Math.PI / 3), y: 0.5 + 0.3 * Math.sin(Math.PI / 3) }));
    const v = copies[3].dir({ x: 1, y: 0 }); // half a turn
    expect(v.x).toBeCloseTo(-1, 12);
    expect(v.y).toBeCloseTo(0, 12);
  });
});

describe('marbling replay', () => {
  it('replaying the op log on an empty bath reproduces the picture exactly', () => {
    const live = new Marbling();
    live.aspect = 1.5;
    const colors: [number, number, number][] = [
      [0, 0, 0],
      [0.8, 0.1, 0.1],
      [0.1, 0.2, 0.7],
    ];
    let i = 0;
    const ctl = new MarbleController(live, () => colors[i++ % colors.length]);
    ctl.settings.symmetry = 'mirror';
    for (const x of [0.5, 0.5, 0.5, 0.9]) {
      ctl.down({ x, y: 0.5 });
      for (let f = 0; f < 10; f++) {
        live.clock += 1 / 60;
        ctl.update(1 / 60);
      }
      ctl.up();
      for (let f = 0; f < 30; f++) {
        live.clock += 1 / 60;
        ctl.update(1 / 60);
      }
    }
    ctl.tool = 'comb';
    ctl.down({ x: 0.1, y: 0.3 });
    for (let k = 1; k <= 8; k++) ctl.move({ x: 0.1 + k * 0.08, y: 0.3 + k * 0.03 });
    ctl.up();
    live.undo();
    ctl.tool = 'tine';
    ctl.down({ x: 0.75, y: 0.1 });
    ctl.move({ x: 0.75, y: 0.9 });
    ctl.up();

    const replayed = new Marbling();
    replayed.aspect = live.aspect;
    replayed.recording = false;
    for (const { op } of live.log) replayed.execute(op);

    expect(replayed.shapes.length).toBe(live.shapes.length);
    expect(replayed.shapes).toEqual(live.shapes);
    expect(replayed.log).toHaveLength(0);
  });

  it('snapshot / reset / restore round-trips, including undo history', () => {
    const m = new Marbling();
    m.checkpoint();
    m.drop({ x: 0.5, y: 0.5 }, 0.1, [0, 0, 0]);
    const snap = m.snapshot();
    m.reset();
    expect(m.shapes).toHaveLength(0);
    expect(m.undo()).toBe(false);
    m.restore(snap);
    expect(m.shapes).toHaveLength(1);
    expect(m.undo()).toBe(true);
    expect(m.shapes).toHaveLength(0);
  });
});

describe('distinctCopies', () => {
  it('drops copies that land on the same spot (a gesture at the center or on a mirror line)', () => {
    expect(distinctCopies(symmetryCopies('radial', c), c)).toHaveLength(1);
    expect(distinctCopies(symmetryCopies('mirror', c), { x: 0.5, y: 0.2 })).toHaveLength(1);
    expect(distinctCopies(symmetryCopies('quad', c), { x: 0.5, y: 0.2 })).toHaveLength(2);
    expect(distinctCopies(symmetryCopies('radial', c), { x: 0.7, y: 0.5 })).toHaveLength(6);
  });

  it('compares whole strokes: one crossing the mirror line is still a different stroke', () => {
    expect(distinctCopies(symmetryCopies('mirror', c), { x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 })).toHaveLength(2);
  });
});
