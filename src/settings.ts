import { PALETTES, PAPER_TONES } from './palettes';
import { PAPERS, type PaperName } from './paper/presets';
import { SYMMETRIES, type Symmetry } from './input/symmetry';

/** Everything the Style panel controls. Persisted per browser. */
export interface Settings {
  /** A PALETTES id, or 'custom' (colors in `customColors`, e.g. from a photo). */
  palette: string;
  customColors: string[];
  /** 'cycle' = each drop takes the next color; a number = always that palette index. */
  color: 'cycle' | number;
  paper: PaperName;
  tone: string;
  /** Drop size multiplier for both modes. */
  dropSize: number;
  /** Dark rim at ink edges. */
  edge: number;
  /** Water: vorticity confinement. */
  swirl: number;
  /** Water: fraction of velocity kept per second. */
  glide: number;
  /** Marble: distance between comb tines, in canvas heights. */
  combSpacing: number;
  /** Both modes: repeat every gesture mirrored or rotated around the center. */
  symmetry: Symmetry;
  /** Ink: pen width multiplier. */
  inkWidth: number;
  /** Ink: stabilizer strength, 0 (raw) .. 1 (very steady). */
  inkStabilizer: number;
  /** Ink brushes: how much ink a brush carries (multiplier; low = dry brush sooner). */
  brushInk: number;
  /** Ink brushes: how far wet ink bleeds into the paper (multiplier). */
  brushBleed: number;
  /** Ink brushes: qalam / broad-edge nib angle, degrees added to the tool's traditional angle. */
  nibAngle: number;
}

export const DEFAULT_SETTINGS: Settings = {
  palette: 'sumi',
  customColors: [],
  color: 'cycle',
  paper: 'washi',
  tone: 'kinari',
  dropSize: 1,
  edge: 0.35,
  swirl: 8,
  glide: 0.75,
  combSpacing: 0.05,
  symmetry: 'off',
  inkWidth: 1,
  inkStabilizer: 0.5,
  brushInk: 1,
  brushBleed: 1,
  nibAngle: 0,
};

/** Slider ranges; also used to clamp whatever comes back from storage. */
export const RANGES = {
  dropSize: { min: 0.4, max: 2.5, step: 0.05 },
  edge: { min: 0, max: 1, step: 0.05 },
  swirl: { min: 0, max: 30, step: 1 },
  glide: { min: 0.3, max: 0.95, step: 0.01 },
  combSpacing: { min: 0.02, max: 0.12, step: 0.005 },
  inkWidth: { min: 0.4, max: 3, step: 0.05 },
  inkStabilizer: { min: 0, max: 1, step: 0.05 },
  brushInk: { min: 0.2, max: 2.5, step: 0.05 },
  brushBleed: { min: 0, max: 2, step: 0.05 },
  nibAngle: { min: -45, max: 45, step: 1 },
} as const;

const HEX = /^#[0-9a-f]{6}$/i;

/** Keeps only valid values from untrusted input (old versions, hand edits), defaulting the rest. */
export function sanitize(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;

  if (Array.isArray(r.customColors)) {
    s.customColors = r.customColors.filter((c): c is string => typeof c === 'string' && HEX.test(c)).slice(0, 8);
  }
  if (typeof r.palette === 'string') {
    const known = PALETTES.some((p) => p.id === r.palette);
    if (known || (r.palette === 'custom' && s.customColors.length > 0)) s.palette = r.palette;
  }
  if (r.color === 'cycle') s.color = 'cycle';
  else if (typeof r.color === 'number' && Number.isInteger(r.color) && r.color >= 0) s.color = r.color;
  if (typeof r.paper === 'string' && r.paper in PAPERS) s.paper = r.paper as PaperName;
  if (typeof r.tone === 'string' && PAPER_TONES.some((t) => t.id === r.tone)) s.tone = r.tone;
  if (SYMMETRIES.some((x) => x.id === r.symmetry)) s.symmetry = r.symmetry as Symmetry;

  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      s[key] = Math.min(Math.max(v, RANGES[key].min), RANGES[key].max);
    }
  }
  return s;
}

/** The colors (hex) of the active palette. */
export function paletteColors(s: Settings): readonly string[] {
  if (s.palette === 'custom' && s.customColors.length) return s.customColors;
  return (PALETTES.find((p) => p.id === s.palette) ?? PALETTES[0]).colors;
}

export function toneColor(s: Settings): string {
  return (PAPER_TONES.find((t) => t.id === s.tone) ?? PAPER_TONES[0]).color;
}

const KEY = 'suminagashi.settings.v1';

export function loadSettings(): Settings {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    // Private mode, blocked storage, or corrupt JSON: just use the defaults.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable; settings simply won't persist.
  }
}
