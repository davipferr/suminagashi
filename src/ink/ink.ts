import type { Point } from '../input/stroke';
import { OneEuro2D } from './oneEuro';
import { buildStroke, strokeSegments, type PenParams, type PenSample } from './pen';

export interface InkStroke {
  readonly pen: PenParams;
  /** Stabilized samples; the finished line is rebuilt from these at any resolution (export). */
  readonly samples: PenSample[];
}

/** Stabilizer strength 0..1 -> 1-Euro parameters. 0 = raw input, 1 = very steady (slow lines glide). */
export function stabilizerParams(strength: number): { minCutoff: number; beta: number } {
  const s = Math.min(Math.max(strength, 0), 1);
  return { minCutoff: 12 * Math.pow(0.04, s), beta: 20 * Math.pow(0.3, s) };
}

/**
 * Line art: finished strokes plus the one being drawn. Pure data (no GPU), so it's unit-testable; InkLayer
 * draws it. Strokes are immutable once finished, so undo snapshots are just copies of the list.
 */
export class InkModel {
  strokes: readonly InkStroke[] = [];
  current: InkStroke | null = null;
  /** Bumped whenever `strokes` changes; `liveVersion` whenever the current stroke does. */
  version = 0;
  liveVersion = 0;

  private undoStack: (readonly InkStroke[])[] = [];
  private readonly filter = new OneEuro2D();
  /** The last few raw (unfiltered) pen positions, for the lift-off speed. */
  private raw: { p: Point; t: number }[] = [];

  constructor(private readonly history = 50) {}

  setStabilizer(strength: number): void {
    const { minCutoff, beta } = stabilizerParams(strength);
    this.filter.minCutoff = minCutoff;
    this.filter.beta = beta;
  }

  begin(p: Point, t: number, pressure: number | null, pen: PenParams): void {
    this.filter.reset();
    const f = this.filter.filter(p, t);
    this.current = { pen, samples: [{ ...f, t, pressure }] };
    this.raw = [{ p, t }];
    this.liveVersion++;
  }

  add(p: Point, t: number, pressure: number | null): void {
    if (!this.current) return;
    this.raw.push({ p, t });
    if (this.raw.length > 8) this.raw.shift();
    const f = this.filter.filter(p, t);
    const prev = this.current.samples[this.current.samples.length - 1];
    // Skip samples that don't move (the pen resting): they'd only add zero-length segments.
    if (Math.hypot(f.x - prev.x, f.y - prev.y) < 1e-5) {
      prev.pressure = pressure ?? prev.pressure;
      return;
    }
    this.current.samples.push({ ...f, t, pressure });
    this.liveVersion++;
  }

  /** Lifts the pen: the line catches up with where the pen actually left the paper, then it's kept. */
  end(): void {
    const s = this.current;
    if (!s) return;
    const raw = this.raw;
    const end = raw[raw.length - 1];
    const last = s.samples[s.samples.length - 1];
    const gap = end ? Math.hypot(end.p.x - last.x, end.p.y - last.y) : 0;
    if (end && gap > 1e-5) {
      // Close the stabilizer's lag. Time the catch-up at the pen's real recent speed: squeezing it into one
      // tick would look like a flick and taper even a careful stop to a needle.
      const first = raw[0];
      const travelled = raw.slice(1).reduce((d, r, i) => d + Math.hypot(r.p.x - raw[i].p.x, r.p.y - raw[i].p.y), 0);
      const speed = travelled / Math.max(end.t - first.t, 1 / 240);
      s.samples.push({ ...end.p, t: last.t + gap / Math.max(speed, 0.02), pressure: last.pressure });
    }
    this.checkpoint();
    this.strokes = [...this.strokes, s];
    this.current = null;
    this.version++;
    this.liveVersion++;
  }

  cancel(): void {
    this.current = null;
    this.liveVersion++;
  }

  private checkpoint(): void {
    this.undoStack.push(this.strokes);
    if (this.undoStack.length > this.history) this.undoStack.shift();
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.strokes = prev;
    this.version++;
    return true;
  }

  clear(): void {
    if (this.strokes.length === 0) return;
    this.checkpoint();
    this.strokes = [];
    this.version++;
  }
}

/**
 * GPU segment data for a stroke at a given sample spacing (canvas units). Finished strokes are cached:
 * they never change, and the spacing only changes on resize / export.
 */
const cache = new WeakMap<InkStroke, { spacing: number; segments: Float32Array }>();

export function segmentsFor(stroke: InkStroke, spacing: number, final: boolean): Float32Array {
  if (!final) return strokeSegments(buildStroke(stroke.samples, stroke.pen, spacing, false));
  const hit = cache.get(stroke);
  if (hit && hit.spacing === spacing) return hit.segments;
  const segments = strokeSegments(buildStroke(stroke.samples, stroke.pen, spacing, true));
  cache.set(stroke, { spacing, segments });
  return segments;
}
