import type { Point } from './stroke';

export type Symmetry = 'off' | 'mirror' | 'quad' | 'radial';

export const SYMMETRIES: readonly { id: Symmetry; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'mirror', label: 'Mirror' },
  { id: 'quad', label: '4-way' },
  { id: 'radial', label: 'Radial' },
];

/** Copies made by radial symmetry. */
const RADIAL_COPIES = 6;

/** One symmetric copy: where a point goes, and how a direction (velocity, stroke) turns. */
export interface SymmetryCopy {
  point(p: Point): Point;
  dir(v: Point): Point;
}

type Matrix = readonly [number, number, number, number]; // [a b; c d]

/**
 * The copies that put `pts` somewhere new. A gesture on a mirror line or at the center maps onto itself,
 * and repeating it there would double it (six drops on one spot = six times the ink).
 */
export function distinctCopies(copies: readonly SymmetryCopy[], ...pts: Point[]): SymmetryCopy[] {
  const seen: Point[][] = [];
  return copies.filter((t) => {
    const mapped = pts.map((p) => t.point(p));
    const dup = seen.some((s) => s.every((q, i) => Math.hypot(q.x - mapped[i].x, q.y - mapped[i].y) < 1e-6));
    if (!dup) seen.push(mapped);
    return !dup;
  });
}

/**
 * The copies an input is repeated into, around `center`. Coordinates must be isotropic (same units on
 * both axes), so rotations stay circles: marbling units as they are, water UV with x scaled by the aspect.
 * The first copy is always the identity (the original input).
 */
export function symmetryCopies(mode: Symmetry, center: Point): SymmetryCopy[] {
  let matrices: Matrix[];
  switch (mode) {
    case 'off':
      matrices = [[1, 0, 0, 1]];
      break;
    case 'mirror':
      matrices = [
        [1, 0, 0, 1],
        [-1, 0, 0, 1],
      ];
      break;
    case 'quad':
      matrices = [
        [1, 0, 0, 1],
        [-1, 0, 0, 1],
        [1, 0, 0, -1],
        [-1, 0, 0, -1],
      ];
      break;
    case 'radial':
      matrices = Array.from({ length: RADIAL_COPIES }, (_, k) => {
        const a = (k / RADIAL_COPIES) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        return [c, -s, s, c] as const;
      });
      break;
  }
  return matrices.map(([a, b, c, d]) => ({
    point: (p) => {
      const x = p.x - center.x;
      const y = p.y - center.y;
      return { x: center.x + a * x + b * y, y: center.y + c * x + d * y };
    },
    dir: (v) => ({ x: a * v.x + b * v.y, y: c * v.x + d * v.y }),
  }));
}
