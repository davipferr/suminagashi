import { mulberry32 } from '../paper/random';
import { buildStroke, type BrushParams, type PenParams, type PenSample } from './pen';

/**
 * Calligraphy brushes: a tuft of ink-loaded bristles (or the slit edge of a reed or metal nib) dragged over
 * absorbent paper. Pure and deterministic (seeded per stroke), in canvas units, so a stroke comes out the same
 * live, in a replay and in a 4K export.
 *
 * - Bristles: each is a point on the brush footprint — spread across the stroke by pressure (round) or along a
 *   fixed-angle edge (chisel) — that follows its anchor through a damped spring, so soft hair trails behind and
 *   splays on curves. Each wanders a little across the stroke and leaves a thin track.
 * - Ink: each bristle carries its own load, drained by the distance it travels (more under pressure, less when
 *   it skims fast). A full brush lays solid black; a low or fast one breaks into dry streaks (飛白), which the
 *   shader catches only on the paper's raised tooth.
 * - Paper absorption: wet ink wicks out past the footprint by a distance that grows with the square root of
 *   contact time (Washburn's law): a quick stroke stays crisp, a lingering one feathers, a rest leaves a blot.
 *   The shader shapes that halo with the paper's absorbency, so it follows the sheet's pulp and fibers.
 */

/** Floats per bristle segment instance: x0, y0, r0, a0, x1, y1, r1, a1 (a = how much ink it lays, 0..1). */
export const BRISTLE_FLOATS = 8;
/** Floats per bleed segment instance: x0, y0, core0, reach0, x1, y1, core1, reach1 (canvas heights). */
export const BLEED_FLOATS = 8;

/** Bristles step this many render spacings at a time: their tracks are smooth, and there are dozens of them. */
const BRISTLE_STEP = 1.5;
/** Contact time (s) after which ink has wicked `bleed` footprint widths out. */
const BLEED_TIME = 0.25;
/** Longest contact that still matters (s): the paper under the brush is saturated by then. */
const MAX_CONTACT = 3;
/** Widest bleed, in footprint widths. */
const MAX_REACH = 0.8;
/**
 * Round brushes: the tuft's belly, a solid track this wide (fraction of the footprint radius) carrying the
 * bristles' average ink. Wet, it fills between the hairs (a pressed dot is a disc, not a ring of specks); dry, it
 * catches only the paper's tooth like they do.
 */
const BELLY = 0.7;
/** The belly lays a little less than the hairs, so their tracks stay visible on top of it. */
const BELLY_INK = 0.85;
/** Contact of a quick tap (s), before any resting time. */
const TAP_CONTACT = 0.05;
/** Bleed thinner than this (fraction of the pen width) isn't drawn. */
const MIN_REACH = 0.04;

/** What the simulation needs from a stroke. */
export interface BrushStroke {
  readonly pen: PenParams;
  readonly samples: readonly PenSample[];
  /** Seeds the bristles' layout and quirks. */
  readonly seed?: number;
  /** When the brush left the paper (s); time resting after the last sample soaks in as a blot. */
  readonly lift?: number;
}

export interface BrushMarks {
  bristles: Float32Array;
  bleed: Float32Array;
}

/** The chisel's edge direction (unit vector, y down): `angle` from the baseline, rising to the right. */
export function chiselEdge(b: BrushParams): { x: number; y: number } {
  return { x: Math.cos(b.angle), y: -Math.sin(b.angle) };
}

/** Half-length of a chisel edge at a given pressure factor (0..1): flexible nibs spread under pressure. */
export function chiselHalfLength(pen: PenParams, pf: number): number {
  const flex = pen.brush?.flex ?? 0;
  return pen.width * (1 - flex + flex * Math.min(Math.max(pf, 0), 1));
}

/** Radius of one chisel slice: the nib's thickness, but never so thin that slices leave gaps between them. */
export function chiselSliceRadius(b: BrushParams, halfLength: number): number {
  return halfLength * Math.max(b.thickness, 1.6 / b.bristles);
}

interface Bristle {
  /** Rest position across the footprint, -1..1. */
  v: number;
  /** Round: rest position along it (positive = behind the tip's travel), so the tuft prints a disc. */
  u: number;
  lag: number;
  cap: number;
  tone: number;
  f1: number;
  f2: number;
  p1: number;
  p2: number;
  /** Seeds this hair's skipping: where a dry hair lifts off the paper along the stroke. */
  skipSeed: number;
  load: number;
  x: number;
  y: number;
  r: number;
  a: number;
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Smooth 1D value noise in [0, 1]. */
function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (k: number) => {
    const s = Math.sin(k * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}

/** Simulates a brush stroke into bristle tracks and a bleed halo, ready for the GPU. */
export function simulateBrush(stroke: BrushStroke, spacing: number, final: boolean): BrushMarks {
  const pen = stroke.pen;
  const b = pen.brush;
  const pts = buildStroke(stroke.samples, pen, spacing * BRISTLE_STEP, final);
  if (!b || pts.length === 0) return { bristles: new Float32Array(0), bleed: new Float32Array(0) };

  const rand = mulberry32(stroke.seed ?? 1);
  const n = b.bristles;
  const gap = 2 / n;
  const round = b.shape === 'round';
  const edge = chiselEdge(b);
  const bristles: Bristle[] = [];
  for (let k = 0; k < n; k++) {
    const v = Math.min(Math.max(-1 + (k + 0.5) * gap + (rand() - 0.5) * 0.6 * gap, -1), 1);
    bristles.push({
      v,
      // Behind more than ahead: a pressed fude is a teardrop whose tip trails.
      u: (rand() * 1.6 - 0.6) * Math.sqrt(1 - v * v),
      lag: b.lag * (0.6 + 0.8 * rand()),
      // Outer hairs of a round brush hold less ink: the edges dry first.
      cap: b.capacity * (0.8 + 0.4 * rand()) * (round ? 1 - 0.35 * v * v : 1),
      // Hairs differ in how much pigment they hold; a nib's edge is one piece of metal or reed.
      tone: round ? 0.82 + 0.18 * rand() : 0.95 + 0.05 * rand(),
      f1: (2 * Math.PI) / (pen.width * (4 + 6 * rand())),
      f2: (2 * Math.PI) / (pen.width * (1.5 + 2 * rand())),
      p1: rand() * 2 * Math.PI,
      p2: rand() * 2 * Math.PI,
      skipSeed: rand() * 1000,
      load: 1,
      x: 0,
      y: 0,
      r: 0,
      a: 0,
    });
  }

  // Initial heading: towards the first point that's somewhere else.
  let dx = 1;
  let dy = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (len > 1e-9) {
      dx = (pts[i].x - pts[0].x) / len;
      dy = (pts[i].y - pts[0].y) / len;
      break;
    }
  }

  /** Where bristle `br` sits on the footprint centred at point i, and its radius. */
  const place = (br: Bristle, i: number, along: number, out: { x: number; y: number; r: number }) => {
    const p = pts[i];
    const wobble = b.wander * gap * (0.6 * Math.sin(along * br.f1 + br.p1) + 0.4 * Math.sin(along * br.f2 + br.p2));
    const v = Math.min(Math.max(br.v + wobble, -1), 1);
    if (round) {
      const rb = (p.r * 1.7) / n;
      const across = v * (p.r - rb * 0.5);
      const behind = br.u * p.r * 0.8;
      out.x = p.x - dy * across - dx * behind;
      out.y = p.y + dx * across - dy * behind;
      out.r = rb;
    } else {
      const half = chiselHalfLength(pen, p.r / pen.width);
      out.x = p.x + edge.x * v * half;
      out.y = p.y + edge.y * v * half;
      out.r = chiselSliceRadius(b, half);
    }
  };

  /**
   * Ink a bristle lays, from its load and the brush speed (a quick stroke skims and leaves less). A hair
   * short of ink skips: it lifts off the paper in stretches along the stroke, which is what draws the long
   * white streaks of dry brush (飛白) — the shader then frays what's left on the paper's tooth.
   */
  const inkOf = (br: Bristle, transfer: number, along: number) => {
    if (br.load <= 0) return 0;
    // Even a flick at full load leaves some ink: the floor keeps it to broken streaks, never nothing.
    const ink = clamp01(br.load * 1.6 * (0.3 + 0.7 * transfer));
    const skip = noise1(br.skipSeed + along / (pen.width * 1.2)) * 0.7 + noise1(br.skipSeed * 1.7 + along / (pen.width * 0.35)) * 0.3;
    return ink * smoothstep(skip - 0.08, skip + 0.08, ink * 1.4 - 0.4) * br.tone;
  };
  /** Dry hairs separate and narrow. */
  const widthOf = (br: Bristle, r: number) => r * (0.45 + 0.55 * clamp01(br.load * 1.5));

  const transferAt = (i: number) => 1 / (1 + (pts[i].v ?? 0) / b.dryBrushSpeed);
  const anchor = { x: 0, y: 0, r: 0 };
  for (const br of bristles) {
    place(br, 0, 0, anchor);
    br.x = anchor.x;
    br.y = anchor.y;
    br.r = widthOf(br, anchor.r);
    br.a = inkOf(br, transferAt(0), 0);
  }

  const out = new Float32Array(Math.max(pts.length - 1, 1) * (n + 1) * BRISTLE_FLOATS);
  let count = 0;
  const emit = (x0: number, y0: number, r0: number, a0: number, x1: number, y1: number, r1: number, a1: number) => {
    out.set([x0, y0, r0, a0, x1, y1, r1, a1], count * BRISTLE_FLOATS);
    count++;
  };

  // A round tuft bleeds from its (round) footprint; a nib from each slice of its edge, so the halo keeps the
  // nib's slanted ends instead of growing round caps.
  const bleed = new Float32Array(Math.max(pts.length - 1, 1) * (round ? 1 : n) * BLEED_FLOATS);
  const pushBleed = (x0: number, y0: number, c0: number, r0: number, x1: number, y1: number, c1: number, r1: number) => {
    bleed.set([x0, y0, c0, r0, x1, y1, c1, r1], bleedCount * BLEED_FLOATS);
    bleedCount++;
  };
  const before = new Float32Array(n * 3);
  let bleedCount = 0;
  const footprint = 2 * pen.width;
  const wetMean = () => bristles.reduce((s, br) => s + clamp01(br.load), 0) / n;
  /** Half-width of the mark across the direction of travel (dirX, dirY) at point i. */
  const coreAt = (i: number, dirX: number, dirY: number) => {
    const p = pts[i];
    if (round) return p.r;
    const half = chiselHalfLength(pen, p.r / pen.width);
    return half * Math.abs(dirX * edge.y - dirY * edge.x) + chiselSliceRadius(b, half);
  };
  const reachFor = (contact: number, wet: number) =>
    Math.min(b.bleed * footprint * Math.sqrt((wet * Math.min(contact, MAX_CONTACT)) / BLEED_TIME), MAX_REACH * footprint);
  const contactAt = (i: number, core: number) => (2 * core) / Math.max(pts[i].v ?? 0, 1e-3);

  // Squared: as the hairs dry and separate, the belly between them empties first.
  const bellyInk = () => (bristles.reduce((s, br) => s + br.a, 0) / n) ** 2 * BELLY_INK;
  let bellyR = pts[0].r * BELLY;
  let bellyA = bellyInk();

  let core = coreAt(0, dx, dy);
  let reach = reachFor(contactAt(0, core), 1);
  let along = 0;

  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[i - 1];
    const ds = Math.hypot(p.x - q.x, p.y - q.y);
    along += ds;
    let segX = dx;
    let segY = dy;
    if (ds > 1e-9) {
      segX = (p.x - q.x) / ds;
      segY = (p.y - q.y) / ds;
      // The tuft turns to follow the stroke a little late: soft hair swings round on curves.
      const turn = round ? 1 - Math.exp(-ds / (0.5 * b.lag * Math.max(p.r, 1e-5) + 1e-9)) : 1;
      let nx = dx + (segX - dx) * turn;
      let ny = dy + (segY - dy) * turn;
      const len = Math.hypot(nx, ny);
      if (len < 1e-6) {
        nx = segX;
        ny = segY;
      } else {
        nx /= len;
        ny /= len;
      }
      dx = nx;
      dy = ny;
    }

    const transfer = transferAt(i);
    const pf = clamp01(p.r / pen.width);
    for (let k = 0; k < n; k++) {
      const br = bristles[k];
      place(br, i, along, anchor);
      const x0 = br.x;
      const y0 = br.y;
      before[k * 3] = x0;
      before[k * 3 + 1] = y0;
      before[k * 3 + 2] = br.r;
      if (br.lag > 0) {
        // Each hair's tip follows its root on the brush through a damped spring.
        const follow = 1 - Math.exp(-ds / (br.lag * Math.max(p.r, 1e-5) + 1e-9));
        br.x += (anchor.x - br.x) * follow;
        br.y += (anchor.y - br.y) * follow;
      } else {
        br.x = anchor.x;
        br.y = anchor.y;
      }
      const travel = Math.hypot(br.x - x0, br.y - y0);
      const contact = round ? 1 - 0.5 * (1 - pf) * br.v * br.v : 1;
      br.load = Math.max(0, br.load - (travel * contact * (0.5 + 0.5 * pf) * (0.4 + 0.6 * transfer)) / br.cap);
      const r1 = widthOf(br, anchor.r);
      const a1 = inkOf(br, transfer, along);
      if (br.a > 0 || a1 > 0) emit(x0, y0, br.r, br.a, br.x, br.y, r1, a1);
      br.r = r1;
      br.a = a1;
    }
    if (round) {
      const r1 = p.r * BELLY;
      const a1 = bellyInk();
      if (bellyA > 0 || a1 > 0) emit(q.x, q.y, bellyR, bellyA, p.x, p.y, r1, a1);
      bellyR = r1;
      bellyA = a1;
    }

    const wet = wetMean();
    const core1 = coreAt(i, segX, segY);
    let reach1 = reach + (reachFor(contactAt(i, core1), wet) - reach) * (1 - Math.exp(-ds / pen.width));
    if (i === pts.length - 1) {
      // Resting before the lift soaks in where the brush stopped.
      const rest = Math.max((stroke.lift ?? p.t ?? 0) - (p.t ?? 0), 0);
      reach1 = Math.max(reach1, reachFor(contactAt(i, core1) + rest, wet));
    }
    if (Math.max(reach, reach1) > MIN_REACH * pen.width) {
      if (round) pushBleed(q.x, q.y, core, reach, p.x, p.y, core1, reach1);
      else {
        for (let k = 0; k < n; k++) {
          const br = bristles[k];
          pushBleed(before[k * 3], before[k * 3 + 1], before[k * 3 + 2], reach, br.x, br.y, br.r, reach1);
        }
      }
    }
    core = core1;
    reach = reach1;
  }

  if (pts.length === 1) {
    // A touch: every bristle prints a dot, and the ink soaks in for as long as the brush rested.
    for (const br of bristles) if (br.a > 0) emit(br.x, br.y, br.r, br.a, br.x, br.y, br.r, br.a);
    const p = pts[0];
    if (round && bellyA > 0) emit(p.x, p.y, bellyR, bellyA, p.x, p.y, bellyR, bellyA);
    const rest = Math.max((stroke.lift ?? p.t ?? 0) - (p.t ?? 0), 0);
    const r = reachFor(TAP_CONTACT + rest, 1);
    if (r > MIN_REACH * pen.width) {
      if (round) pushBleed(p.x, p.y, core, r, p.x, p.y, core, r);
      else for (const br of bristles) pushBleed(br.x, br.y, br.r, r, br.x, br.y, br.r, r);
    }
  }

  return { bristles: out.subarray(0, count * BRISTLE_FLOATS), bleed: bleed.subarray(0, bleedCount * BLEED_FLOATS) };
}
