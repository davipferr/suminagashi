/**
 * Size of a simulation grid for a canvas: the shorter side gets `resolution` cells,
 * the longer side keeps the canvas aspect ratio. Never larger than the canvas itself.
 */
export function gridSize(canvasWidth: number, canvasHeight: number, resolution: number): { width: number; height: number } {
  const w = Math.max(1, canvasWidth);
  const h = Math.max(1, canvasHeight);
  const scale = Math.min(1, resolution / Math.min(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}
