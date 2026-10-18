export interface Point {
  x: number;
  y: number;
}

/**
 * Points along the segment from -> to (excluding `from`, including `to`), no more than `spacing` apart.
 * Coordinates are UV; `aspect` (width / height) makes distances isotropic, so spacing is in canvas-height units.
 * Pointer events arrive sparsely on fast strokes; this fills the gaps so a stroke stays continuous.
 */
export function strokePoints(from: Point, to: Point, aspect: number, spacing: number): Point[] {
  const dist = Math.hypot((to.x - from.x) * aspect, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / spacing));
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return points;
}
