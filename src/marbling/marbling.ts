import type { Point } from '../input/stroke';
import type { RGB } from '../color';
import { bounds, circle, composeWarps, dropWarp, strokeWarp, warpPolygon, type Coords, type Warp } from './geometry';

export interface Shape {
  /** sRGB 0..1 */
  color: RGB;
  /** Closed polygon in canvas-height units, y down, as flat [x0, y0, x1, y1, ...]. */
  pts: Coords;
}

/** A stylus path for one frame of a stroke. */
export interface Segment {
  a: Point;
  b: Point;
}

/**
 * Every change to the bath, as data: enough to rebuild the picture from blank (replay).
 * Drops, growth and strokes carry all their symmetric copies, applied together as one warp.
 */
export type MarbleOp =
  | { op: 'drop'; cs: readonly Point[]; r: number; color: RGB }
  | { op: 'grow'; cs: readonly Point[]; dr2: number }
  | { op: 'stroke'; segs: readonly Segment[]; offsets: readonly number[]; lambda: number }
  | { op: 'checkpoint' }
  | { op: 'undo' }
  | { op: 'clear' };

/** An op and when it happened, in seconds of marbling time (see `clock`). */
export interface LoggedOp {
  t: number;
  op: MarbleOp;
}

/**
 * Where ink goes once the polygons get too detailed (see RasterBath). Optional: without one, the point
 * budget alone keeps things bounded, at the cost of detail. Saved states are opaque and reference-counted.
 */
export interface RasterBackend {
  readonly active: boolean;
  /** Folds these shapes (and any existing raster ink) into a new base image; the caller then drops them. */
  flatten(shapes: readonly Shape[]): void;
  /** Moves the raster ink by an op's warp. */
  warp(op: MarbleOp): void;
  /** A saved state holding one reference (null when inactive). */
  save(): unknown;
  /** Makes a saved state current (null = no raster ink). Doesn't consume the reference. */
  load(state: unknown): void;
  retain(state: unknown): void;
  release(state: unknown): void;
  /** No raster ink any more. */
  clear(): void;
}

interface UndoEntry {
  shapes: Shape[];
  raster: unknown;
}

export interface MarbleSnapshot {
  shapes: Shape[];
  undoStack: UndoEntry[];
  raster: unknown;
  coarseness: number;
}

export interface MarblingSettings {
  /** Chord error allowed when following warped curves, canvas heights (~0.3 px on a 1000 px canvas). */
  tol: number;
  /** Longest polygon edge, canvas heights (keeps growing drops round). */
  maxLen: number;
  /** Shortest edge worth splitting, canvas heights (~1 px; stops runaway splitting at comb cusps). */
  minLen: number;
  /** Off-screen edges may be this many times coarser. */
  offscreenScale: number;
  /**
   * Soft cap on the total points. Combing multiplies edge length with every pass; past the budget the
   * tolerance is loosened step by step (and tightened again once there's room), so detail degrades
   * gracefully instead of the page freezing.
   */
  pointBudget: number;
  /**
   * Hard cap: no warp may take the total past it; existing points still move, but no more are added.
   * Reached only after many combing passes, when new detail would be finer than a pixel anyway.
   * Bounds the cost of every frame (~0.5 us per point per warp).
   */
  pointCap: number;
  /** Shapes pushed entirely further than this outside the view are forgotten. */
  cullMargin: number;
  /** Undo depth. */
  history: number;
}

export const DEFAULT_MARBLING: MarblingSettings = {
  tol: 0.0003,
  maxLen: 0.012,
  minLen: 0.0012,
  offscreenScale: 8,
  pointBudget: 40_000,
  pointCap: 70_000,
  cullMargin: 0.5,
  history: 30,
};

/** Loosest the budget may push the tolerance (8 x 0.3 px ~ 2.5 px). */
const MAX_COARSENESS = 8;
/** Undo depth while raster ink exists: each step keeps a copy of the coordinate map (a few MB). */
const RASTER_HISTORY = 6;

/**
 * The marbling bath: an ordered stack of ink shapes (later shapes on top) and the operations that
 * deform them. Every operation is a warp applied to all vertices of all shapes.
 */
export class Marbling {
  readonly settings: MarblingSettings;
  shapes: Shape[] = [];
  /** Bumped on every change; the renderer redraws when it differs from what it last drew. */
  version = 0;
  /** View width in canvas-height units (= canvas aspect), used for culling. */
  aspect = 1;

  /** Everything done since the page opened, for replay. */
  readonly log: LoggedOp[] = [];
  /** Seconds of marbling time; advanced by the app while marble mode runs. Stamps logged ops. */
  clock = 0;
  /** Off while replaying, so replayed ops aren't logged again. */
  recording = true;

  /** Takes over the ink once the polygons pass the point cap. Set by the app; absent in tests. */
  raster: RasterBackend | null = null;

  private undoStack: UndoEntry[] = [];
  /** Tolerance multiplier driven by the point budget (1 = full detail). Part of the state, so replay matches. */
  private coarseness = 1;

  constructor(settings: Partial<MarblingSettings> = {}) {
    this.settings = { ...DEFAULT_MARBLING, ...settings };
  }

  get pointCount(): number {
    return this.shapes.reduce((n, s) => n + (s.pts.length >> 1), 0);
  }

  private record(op: MarbleOp): void {
    if (this.recording) this.log.push({ t: this.clock, op });
  }

  /** Runs a logged op (replay). */
  execute(op: MarbleOp): void {
    switch (op.op) {
      case 'drop':
        return this.drop(op.cs, op.r, op.color);
      case 'grow':
        return this.grow(op.cs, op.dr2);
      case 'stroke':
        return this.stroke(op.segs, op.offsets, op.lambda);
      case 'checkpoint':
        return this.checkpoint();
      case 'undo':
        this.undo();
        return;
      case 'clear':
        return this.clear();
    }
  }

  /** Whether part of the picture is raster ink (then it can't be exported as SVG). */
  get rasterized(): boolean {
    return this.raster?.active ?? false;
  }

  /** The full state, for replay. Holds references to raster states: pass it to restore() exactly once. */
  snapshot(): MarbleSnapshot {
    for (const e of this.undoStack) this.raster?.retain(e.raster);
    return {
      shapes: this.shapes,
      undoStack: [...this.undoStack],
      raster: this.raster?.save() ?? null,
      coarseness: this.coarseness,
    };
  }

  restore(s: MarbleSnapshot): void {
    this.dropHistory();
    this.shapes = s.shapes;
    this.undoStack = [...s.undoStack];
    this.raster?.load(s.raster);
    this.raster?.release(s.raster);
    this.coarseness = s.coarseness;
    this.version++;
  }

  /** Empties the bath and its history (the starting point of a replay). Not undoable, not logged. */
  reset(): void {
    this.dropHistory();
    this.shapes = [];
    this.raster?.clear();
    this.coarseness = 1;
    this.version++;
  }

  private dropHistory(): void {
    for (const e of this.undoStack) this.raster?.release(e.raster);
    this.undoStack = [];
  }

  /** Saves the current state so the next gesture can be undone as one step. */
  checkpoint(): void {
    this.record({ op: 'checkpoint' });
    // Points are never mutated in place (warps make new arrays), so copying the list is enough.
    this.undoStack.push({
      shapes: this.shapes.map((s) => ({ color: s.color, pts: s.pts })),
      raster: this.rasterized ? this.raster!.save() : null,
    });
    const limit = this.rasterized ? Math.min(RASTER_HISTORY, this.settings.history) : this.settings.history;
    while (this.undoStack.length > limit) this.raster?.release(this.undoStack.shift()!.raster);
  }

  undo(): boolean {
    this.record({ op: 'undo' });
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.shapes = prev.shapes;
    this.raster?.load(prev.raster);
    this.raster?.release(prev.raster);
    this.version++;
    return true;
  }

  clear(): void {
    if (this.shapes.length === 0 && !this.rasterized) return;
    this.record({ op: 'clear' });
    // The checkpoint inside is replayed by the 'clear' op itself, so don't log it separately.
    const recording = this.recording;
    this.recording = false;
    this.checkpoint();
    this.recording = recording;
    this.shapes = [];
    this.raster?.clear();
    this.version++;
  }

  /**
   * Point budget and cap for an op applied as `copies` warps at once (symmetry). Each point then costs
   * `copies` warp evaluations, while the picture holds only 1/copies as much distinct detail; scaling the
   * limits by 1/sqrt(copies) keeps frame cost in check and still leaves plenty of points per copy.
   */
  private limits(copies: number): { budget: number; cap: number } {
    const k = Math.sqrt(Math.max(1, copies));
    return { budget: this.settings.pointBudget / k, cap: this.settings.pointCap / k };
  }

  /** Detail used for a warp right now. */
  private detail(cap: number) {
    const { tol, maxLen, minLen, offscreenScale } = this.settings;
    const pad = 0.02;
    const k = this.coarseness;
    return {
      budget: { left: cap - this.pointCount },
      tol: tol * k,
      maxLen: maxLen * k,
      minLen: minLen * k,
      offscreenScale,
      view: { minX: -pad, minY: -pad, maxX: this.aspect + pad, maxY: 1 + pad },
    };
  }

  /** Deforms every shape by `warp`; `copies` is how many symmetric warps it combines (see limits). */
  apply(warp: Warp, copies = 1): void {
    const { cullMargin } = this.settings;
    const { budget: pointBudget, cap } = this.limits(copies);
    const detail = this.detail(cap);
    const kept: Shape[] = [];
    let points = 0;
    for (const s of this.shapes) {
      const pts = warpPolygon(s.pts, warp, detail);
      points += pts.length >> 1;
      const b = bounds(pts);
      const outside =
        b.maxX < -cullMargin || b.minX > this.aspect + cullMargin || b.maxY < -cullMargin || b.minY > 1 + cullMargin;
      // A drop can push a shape into a ring that still encloses the view; only cull fully disjoint ones.
      if (pts.length >= 6 && !outside) kept.push({ color: s.color, pts });
    }
    this.shapes = kept;
    this.version++;
    if (points > cap && this.raster) {
      // Too detailed for polygons: fold everything into the raster bath and start over with none.
      this.raster.flatten(this.shapes);
      this.shapes = [];
      this.coarseness = 1;
      return;
    }
    if (points > pointBudget) this.coarseness = Math.min(this.coarseness * 1.4, MAX_COARSENESS);
    else if (points < pointBudget / 3 && this.coarseness > 1) this.coarseness = Math.max(1, this.coarseness / 1.2);
  }

  /** Lands drops of radius r at each center: pushes all ink aside, then adds the discs on top. */
  drop(centers: Point | readonly Point[], r: number, color: RGB): void {
    const cs = Array.isArray(centers) ? centers : [centers as Point];
    const op: MarbleOp = { op: 'drop', cs, r, color };
    this.record(op);
    this.raster?.warp(op);
    this.apply(composeWarps(cs.map((c) => dropWarp(c, r * r))), cs.length);
    for (const c of cs) this.shapes.push({ color, pts: circle(c, r, this.settings.tol) });
    this.version++;
  }

  /** Grows the drops centered at each point by `dr2` (radius squared). The discs stay circles. */
  grow(centers: Point | readonly Point[], dr2: number): void {
    if (dr2 <= 0) return;
    const cs = Array.isArray(centers) ? centers : [centers as Point];
    const op: MarbleOp = { op: 'grow', cs, dr2 };
    this.record(op);
    this.raster?.warp(op);
    this.apply(composeWarps(cs.map((c) => dropWarp(c, dr2))), cs.length);
  }

  /** Drags styluses along each segment at once (see strokeWarp). */
  stroke(segs: readonly Segment[], offsets: readonly number[], lambda: number): void {
    if (segs.length === 0) return;
    const op: MarbleOp = { op: 'stroke', segs, offsets, lambda };
    this.record(op);
    this.raster?.warp(op);
    this.apply(composeWarps(segs.map((s) => strokeWarp(s.a, s.b, offsets, lambda))), segs.length);
  }
}
