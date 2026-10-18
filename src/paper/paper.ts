import { drawFullscreen, type TargetFormat } from '../gl/context';
import { Program } from '../gl/program';
import { RenderTarget } from '../gl/target';
import { between, mulberry32 } from './random';
import { PAPERS, paperTileSize, type PaperName, type PaperPreset } from './presets';
import paperFrag from '../gl/shaders/paper.frag?raw';

/**
 * Draws fibers (red channel) and specks (green) for one tile with Canvas 2D. Each mark is drawn at
 * all 9 wrap offsets, so marks crossing an edge continue on the opposite side and the tile repeats.
 */
function drawFibers(size: number, preset: PaperPreset, seed: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  // Additive, so red (fibers) and green (specks) accumulate independently.
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const rand = mulberry32(seed);
  const offsets = [-size, 0, size];

  for (let i = 0; i < preset.fibers; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const angle = rand() * Math.PI;
    const len = between(rand, preset.fiberLength) * size;
    const bend = (rand() - 0.5) * len * 0.6;
    const dx = Math.cos(angle) * len * 0.5;
    const dy = Math.sin(angle) * len * 0.5;
    // Control point pushed sideways from the middle: a gently curved strand.
    const cx = x - Math.sin(angle) * bend;
    const cy = y + Math.cos(angle) * bend;
    ctx.lineWidth = Math.max(0.5, between(rand, preset.fiberWidth) * size);
    ctx.strokeStyle = `rgba(255, 0, 0, ${between(rand, preset.fiberOpacity)})`;
    for (const ox of offsets) {
      for (const oy of offsets) {
        ctx.beginPath();
        ctx.moveTo(x - dx + ox, y - dy + oy);
        ctx.quadraticCurveTo(cx + ox, cy + oy, x + dx + ox, y + dy + oy);
        ctx.stroke();
      }
    }
  }

  for (let i = 0; i < preset.specks; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = between(rand, [0.0006, 0.002]) * size;
    ctx.fillStyle = `rgba(0, 255, 0, ${between(rand, [0.3, 0.9])})`;
    for (const ox of offsets) {
      for (const oy of offsets) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, r, r * between(rand, [0.4, 1]), rand() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return canvas;
}

/** A baked, tileable paper texture (see paper.frag for the channel layout). */
export class Paper {
  private target: RenderTarget | null = null;
  private readonly program: Program;
  private readonly fiberTexture: WebGLTexture;
  private name: PaperName = 'washi';
  private size = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly format: TargetFormat,
    private readonly seed = 7,
  ) {
    this.program = new Program(gl, paperFrag, 'paper.frag');
    this.fiberTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.fiberTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  get preset(): PaperPreset {
    return PAPERS[this.name];
  }

  get kind(): PaperName {
    return this.name;
  }

  get texture(): RenderTarget {
    if (!this.target) throw new Error('Paper not generated yet.');
    return this.target;
  }

  /** (Re)bakes the tile if the paper kind or the needed resolution changed. */
  ensure(name: PaperName, canvasHeight: number): void {
    const size = paperTileSize(canvasHeight);
    if (this.target && name === this.name && size === this.size) return;
    this.name = name;
    this.size = size;
    this.bake();
  }

  private bake(): void {
    const { gl, size } = this;
    const preset = this.preset;

    // Allocate the output first: creating a target binds its texture to the active unit, which would
    // otherwise replace the fiber texture we're about to sample (and read the output while writing it).
    if (this.target?.width !== size) {
      this.target?.dispose();
      this.target = new RenderTarget(gl, size, size, this.format, 'repeat');
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fiberTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawFibers(size, preset, this.seed));

    this.target!.bind();
    this.program
      .use()
      .int('uFibers', 0)
      .float('uSize', size)
      .float('uSeed', (this.seed % 97) / 97)
      .float('uFiberTone', preset.fiberTone)
      .float('uMottle', preset.mottle)
      .float('uGrain', preset.grain)
      .float('uTooth', preset.tooth)
      .float('uFiberRelief', preset.fiberRelief);
    drawFullscreen(gl);
  }
}
