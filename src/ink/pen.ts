/**
 * The pen: how a stream of (stabilized) samples becomes a stroke of varying width.
 * Units: canvas heights (y down) and seconds, like the marbling.
 */

export interface PenSample {
  x: number;
  y: number;
  /** Seconds. */
  t: number;
  /** 0..1 from a pressure-sensitive pen; null for mouse and touch (width then follows speed only). */
  pressure: number | null;
}

export interface PenParams {
  /** Radius at full pressure and rest, canvas heights. */
  width: number;
  /** Thinnest line as a fraction of `width` (light pressure / fast flick). */
  minRatio: number;
  /** Pressure curve exponent: > 1 means light touches stay thin (a stiff, springy nib). */
  pressureGamma: number;
  /** Speed (canvas heights / s) at which speed alone halves the width. */
  speedHalf: number;
  /** Mouse/touch have no pressure: this stands in for it. */
  defaultPressure: number;
  /** Length over which a stroke swells in from a point (canvas heights). */
  entryTaper: number;
  /** Longest flick-out tail when the pen lifts while moving fast (canvas heights). */
  exitTaper: number;
  /** White-out: removes ink (back to paper) instead of adding it. */
  erase?: boolean;
}

/**
 * G-pen (Gペン): springy nib, big width range, strong pressure response, sharp tapered ends —
 * the classic manga inking pen for contours and hair.
 */
export const G_PEN: PenParams = {
  width: 0.0045,
  minRatio: 0.08,
  pressureGamma: 1.6,
  speedHalf: 1.6,
  defaultPressure: 0.75,
  entryTaper: 0.012,
  exitTaper: 0.05,
};

/**
 * Maru pen (丸ペン): a fine, stiff technical nib for detail, faces and backgrounds — narrow width range,
 * steady line, short tapers.
 */
export const MARU_PEN: PenParams = {
  width: 0.0022,
  minRatio: 0.35,
  pressureGamma: 1,
  speedHalf: 3.5,
  defaultPressure: 0.7,
  entryTaper: 0.006,
  exitTaper: 0.02,
};

/** White-out (修正液 / white ink): a broad, even brush that takes ink back off the paper. */
export const WHITE_OUT: PenParams = {
  width: 0.012,
  minRatio: 0.6,
  pressureGamma: 1,
  speedHalf: 8,
  defaultPressure: 0.85,
  entryTaper: 0.001,
  exitTaper: 0,
  erase: true,
};

export type PenName = 'g' | 'maru' | 'white';

export const PENS: Record<PenName, PenParams> = { g: G_PEN, maru: MARU_PEN, white: WHITE_OUT };

/** A pen with its width scaled (the Style panel's "Pen width"). */
export function scaledPen(pen: PenParams, widthScale: number): PenParams {
  return { ...pen, width: pen.width * widthScale };
}

/** A dense point along the finished stroke centre line, with its radius. */
export interface StrokePoint {
  x: number;
  y: number;
  r: number;
}

/** Ease 0 -> 1 (smoothstep). */
const ease = (u: number) => {
  const v = Math.min(Math.max(u, 0), 1);
  return v * v * (3 - 2 * v);
};

/** Uniform Catmull-Rom between p1 and p2 (p0, p3 are the neighbours), at u in [0, 1]. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/**
 * Turns pen samples into a dense, smooth centre line with a radius at every point:
 * - width from pressure (curve), thinned by speed — a quick stroke comes out lean even at mid pressure;
 * - radius is low-passed along the stroke, so pressure jitter doesn't make the edge wobble;
 * - Catmull-Rom between samples, resampled every `spacing`, so curves stay round between pen events;
 * - entry taper from the first point; exit taper (`final`) over a tail whose length grows with the speed
 *   at lift-off: a flick ends in a needle point, a careful stop ends blunt.
 */
export function buildStroke(samples: readonly PenSample[], pen: PenParams, spacing: number, final: boolean): StrokePoint[] {
  const n = samples.length;
  if (n === 0) return [];

  // Speed per sample (smoothed), then radius per sample. The first sample takes the first segment's speed:
  // assuming it starts at rest would put a fat blob at the start of every quick stroke.
  const speeds: number[] = [0];
  for (let i = 1; i < n; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = Math.max(b.t - a.t, 1 / 1000);
    speeds.push(Math.hypot(b.x - a.x, b.y - a.y) / dt);
  }
  if (n > 1) speeds[0] = speeds[1];
  for (let i = 1; i < n; i++) speeds[i] = speeds[i - 1] + 0.35 * (speeds[i] - speeds[i - 1]);
  const radii = samples.map((s, i) => {
    const p = s.pressure ?? pen.defaultPressure;
    const pressured = pen.minRatio + (1 - pen.minRatio) * Math.pow(Math.min(Math.max(p, 0), 1), pen.pressureGamma);
    const speedFactor = 1 / (1 + speeds[i] / pen.speedHalf);
    return pen.width * Math.max(pen.minRatio, pressured * speedFactor);
  });
  for (let i = 1; i < n; i++) radii[i] = radii[i - 1] + 0.5 * (radii[i] - radii[i - 1]);

  // Dense centre line.
  const pts: StrokePoint[] = [{ x: samples[0].x, y: samples[0].y, r: radii[0] }];
  for (let i = 0; i < n - 1; i++) {
    const p0 = samples[Math.max(i - 1, 0)];
    const p1 = samples[i];
    const p2 = samples[i + 1];
    const p3 = samples[Math.min(i + 2, n - 1)];
    // The curve is a bit longer than its chord; oversample a little so no piece exceeds `spacing`.
    const steps = Math.max(1, Math.ceil((1.25 * Math.hypot(p2.x - p1.x, p2.y - p1.y)) / spacing));
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      pts.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, u),
        y: catmullRom(p0.y, p1.y, p2.y, p3.y, u),
        r: radii[i] + (radii[i + 1] - radii[i]) * u,
      });
    }
  }

  // Tapers, by arc length from each end.
  const along = [0];
  for (let i = 1; i < pts.length; i++) {
    along.push(along[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = along[along.length - 1];
  // How much of a flick the lift-off was: 0 = the pen stopped (blunt, round end), 1 = fast (needle point).
  const flick = final ? Math.min(1, speeds[n - 1] / pen.speedHalf) : 0;
  const exit = pen.exitTaper * flick;
  for (let i = 0; i < pts.length; i++) {
    let k = 0.15 + 0.85 * ease(along[i] / pen.entryTaper);
    if (exit > 0) k *= 1 - flick * (1 - ease((total - along[i]) / exit));
    pts[i].r *= k;
  }
  return pts;
}

/** Floats per segment instance for the GPU: x0, y0, r0, x1, y1, r1. */
export const SEGMENT_FLOATS = 6;

/** Packs a stroke as segment instances (a single point becomes one zero-length segment: a dot). */
export function strokeSegments(pts: readonly StrokePoint[]): Float32Array {
  if (pts.length === 0) return new Float32Array(0);
  if (pts.length === 1) {
    const p = pts[0];
    return new Float32Array([p.x, p.y, p.r, p.x, p.y, p.r]);
  }
  const out = new Float32Array((pts.length - 1) * SEGMENT_FLOATS);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    out.set([a.x, a.y, a.r, b.x, b.y, b.r], i * SEGMENT_FLOATS);
  }
  return out;
}
