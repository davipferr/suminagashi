import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, RANGES, paletteColors, sanitize, toneColor } from './settings';
import { PALETTES, PAPER_TONES, STYLE_PRESETS, extractPalette } from './palettes';
import { PAPERS } from './paper/presets';

describe('sanitize', () => {
  it('falls back to the defaults for junk', () => {
    expect(sanitize(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitize('nope')).toEqual(DEFAULT_SETTINGS);
    expect(sanitize({ palette: 'nope', paper: 'vellum', tone: 42, color: -1, swirl: 'lots' })).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and clamps numbers into range', () => {
    const s = sanitize({ palette: 'ebru', paper: 'cotton', tone: 'white', color: 2, swirl: 999, glide: 0 });
    expect(s.palette).toBe('ebru');
    expect(s.paper).toBe('cotton');
    expect(s.tone).toBe('white');
    expect(s.color).toBe(2);
    expect(s.swirl).toBe(RANGES.swirl.max);
    expect(s.glide).toBe(RANGES.glide.min);
  });

  it('accepts a custom palette only when it has valid colors', () => {
    expect(sanitize({ palette: 'custom', customColors: [] }).palette).toBe(DEFAULT_SETTINGS.palette);
    const s = sanitize({ palette: 'custom', customColors: ['#112233', 'red', '#abcdef'] });
    expect(s.palette).toBe('custom');
    expect(s.customColors).toEqual(['#112233', '#abcdef']);
  });
});

describe('palette lookups', () => {
  it('resolves palette colors and paper tones', () => {
    expect(paletteColors({ ...DEFAULT_SETTINGS, palette: 'neon' })).toBe(PALETTES.find((p) => p.id === 'neon')!.colors);
    expect(paletteColors({ ...DEFAULT_SETTINGS, palette: 'custom', customColors: ['#010203'] })).toEqual(['#010203']);
    expect(toneColor({ ...DEFAULT_SETTINGS, tone: 'ash' })).toBe('#dedbd3');
  });

  it('every style preset points at a real palette, paper and tone, within slider ranges', () => {
    for (const p of STYLE_PRESETS) {
      expect(PALETTES.some((x) => x.id === p.palette)).toBe(true);
      expect(p.paper in PAPERS).toBe(true);
      expect(PAPER_TONES.some((t) => t.id === p.tone)).toBe(true);
      expect(p.swirl).toBeGreaterThanOrEqual(RANGES.swirl.min);
      expect(p.glide).toBeLessThanOrEqual(RANGES.glide.max);
    }
  });
});

describe('extractPalette', () => {
  const pixels = (colors: [number, number, number][], each: number) => {
    const out: number[] = [];
    for (const c of colors) for (let i = 0; i < each; i++) out.push(...c, 255);
    return out;
  };

  it('finds the dominant colors, darkest first', () => {
    const px = pixels(
      [
        [200, 30, 30],
        [20, 40, 160],
        [10, 10, 10],
      ],
      50,
    );
    expect(extractPalette(px, 3)).toEqual(['#0a0a0a', '#1428a0', '#c81e1e']);
  });

  it('ignores near-white and transparent pixels', () => {
    const px = [...pixels([[250, 250, 250]], 100), ...pixels([[30, 60, 90]], 10), 0, 0, 0, 0];
    expect(extractPalette(px, 3)).toEqual(['#1e3c5a']);
  });

  it('is deterministic for a seed', () => {
    const px = Array.from({ length: 4000 }, (_, i) => (i % 4 === 3 ? 255 : (i * 37) % 230));
    expect(extractPalette(px, 4, 9)).toEqual(extractPalette(px, 4, 9));
  });
});
