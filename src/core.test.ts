import { describe, expect, it } from 'vitest';
import { hexToRgb, inkDensity, srgbToLinear } from './color';
import { bloomProgress } from './input/bloom';
import { gridSize } from './sim/grid';
import { strokePoints } from './input/stroke';

describe('hexToRgb', () => {
  it('parses six-digit colors', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
  });

  it('expands three-digit shorthand', () => {
    expect(hexToRgb('#0f0')).toEqual([0, 1, 0]);
  });

  it('rejects junk', () => {
    expect(() => hexToRgb('#12345')).toThrow();
    expect(() => hexToRgb('blue')).toThrow();
  });
});

describe('gridSize', () => {
  it('gives the shorter side `resolution` cells and keeps the aspect ratio', () => {
    expect(gridSize(2560, 1440, 720)).toEqual({ width: 1280, height: 720 });
    expect(gridSize(1170, 2532, 512)).toEqual({ width: 512, height: 1108 });
  });

  it('never upsamples past the canvas', () => {
    expect(gridSize(400, 300, 1024)).toEqual({ width: 400, height: 300 });
  });

  it('survives a zero-sized canvas', () => {
    expect(gridSize(0, 0, 256)).toEqual({ width: 1, height: 1 });
  });
});

describe('strokePoints', () => {
  it('fills a long segment with evenly spaced points ending at the target', () => {
    const pts = strokePoints({ x: 0, y: 0 }, { x: 0, y: 1 }, 1, 0.25);
    expect(pts).toHaveLength(4);
    expect(pts[0]).toEqual({ x: 0, y: 0.25 });
    expect(pts[3]).toEqual({ x: 0, y: 1 });
  });

  it('measures horizontal distance in canvas-height units', () => {
    // 0.5 UV across a 2:1 canvas is one canvas height long.
    expect(strokePoints({ x: 0, y: 0 }, { x: 0.5, y: 0 }, 2, 0.25)).toHaveLength(4);
  });

  it('always returns at least the end point', () => {
    expect(strokePoints({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }, 1, 0.1)).toEqual([{ x: 0.3, y: 0.3 }]);
  });
});

describe('srgbToLinear', () => {
  it('keeps black and white fixed and darkens mid-grey', () => {
    expect(srgbToLinear([0, 1, 0.5])[0]).toBe(0);
    expect(srgbToLinear([0, 1, 0.5])[1]).toBeCloseTo(1, 10);
    expect(srgbToLinear([0, 1, 0.5])[2]).toBeCloseTo(0.214, 3);
  });
});

describe('inkDensity', () => {
  it('round-trips: white paper seen through the ink shows the ink color', () => {
    const color = hexToRgb('#27408b');
    const lin = srgbToLinear(color);
    const shown = inkDensity(color).map((d) => Math.exp(-d));
    shown.forEach((v, i) => expect(v).toBeCloseTo(lin[i], 6));
  });

  it('gives white zero density and keeps black finite', () => {
    inkDensity([1, 1, 1]).forEach((d) => expect(d).toBeCloseTo(0, 10));
    expect(inkDensity([0, 0, 0]).every((d) => Number.isFinite(d) && d > 4)).toBe(true);
  });

  it('absorbs most in the channels the ink is missing', () => {
    const [r, , b] = inkDensity(hexToRgb('#b5302a')); // vermilion
    expect(b).toBeGreaterThan(r);
  });
});

describe('bloomProgress', () => {
  it('starts as a small bead and ends at full size', () => {
    expect(bloomProgress(0, 1)).toBeCloseTo(0.2);
    expect(bloomProgress(1, 1)).toBe(1);
    expect(bloomProgress(5, 1)).toBe(1);
  });

  it('spreads fast at first, then slows (ease-out)', () => {
    const early = bloomProgress(0.25, 1) - bloomProgress(0, 1);
    const late = bloomProgress(1, 1) - bloomProgress(0.75, 1);
    expect(early).toBeGreaterThan(late * 5);
  });
});
