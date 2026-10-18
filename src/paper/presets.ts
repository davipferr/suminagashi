/**
 * A paper recipe. Lengths are fractions of the tile (one tile spans the canvas height), so the paper
 * looks the same at any resolution, including high-res wallpaper export.
 */
export interface PaperPreset {
  /** Number of fibers per tile. */
  fibers: number;
  fiberLength: readonly [number, number];
  fiberWidth: readonly [number, number];
  fiberOpacity: readonly [number, number];
  /** Dark inclusions (bark specks in washi). */
  specks: number;
  /** How much brighter fibers are than the sheet around them. */
  fiberTone: number;
  /** How raised fibers are. Keep it low: thin raised strands catch a shadow and read as dark scratches. */
  fiberRelief: number;
  /** Large soft brightness variation (pulp density). */
  mottle: number;
  /** Per-texel noise in brightness. */
  grain: number;
  /** Small bumps in the surface (cold-press "tooth"). */
  tooth: number;
  /** Strength of the raking light on the paper relief. */
  relief: number;
  /** How strongly the sheet varies the ink: pulp drinks more, fibers resist (show as pale wisps). */
  absorb: number;
}

export type PaperName = 'washi' | 'cotton' | 'smooth';

export const PAPERS: Record<PaperName, PaperPreset> = {
  // Kozo washi: long translucent fibers, a few bark specks, soft cloudy pulp.
  washi: {
    fibers: 1400,
    fiberLength: [0.03, 0.14],
    fiberWidth: [0.0006, 0.0018],
    fiberOpacity: [0.1, 0.35],
    specks: 70,
    fiberTone: 0.1,
    fiberRelief: 0.15,
    mottle: 0.05,
    grain: 0.015,
    tooth: 0.15,
    relief: 0.5,
    absorb: 0.35,
  },
  // Cold-press cotton rag: no visible fibers, pronounced tooth.
  cotton: {
    fibers: 250,
    fiberLength: [0.01, 0.03],
    fiberWidth: [0.0005, 0.001],
    fiberOpacity: [0.05, 0.15],
    specks: 0,
    fiberTone: 0.02,
    fiberRelief: 0.3,
    mottle: 0.025,
    grain: 0.02,
    tooth: 1,
    relief: 0.9,
    absorb: 0.2,
  },
  // Hot-press / plain: nearly flat, just enough grain to not look digital.
  smooth: {
    fibers: 0,
    fiberLength: [0, 0],
    fiberWidth: [0, 0],
    fiberOpacity: [0, 0],
    specks: 0,
    fiberTone: 0,
    fiberRelief: 0,
    mottle: 0.012,
    grain: 0.008,
    tooth: 0.08,
    relief: 0.25,
    absorb: 0,
  },
};

/** Paper tile resolution for a canvas: a power of two near the canvas height, 512..2048. */
export function paperTileSize(canvasHeight: number): number {
  const target = Math.min(Math.max(canvasHeight, 512), 2048);
  return Math.pow(2, Math.round(Math.log2(target)));
}
