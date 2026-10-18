export type RGB = readonly [number, number, number];

/** Parses "#rgb" or "#rrggbb" into 0..1 floats (plain sRGB values, no gamma math). */
export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB-encoded 0..1 color -> linear light (the exact piecewise sRGB curve). */
export function srgbToLinear(c: RGB): RGB {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return [f(c[0]), f(c[1]), f(c[2])];
}

/** Darkest transmittance an ink can reach; keeps -log() finite for pure black. */
const MIN_TRANSMITTANCE = 0.01;

/**
 * Ink color -> optical density per channel (Beer-Lambert absorbance).
 * Chosen so that a full-strength layer on white paper shows exactly `color`: paper * exp(-density) = color.
 * Densities add when inks overlap or mix, which gives the deep, subtractive look of real ink
 * (indigo over vermilion turns dark violet, not a muddy average).
 */
export function inkDensity(color: RGB): RGB {
  const lin = srgbToLinear(color);
  const d = (v: number) => -Math.log(Math.max(v, MIN_TRANSMITTANCE));
  return [d(lin[0]), d(lin[1]), d(lin[2])];
}
