import { describe, expect, it } from 'vitest';
import { between, mulberry32 } from './random';
import { PAPERS, paperTileSize } from './presets';

describe('mulberry32', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const c = mulberry32(8);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(Array.from({ length: 5 }, c)).not.toEqual(seqA);
  });

  it('stays in [0, 1) and is roughly uniform', () => {
    const r = mulberry32(1);
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 10000).toBeCloseTo(0.5, 1);
  });

  it('between() maps into the range', () => {
    const r = mulberry32(3);
    for (let i = 0; i < 100; i++) {
      const v = between(r, [2, 5]);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThan(5);
    }
  });
});

describe('paperTileSize', () => {
  it('picks the power of two nearest the canvas height', () => {
    expect(paperTileSize(846)).toBe(1024);
    expect(paperTileSize(700)).toBe(512);
    expect(paperTileSize(1440)).toBe(1024);
    expect(paperTileSize(1600)).toBe(2048);
  });

  it('clamps to 512..2048', () => {
    expect(paperTileSize(100)).toBe(512);
    expect(paperTileSize(4320)).toBe(2048);
  });
});

describe('paper presets', () => {
  it('have sane ranges', () => {
    for (const p of Object.values(PAPERS)) {
      expect(p.fiberLength[0]).toBeLessThanOrEqual(p.fiberLength[1]);
      expect(p.fiberOpacity[1]).toBeLessThanOrEqual(1);
      expect(p.absorb).toBeGreaterThanOrEqual(0);
      expect(p.relief).toBeGreaterThanOrEqual(0);
    }
  });
});
