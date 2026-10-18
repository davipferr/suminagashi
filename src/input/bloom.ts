/**
 * Radius of a blooming drop at age `t` seconds, as a fraction of its final radius.
 * A drop lands as a small bead and spreads quickly across the surface, slowing as it goes
 * (cubic ease-out), the way ink opens on water.
 */
export function bloomProgress(t: number, duration: number): number {
  const u = Math.min(Math.max(t / duration, 0), 1);
  const eased = 1 - Math.pow(1 - u, 3);
  return 0.2 + 0.8 * eased;
}
