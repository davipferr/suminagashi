import type { Point } from '../input/stroke';
import type { RGB } from '../color';
import { combOffsets } from './geometry';
import { distinctCopies, symmetryCopies, type Symmetry } from '../input/symmetry';
import type { Marbling } from './marbling';

export type MarbleTool = 'drop' | 'tine' | 'comb';

/** Radius a drop lands with, in canvas heights; it then spreads. */
const LANDING_RADIUS = 0.015;
/** A quick click spreads to this radius. */
const MIN_RADIUS = 0.05;
/** Holding keeps feeding ink up to this radius. */
const MAX_RADIUS = 0.4;
/** While held, the drop's area (radius squared) grows this much per second. */
const GROW_PER_SECOND = 0.012;
/** How fast a drop's actual size catches up with its target (1/s); gives the bloom its ease-out. */
const SPREAD_RATE = 8;

/** Reach of a single tine's pull, in canvas heights. */
const TINE_LAMBDA = 0.012;
const COMB_TINES = 7;
const COMB_LAMBDA = 0.008;

/** Turns pointer gestures into marbling operations. One gesture = one undo step. */
export class MarbleController {
  tool: MarbleTool = 'drop';
  /** Live-tweakable from the Style panel. */
  settings = {
    /** Scales landing and minimum drop radius. */
    dropScale: 1,
    /** Distance between comb tines, canvas heights. */
    combSpacing: 0.05,
    /** Every gesture is repeated into these symmetric copies around the canvas center. */
    symmetry: 'off' as Symmetry,
  };

  /** Drops still spreading: one center per symmetric copy, all the same size. */
  private spreading: { centers: Point[]; r2: number; target: number; holding: boolean } | null = null;
  /** Where the stylus was last applied, and where the pointer is now (applied on the next frame). */
  private last: Point | null = null;
  private target: Point | null = null;

  constructor(
    private readonly model: Marbling,
    private readonly nextColor: () => RGB,
  ) {}

  private copies() {
    return symmetryCopies(this.settings.symmetry, { x: this.model.aspect / 2, y: 0.5 });
  }

  down(p: Point): void {
    this.settle();
    this.model.checkpoint();
    if (this.tool === 'drop') {
      const k = this.settings.dropScale;
      const color = this.nextColor();
      const centers = distinctCopies(this.copies(), p).map((t) => t.point(p));
      this.model.drop(centers, LANDING_RADIUS * k, color);
      this.spreading = { centers, r2: (LANDING_RADIUS * k) ** 2, target: (MIN_RADIUS * k) ** 2, holding: true };
    } else {
      this.last = p;
    }
  }

  /**
   * Pointer moved. Every stroke warps every point of the picture, and pointers can fire several
   * times per frame, so the motion is only collected here and applied once per frame in update().
   */
  move(p: Point): void {
    if (this.last) this.target = p;
  }

  /** Applies the stylus motion collected since the last frame, as one stroke. */
  private flushStroke(): void {
    const a = this.last;
    const b = this.target;
    this.target = null;
    if (!a || !b || (a.x === b.x && a.y === b.y)) return;
    const offsets = this.tool === 'comb' ? combOffsets(COMB_TINES, this.settings.combSpacing) : [0];
    const lambda = this.tool === 'comb' ? COMB_LAMBDA : TINE_LAMBDA;
    const segs = distinctCopies(this.copies(), a, b).map((t) => ({ a: t.point(a), b: t.point(b) }));
    this.model.stroke(segs, offsets, lambda);
    this.last = b;
  }

  up(): void {
    this.flushStroke();
    if (this.spreading) this.spreading.holding = false;
    this.last = null;
  }

  /** Applies pending stylus motion and advances a spreading drop. Call once per frame. */
  update(dt: number): void {
    this.flushStroke();
    const s = this.spreading;
    if (!s) return;
    if (s.holding) s.target = Math.min(s.target + GROW_PER_SECOND * dt, MAX_RADIUS ** 2);
    const next = s.r2 + (s.target - s.r2) * (1 - Math.exp(-SPREAD_RATE * dt));
    this.model.grow(s.centers, next - s.r2);
    s.r2 = next;
    if (!s.holding && s.target - s.r2 < 1e-6) this.settle();
  }

  /** Finishes any pending stroke or spreading drop at once (before the next gesture, an undo, an export). */
  settle(): void {
    this.flushStroke();
    const s = this.spreading;
    if (!s) return;
    this.model.grow(s.centers, s.target - s.r2);
    this.spreading = null;
  }
}
