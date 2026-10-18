import type { Point } from '../input/stroke';

/**
 * The 1-Euro filter (Casiez, Roussel & Vogel, CHI 2012) for a 2D point.
 *
 * A plain exponential moving average must choose between smoothing (lag on fast strokes) and
 * responsiveness (tremor on slow ones). The 1-Euro filter adapts its cutoff frequency to speed:
 *   cutoff = minCutoff + beta * |velocity|
 * Slow, careful lines get heavy smoothing (hand tremor removed); quick hatching and flicks pass almost
 * untouched, so sharp G-pen strokes don't lag behind the pen.
 */
export class OneEuro2D {
  private x: Point | null = null;
  private dx: Point = { x: 0, y: 0 };
  private t = 0;

  /**
   * @param minCutoff Hz at rest: lower = smoother and laggier when moving slowly.
   * @param beta How much speed raises the cutoff (per unit of speed): higher = less lag on fast strokes.
   * @param dCutoff Hz for smoothing the speed estimate itself.
   */
  constructor(
    public minCutoff = 1.5,
    public beta = 8,
    private readonly dCutoff = 1,
  ) {}

  reset(): void {
    this.x = null;
    this.dx = { x: 0, y: 0 };
  }

  /** Feeds a raw sample at time `t` (seconds); returns the filtered point. */
  filter(p: Point, t: number): Point {
    if (!this.x) {
      this.x = { ...p };
      this.t = t;
      return { ...p };
    }
    // Coalesced pen events can share a timestamp; never divide by zero.
    const dt = Math.max(t - this.t, 1 / 1000);
    this.t = t;
    const rawDx = { x: (p.x - this.x.x) / dt, y: (p.y - this.x.y) / dt };
    const ad = alpha(this.dCutoff, dt);
    this.dx = { x: this.dx.x + ad * (rawDx.x - this.dx.x), y: this.dx.y + ad * (rawDx.y - this.dx.y) };
    const cutoff = this.minCutoff + this.beta * Math.hypot(this.dx.x, this.dx.y);
    const a = alpha(cutoff, dt);
    this.x = { x: this.x.x + a * (p.x - this.x.x), y: this.x.y + a * (p.y - this.x.y) };
    return { ...this.x };
  }
}

/** Smoothing factor of a first-order low-pass at `cutoff` Hz for a step of `dt` seconds. */
function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
