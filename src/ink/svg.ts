import type { RGB } from '../color';
import { toHex, type Region } from '../export/framing';
import { buildStroke, type StrokePoint } from './pen';
import type { InkStroke } from './ink';

/** Resampling for vector output, canvas heights (about 1.5 px on a 2000 px tall print). */
const SVG_SPACING = 1 / 1400;

const n = (v: number) => +v.toFixed(5);

/** A circle as a closed subpath, drawn clockwise on screen (sweep flag 1, y down). */
function circlePath(p: StrokePoint): string {
  return `M${n(p.x + p.r)} ${n(p.y)}A${n(p.r)} ${n(p.r)} 0 1 1 ${n(p.x - p.r)} ${n(p.y)}A${n(p.r)} ${n(p.r)} 0 1 1 ${n(p.x + p.r)} ${n(p.y)}Z`;
}

type XY = [number, number];

/** Largest error allowed where the outline cuts a corner instead of following an arc (canvas heights). */
const JOIN_TOLERANCE = 0.00005;
/** Taper slopes |dr/ds| above this get a round join: the outline there is mostly the circles themselves. */
const STEEP = 0.5;

function quadPath(q: XY[]): string {
  // Shoelace in y-down coordinates: positive = clockwise on screen, like the circles.
  let area = 0;
  for (let i = 0; i < 4; i++) area += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
  const pts = area < 0 ? [...q].reverse() : q;
  return `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}Z`;
}

function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const side = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * One path per stroke: the stroke's outline is the envelope of a circle of radius r(s) moving along the
 * centre line, whose two sides sit at  p + r * (-r' u +- sqrt(1 - r'^2) n)  (u tangent, n normal,
 * r' = dr/ds). Consecutive quads between those side points share their edges exactly, so there are no
 * seams; circles are added only where the straight edges would visibly cut a corner — the round end caps,
 * real bends, steep taper slopes — or where a quad would fold into a bow-tie (its reversed half would
 * cancel the fill). Everything winds clockwise, so the default nonzero fill paints the union: the same
 * shape the screen draws with SDF capsules.
 */
export function strokePath(stroke: InkStroke, spacing = SVG_SPACING): string {
  const pts = buildStroke(stroke.samples, stroke.pen, spacing, true);
  const count = pts.length;
  if (count === 0) return '';
  if (count === 1) return pts[0].r > 0 ? circlePath(pts[0]) : '';

  const left: XY[] = [];
  const right: XY[] = [];
  const join = new Array<boolean>(count).fill(false);
  join[0] = join[count - 1] = true;
  for (let i = 0; i < count; i++) {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, count - 1)];
    const p = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-12;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let slope = (b.r - a.r) / len;
    if (Math.abs(slope) > STEEP) join[i] = true;
    slope = Math.max(-0.95, Math.min(0.95, slope));
    const c = Math.sqrt(1 - slope * slope);
    const nx = -uy;
    const ny = ux;
    left.push([p.x + p.r * (-slope * ux + c * nx), p.y + p.r * (-slope * uy + c * ny)]);
    right.push([p.x + p.r * (-slope * ux - c * nx), p.y + p.r * (-slope * uy - c * ny)]);
    if (i > 0 && i < count - 1) {
      // Outer side of a bend: straight edges cut the arc by about r * turn^2 / 8.
      const raw = Math.abs(Math.atan2(b.y - p.y, b.x - p.x) - Math.atan2(p.y - a.y, p.x - a.x));
      const turn = Math.min(raw, 2 * Math.PI - raw);
      if ((p.r * turn * turn) / 8 > JOIN_TOLERANCE) join[i] = true;
    }
  }

  const parts: string[] = [];
  for (let i = 0; i < count - 1; i++) {
    if (pts[i].r <= 0 && pts[i + 1].r <= 0) continue;
    const q: XY[] = [left[i], left[i + 1], right[i + 1], right[i]];
    if (segmentsCross(q[0], q[1], q[2], q[3]) || segmentsCross(q[1], q[2], q[3], q[0])) {
      join[i] = join[i + 1] = true;
      continue;
    }
    parts.push(quadPath(q));
  }
  for (let i = 0; i < count; i++) if (join[i] && pts[i].r > 0) parts.push(circlePath(pts[i]));
  return parts.join('');
}

/** Line art as SVG. Same framing conventions as the marbling SVG (marbling units, clipped to the picture). */
export function inkToSvg(
  strokes: readonly InkStroke[],
  srcAspect: number,
  region: Region,
  width: number,
  height: number,
  paperColor: RGB,
): string {
  const vx = region.x * srcAspect;
  const vy = region.y;
  const vw = region.w * srcAspect;
  const vh = region.h;
  const paper = toHex(paperColor);
  const paths = strokes.map((s) => `<path fill="${s.pen.erase ? paper : '#000000'}" d="${strokePath(s)}"/>`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}" preserveAspectRatio="none">`,
    `<defs><clipPath id="picture"><rect x="0" y="0" width="${n(srcAspect)}" height="1"/></clipPath></defs>`,
    `<rect x="${n(vx)}" y="${n(vy)}" width="${n(vw)}" height="${n(vh)}" fill="${paper}"/>`,
    `<g clip-path="url(#picture)">`,
    ...paths,
    `</g>`,
    `</svg>`,
  ].join('\n');
}
