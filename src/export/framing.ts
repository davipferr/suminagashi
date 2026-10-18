import type { Shape } from '../marbling/marbling';

export interface ExportSize {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** Wallpaper presets. "screen" is filled in at export time with the live canvas size. */
export const EXPORT_SIZES: readonly ExportSize[] = [
  { id: 'screen', label: 'Screen', width: 0, height: 0 },
  { id: 'phone', label: 'Phone 1170×2532', width: 1170, height: 2532 },
  { id: 'qhd', label: 'Desktop 2560×1440', width: 2560, height: 1440 },
  { id: '4k', label: '4K 3840×2160', width: 3840, height: 2160 },
  { id: 'ultrawide', label: 'Ultrawide 3440×1440', width: 3440, height: 1440 },
  { id: 'square', label: 'Square 2048×2048', width: 2048, height: 2048 },
];

/**
 * How the picture meets a wallpaper of another shape.
 * - cover: fill the wallpaper, cropping the overflow (centered).
 * - contain: show the whole picture, extending the paper into margins.
 */
export type Framing = 'cover' | 'contain';

/** A rectangle in the picture's own UV space (0..1 on both axes; may extend past it for "contain"). */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Which part of the picture (aspect `srcAspect` = width / height) lands on a wallpaper of aspect
 * `dstAspect`. The region is centered; its own aspect, in pixels, always equals the wallpaper's.
 */
export function framingRegion(srcAspect: number, dstAspect: number, framing: Framing): Region {
  const wider = dstAspect > srcAspect;
  // Width of the region relative to the picture's width, if the region's height is the picture's.
  const relWidth = dstAspect / srcAspect;
  if (framing === 'cover' ? wider : !wider) {
    // Region spans the full picture width; height shrinks (cover) or grows (contain).
    const h = 1 / relWidth;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  return { x: (1 - relWidth) / 2, y: 0, w: relWidth, h: 1 };
}

export const toHex = (c: readonly number[]) =>
  '#' + c.map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0')).join('');

/**
 * Marbling as an SVG. Shapes are in canvas-height units (y down); `srcAspect` is the canvas aspect.
 * The visible picture is clipped to the original canvas, like the PNG. Flat fills only: the paper
 * texture and ink shading are raster effects and stay in the PNG.
 */
export function marblingToSvg(
  shapes: readonly Shape[],
  srcAspect: number,
  region: Region,
  width: number,
  height: number,
  paperColor: readonly number[],
): string {
  // Picture UV -> marbling units: x scales by the aspect, y is already in heights.
  const vx = region.x * srcAspect;
  const vy = region.y;
  const vw = region.w * srcAspect;
  const vh = region.h;
  const n = (v: number) => +v.toFixed(5);
  const paths = shapes.map((s) => {
    const parts: string[] = [];
    for (let i = 0; i < s.pts.length; i += 2) parts.push(`${i ? 'L' : 'M'}${n(s.pts[i])} ${n(s.pts[i + 1])}`);
    const d = parts.join('') + 'Z';
    return `<path fill="${toHex(s.color)}" d="${d}"/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}" preserveAspectRatio="none">`,
    `<defs><clipPath id="picture"><rect x="0" y="0" width="${n(srcAspect)}" height="1"/></clipPath></defs>`,
    `<rect x="${n(vx)}" y="${n(vy)}" width="${n(vw)}" height="${n(vh)}" fill="${toHex(paperColor)}"/>`,
    `<g clip-path="url(#picture)">`,
    ...paths,
    `</g>`,
    `</svg>`,
  ].join('\n');
}

export function exportFilename(mode: string, width: number, height: number, ext: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `suminagashi-${mode}-${width}x${height}-${stamp}.${ext}`;
}
