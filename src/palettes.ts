import type { PaperName } from './paper/presets';
import { mulberry32 } from './paper/random';

export interface Palette {
  id: string;
  label: string;
  colors: readonly string[];
}

/** Ink sets. Ink is subtractive, so light colors make pale washes and overlaps always get darker. */
export const PALETTES: readonly Palette[] = [
  { id: 'sumi', label: 'Sumi & indigo', colors: ['#1f1d24', '#27408b', '#b5302a', '#3a5f6f'] },
  { id: 'ebru', label: 'Ottoman ebru', colors: ['#8c1c13', '#d4a017', '#1d3557', '#2a6041', '#1b1b1b'] },
  { id: 'aizome', label: 'Aizome blues', colors: ['#0b1f3a', '#1d3f72', '#3b6ea5', '#8fb3d9', '#16263d'] },
  { id: 'momiji', label: 'Autumn maple', colors: ['#7a1f1f', '#c0571d', '#d9a441', '#4a3b2a'] },
  { id: 'mono', label: 'Ink study', colors: ['#111014', '#3a3840', '#6d6a75', '#a5a1ad'] },
  { id: 'pastel', label: 'Pastel', colors: ['#f4a6b8', '#a8d8ea', '#ffd3a5', '#b8e0a6', '#c7b9ff'] },
  { id: 'neon', label: 'Neon', colors: ['#ff2e88', '#00c2ff', '#ffd400', '#7a00ff', '#00d68f'] },
];

export interface PaperTone {
  id: string;
  label: string;
  color: string;
}

/** Sheet colors. All light: ink can only darken the paper. */
export const PAPER_TONES: readonly PaperTone[] = [
  { id: 'kinari', label: 'Kinari', color: '#f3ece0' },
  { id: 'white', label: 'White', color: '#fbfaf6' },
  { id: 'unbleached', label: 'Unbleached', color: '#ece0c8' },
  { id: 'ash', label: 'Ash', color: '#dedbd3' },
];

export interface StylePreset {
  id: string;
  label: string;
  palette: string;
  paper: PaperName;
  tone: string;
  swirl: number;
  glide: number;
}

/** One click to a coherent look: palette + paper + how the water moves. */
export const STYLE_PRESETS: readonly StylePreset[] = [
  { id: 'classic', label: 'Classic suminagashi', palette: 'sumi', paper: 'washi', tone: 'kinari', swirl: 8, glide: 0.75 },
  { id: 'ebru', label: 'Ottoman ebru', palette: 'ebru', paper: 'smooth', tone: 'unbleached', swirl: 5, glide: 0.7 },
  { id: 'tide', label: 'Indigo tide', palette: 'aizome', paper: 'washi', tone: 'white', swirl: 14, glide: 0.85 },
  { id: 'maple', label: 'Autumn maple', palette: 'momiji', paper: 'cotton', tone: 'kinari', swirl: 8, glide: 0.75 },
  { id: 'study', label: 'Ink study', palette: 'mono', paper: 'washi', tone: 'ash', swirl: 6, glide: 0.7 },
  { id: 'pop', label: 'Neon pop', palette: 'neon', paper: 'smooth', tone: 'white', swirl: 12, glide: 0.8 },
];

export const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(Math.min(Math.max(v, 0), 255)).toString(16).padStart(2, '0')).join('');

const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
};

/**
 * The `k` dominant colors of an image (RGBA bytes), by k-means with k-means++ seeding.
 * Seeded, so the same photo always gives the same palette. Near-white pixels are skipped: they'd
 * become an invisible "ink" on light paper. Returned darkest first.
 */
export function extractPalette(rgba: ArrayLike<number>, k: number, seed = 1): string[] {
  const pts: [number, number, number][] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const p: [number, number, number] = [rgba[i], rgba[i + 1], rgba[i + 2]];
    if (p[0] > 235 && p[1] > 235 && p[2] > 235) continue;
    pts.push(p);
  }
  if (pts.length === 0) return [];
  const rand = mulberry32(seed);
  const d2 = (a: readonly number[], b: readonly number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  // k-means++: each next center is picked with probability proportional to its squared distance.
  const centers: number[][] = [[...pts[Math.floor(rand() * pts.length)]]];
  while (centers.length < Math.min(k, pts.length)) {
    const dist = pts.map((p) => Math.min(...centers.map((c) => d2(p, c))));
    const total = dist.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let r = rand() * total;
    let i = 0;
    while (r > dist[i] && i < pts.length - 1) r -= dist[i++];
    centers.push([...pts[i]]);
  }

  const assign = new Array<number>(pts.length).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    pts.forEach((p, i) => {
      let best = 0;
      for (let c = 1; c < centers.length; c++) if (d2(p, centers[c]) < d2(p, centers[best])) best = c;
      if (assign[i] !== best) moved = true;
      assign[i] = best;
    });
    const sums = centers.map(() => [0, 0, 0, 0]);
    pts.forEach((p, i) => {
      const s = sums[assign[i]];
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3]++;
    });
    sums.forEach((s, c) => {
      if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    });
    if (!moved && iter > 0) break;
  }

  return centers.map((c) => rgbToHex(c[0], c[1], c[2])).sort((a, b) => luminance(a) - luminance(b));
}

/** Reads an image file into a small RGBA buffer (enough for palette extraction). */
export async function imagePixels(file: Blob, maxSide = 96): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h).data;
}
