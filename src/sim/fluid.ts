import { drawFullscreen, type TargetFormat } from '../gl/context';
import { Program } from '../gl/program';
import { DoubleTarget, RenderTarget } from '../gl/target';
import type { RGB } from '../color';
import { gridSize } from './grid';
import advectFrag from '../gl/shaders/advect.frag?raw';
import curlFrag from '../gl/shaders/curl.frag?raw';
import vorticityFrag from '../gl/shaders/vorticity.frag?raw';
import divergenceFrag from '../gl/shaders/divergence.frag?raw';
import pressureFrag from '../gl/shaders/pressure.frag?raw';
import gradientFrag from '../gl/shaders/gradient.frag?raw';
import scaleFrag from '../gl/shaders/scale.frag?raw';
import splatFrag from '../gl/shaders/splat.frag?raw';
import forceFrag from '../gl/shaders/force.frag?raw';
import maccormackFrag from '../gl/shaders/maccormack.frag?raw';

export interface FluidSettings {
  /** Cells on the shorter side of the velocity/pressure grid. */
  simResolution: number;
  /** Cells on the shorter side of the dye grid (the visible ink). */
  dyeResolution: number;
  /** Jacobi iterations per step; more = stiffer, less "squishy" water. */
  pressureIterations: number;
  /** Fraction of last step's pressure kept as the solver's starting guess. */
  pressureKeep: number;
  /** Vorticity confinement strength; higher = curlier. */
  curl: number;
  /** Fraction of velocity kept per second (how fast the water calms down). */
  velocityKeepPerSecond: number;
  /** Fraction of ink kept per second. */
  dyeKeepPerSecond: number;
  /** MacCormack advection for the ink: crisp filaments instead of slow blur, at 2 extra passes. */
  sharpInk: boolean;
}

export const DEFAULT_FLUID: FluidSettings = {
  simResolution: 256,
  dyeResolution: 1024,
  pressureIterations: 25,
  pressureKeep: 0.8,
  // Tuned by eye: ~25 gives smoke (hairy, ragged edges); ink on water flows in smooth bands.
  curl: 8,
  // Water glides on for a few seconds after a stroke, so shapes keep drawing out into lines.
  velocityKeepPerSecond: 0.75,
  // Ink barely fades: a finished piece should hold still long enough to export.
  dyeKeepPerSecond: 0.998,
  sharpInk: true,
};

/**
 * GPU "Stable Fluids" (Stam 1999) on a closed tank of water.
 * Each step: vorticity confinement -> pressure projection -> advect velocity -> advect dye.
 * Velocity is stored in sim cells per second; positions everywhere else are UV (0..1).
 */
export class Fluid {
  readonly settings: FluidSettings;

  private velocity: DoubleTarget;
  private pressure: DoubleTarget;
  private divergence: RenderTarget;
  private curl: RenderTarget;
  private dyeField: DoubleTarget;
  /** MacCormack scratch: ink advected forward, then back again. */
  private dyeForward: RenderTarget;
  private dyeBackward: RenderTarget;

  private readonly advect: Program;
  private readonly curlProgram: Program;
  private readonly vorticity: Program;
  private readonly divergenceProgram: Program;
  private readonly pressureProgram: Program;
  private readonly gradient: Program;
  private readonly scale: Program;
  private readonly splat: Program;
  private readonly force: Program;
  private readonly maccormack: Program;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly format: TargetFormat,
    canvasWidth: number,
    canvasHeight: number,
    settings: Partial<FluidSettings> = {},
  ) {
    this.settings = { ...DEFAULT_FLUID, ...settings };

    this.advect = new Program(gl, advectFrag, 'advect.frag');
    this.curlProgram = new Program(gl, curlFrag, 'curl.frag');
    this.vorticity = new Program(gl, vorticityFrag, 'vorticity.frag');
    this.divergenceProgram = new Program(gl, divergenceFrag, 'divergence.frag');
    this.pressureProgram = new Program(gl, pressureFrag, 'pressure.frag');
    this.gradient = new Program(gl, gradientFrag, 'gradient.frag');
    this.scale = new Program(gl, scaleFrag, 'scale.frag');
    this.splat = new Program(gl, splatFrag, 'splat.frag');
    this.force = new Program(gl, forceFrag, 'force.frag');
    this.maccormack = new Program(gl, maccormackFrag, 'maccormack.frag');

    const sim = gridSize(canvasWidth, canvasHeight, this.settings.simResolution);
    const dye = gridSize(canvasWidth, canvasHeight, this.settings.dyeResolution);
    this.velocity = new DoubleTarget(gl, sim.width, sim.height, format);
    this.pressure = new DoubleTarget(gl, sim.width, sim.height, format);
    this.divergence = new RenderTarget(gl, sim.width, sim.height, format);
    this.curl = new RenderTarget(gl, sim.width, sim.height, format);
    this.dyeField = new DoubleTarget(gl, dye.width, dye.height, format);
    this.dyeForward = new RenderTarget(gl, dye.width, dye.height, format);
    this.dyeBackward = new RenderTarget(gl, dye.width, dye.height, format);
  }

  /** The visible ink: rgb = optical density per channel, a = coverage. */
  get dye(): RenderTarget {
    return this.dyeField.read;
  }

  /** Velocity field, for debug views. */
  get velocityField(): RenderTarget {
    return this.velocity.read;
  }

  get simSize(): { width: number; height: number } {
    return { width: this.velocity.width, height: this.velocity.height };
  }

  get dyeSize(): { width: number; height: number } {
    return { width: this.dyeField.width, height: this.dyeField.height };
  }

  /** Follows the canvas size. Ink and motion are stretched over; scratch fields are just reallocated. */
  resize(canvasWidth: number, canvasHeight: number): void {
    const sim = gridSize(canvasWidth, canvasHeight, this.settings.simResolution);
    const dye = gridSize(canvasWidth, canvasHeight, this.settings.dyeResolution);
    this.velocity.resize(sim.width, sim.height);
    this.pressure.resize(sim.width, sim.height);
    this.dyeField.resize(dye.width, dye.height);
    this.divergence = this.realloc(this.divergence, sim.width, sim.height);
    this.curl = this.realloc(this.curl, sim.width, sim.height);
    this.dyeForward = this.realloc(this.dyeForward, dye.width, dye.height);
    this.dyeBackward = this.realloc(this.dyeBackward, dye.width, dye.height);
  }

  private saved: RenderTarget[] | null = null;

  /** Saves the full state (motion, pressure, ink) so it can be put back exactly (replay). */
  snapshot(): void {
    this.dropSnapshot();
    this.saved = [this.velocity.read, this.pressure.read, this.dyeField.read].map((t) => {
      const copy = new RenderTarget(this.gl, t.width, t.height, this.format);
      t.blitTo(copy, 'nearest');
      return copy;
    });
  }

  /** Puts back the state saved by snapshot(). Returns false if there was none (or the size changed since). */
  restoreSnapshot(): boolean {
    const saved = this.saved;
    if (!saved) return false;
    const live = [this.velocity.read, this.pressure.read, this.dyeField.read];
    const ok = saved.every((s, i) => s.width === live[i].width && s.height === live[i].height);
    if (ok) saved.forEach((s, i) => s.blitTo(live[i], 'nearest'));
    this.dropSnapshot();
    return ok;
  }

  private dropSnapshot(): void {
    this.saved?.forEach((t) => t.dispose());
    this.saved = null;
  }

  /** Empties the tank: no ink, still water. */
  clear(): void {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    for (const t of [this.velocity.read, this.pressure.read, this.dyeField.read]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /** Scratch targets are rewritten every step, so on resize they're simply replaced. */
  private realloc(target: RenderTarget, width: number, height: number): RenderTarget {
    if (target.width === width && target.height === height) return target;
    target.dispose();
    return new RenderTarget(this.gl, width, height, this.format);
  }

  /**
   * Drops ink at (x, y) in UV. `density` is the ink's absorbance (see inkDensity), `radius` a fraction
   * of the canvas height, `hardness` 0..1 from soft to crisp edge.
   */
  addDye(x: number, y: number, density: RGB, radius: number, hardness: number): void {
    const f = this.dyeField;
    f.write.bind();
    this.splat
      .use()
      .int('uTarget', f.read.attach(0))
      .float('uAspect', f.width / f.height)
      .vec2('uPoint', x, y)
      .vec3('uDensity', density)
      .float('uRadius', radius)
      .float('uHardness', hardness);
    drawFullscreen(this.gl);
    f.swap();
  }

  /** Pushes the water at (x, y) with a velocity given in UV per second. */
  addForce(x: number, y: number, vx: number, vy: number, radius: number): void {
    const v = this.velocity;
    v.write.bind();
    this.force
      .use()
      .int('uTarget', v.read.attach(0))
      .float('uAspect', v.width / v.height)
      .vec2('uPoint', x, y)
      .vec2('uForce', vx * v.width, vy * v.height)
      .float('uRadius', radius);
    drawFullscreen(this.gl);
    v.swap();
  }

  step(dt: number): void {
    const gl = this.gl;
    const s = this.settings;
    const tx = 1 / this.velocity.width;
    const ty = 1 / this.velocity.height;

    // 1. Curl of the velocity, then vorticity confinement to keep small eddies spinning.
    this.curl.bind();
    this.curlProgram.use().int('uVelocity', this.velocity.read.attach(0)).vec2('uTexel', tx, ty);
    drawFullscreen(gl);

    this.velocity.write.bind();
    this.vorticity
      .use()
      .int('uVelocity', this.velocity.read.attach(0))
      .int('uCurl', this.curl.attach(1))
      .vec2('uTexel', tx, ty)
      .float('uStrength', s.curl)
      .float('uDt', dt);
    drawFullscreen(gl);
    this.velocity.swap();

    // 2. Projection: measure divergence, solve for pressure, subtract its gradient.
    this.divergence.bind();
    this.divergenceProgram.use().int('uVelocity', this.velocity.read.attach(0)).vec2('uTexel', tx, ty);
    drawFullscreen(gl);

    this.pressure.write.bind();
    this.scale.use().int('uTarget', this.pressure.read.attach(0)).float('uKeep', s.pressureKeep);
    drawFullscreen(gl);
    this.pressure.swap();

    this.pressureProgram.use().int('uDivergence', this.divergence.attach(1)).vec2('uTexel', tx, ty);
    for (let i = 0; i < s.pressureIterations; i++) {
      this.pressure.write.bind();
      this.pressureProgram.int('uPressure', this.pressure.read.attach(0));
      drawFullscreen(gl);
      this.pressure.swap();
    }

    this.velocity.write.bind();
    this.gradient
      .use()
      .int('uPressure', this.pressure.read.attach(0))
      .int('uVelocity', this.velocity.read.attach(1))
      .vec2('uTexel', tx, ty);
    drawFullscreen(gl);
    this.velocity.swap();

    // 3. Move the velocity along itself, then carry the ink with it.
    this.velocity.write.bind();
    this.advect
      .use()
      .int('uVelocity', this.velocity.read.attach(0))
      .int('uSource', this.velocity.read.attach(0))
      .vec2('uTexel', tx, ty)
      .float('uDt', dt)
      .float('uKeep', Math.pow(s.velocityKeepPerSecond, dt));
    drawFullscreen(gl);
    this.velocity.swap();

    const dyeKeep = Math.pow(s.dyeKeepPerSecond, dt);
    if (!s.sharpInk) {
      this.dyeField.write.bind();
      this.advect
        .int('uVelocity', this.velocity.read.attach(0))
        .int('uSource', this.dyeField.read.attach(1))
        .float('uKeep', dyeKeep);
      drawFullscreen(gl);
      this.dyeField.swap();
      return;
    }

    // MacCormack: forward, backward, then the clamped error correction.
    this.dyeForward.bind();
    this.advect
      .int('uVelocity', this.velocity.read.attach(0))
      .int('uSource', this.dyeField.read.attach(1))
      .float('uKeep', 1);
    drawFullscreen(gl);

    this.dyeBackward.bind();
    this.advect.int('uSource', this.dyeForward.attach(1)).float('uDt', -dt);
    drawFullscreen(gl);

    this.dyeField.write.bind();
    this.maccormack
      .use()
      .int('uVelocity', this.velocity.read.attach(0))
      .int('uSource', this.dyeField.read.attach(1))
      .int('uForward', this.dyeForward.attach(2))
      .int('uBackward', this.dyeBackward.attach(3))
      .vec2('uTexel', tx, ty)
      .vec2('uDyeTexel', 1 / this.dyeField.width, 1 / this.dyeField.height)
      .float('uDt', dt)
      .float('uKeep', dyeKeep);
    drawFullscreen(gl);
    this.dyeField.swap();
  }
}
