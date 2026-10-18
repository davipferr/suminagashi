import { describe, expect, it } from 'vitest';
import { exportFilename, framingRegion, marblingToSvg } from './framing';
import { coords } from '../marbling/geometry';

describe('framingRegion', () => {
  it('cover onto a wider wallpaper keeps the full width and crops top and bottom', () => {
    expect(framingRegion(1, 2, 'cover')).toEqual({ x: 0, y: 0.25, w: 1, h: 0.5 });
  });

  it('cover onto a taller wallpaper keeps the full height and crops the sides', () => {
    expect(framingRegion(1, 0.5, 'cover')).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
  });

  it('contain onto a wider wallpaper adds side margins', () => {
    expect(framingRegion(1, 2, 'contain')).toEqual({ x: -0.5, y: 0, w: 2, h: 1 });
  });

  it('contain onto a taller wallpaper adds top and bottom margins', () => {
    expect(framingRegion(1, 0.5, 'contain')).toEqual({ x: 0, y: -0.5, w: 1, h: 2 });
  });

  it('same aspect is the identity either way', () => {
    expect(framingRegion(16 / 9, 16 / 9, 'cover')).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(framingRegion(16 / 9, 16 / 9, 'contain')).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('the region in pixels always has the wallpaper aspect', () => {
    for (const [src, dst] of [
      [0.8, 1.78],
      [1.78, 0.46],
      [2.4, 1],
    ]) {
      for (const f of ['cover', 'contain'] as const) {
        const r = framingRegion(src, dst, f);
        expect((r.w * src) / r.h).toBeCloseTo(dst, 10);
      }
    }
  });
});

describe('marblingToSvg', () => {
  const tri = { color: [1, 0, 0] as const, pts: coords([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.3, y: 0.4 }]) };

  it('writes one filled path per shape, in marbling units, over the paper', () => {
    const svg = marblingToSvg([tri], 1.5, { x: 0, y: 0, w: 1, h: 1 }, 1500, 1000, [1, 1, 1]);
    expect(svg).toContain('width="1500" height="1000"');
    expect(svg).toContain('viewBox="0 0 1.5 1"');
    expect(svg).toContain('<path fill="#ff0000" d="M0.1 0.1L0.5 0.1L0.3 0.4Z"/>');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg.match(/<path /g)).toHaveLength(1);
  });

  it('maps the framing region into the viewBox and clips to the original picture', () => {
    const svg = marblingToSvg([tri], 2, { x: -0.5, y: 0, w: 2, h: 1 }, 400, 100, [1, 1, 1]);
    expect(svg).toContain('viewBox="-1 0 4 1"');
    expect(svg).toContain('<rect x="0" y="0" width="2" height="1"/>');
  });
});

describe('exportFilename', () => {
  it('names the mode, size and time', () => {
    const name = exportFilename('marble', 3840, 2160, 'png', new Date('2026-10-18T14:05:09Z'));
    expect(name).toBe('suminagashi-marble-3840x2160-2026-10-18-14-05-09.png');
  });
});
