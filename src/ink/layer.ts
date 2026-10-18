import { drawFullscreen, type TargetFormat } from '../gl/context';
import { Program } from '../gl/program';
import { RenderTarget } from '../gl/target';
import { inkDensity } from '../color';
import { SEGMENT_FLOATS } from './pen';
import { segmentsFor, type InkModel, type InkStroke } from './ink';
import capsuleVert from '../gl/shaders/capsule.vert?raw';
import capsuleFrag from '../gl/shaders/capsule.frag?raw';
import inkDyeFrag from '../gl/shaders/inkDye.frag?raw';

/** Pure black ink: the darkest the paper model allows (1% of the light through). */
const BLACK = inkDensity([0, 0, 0]);
/** Resample strokes every this many pixels. */
const SPACING_PX = 1.5;

/** Which part of the canvas a target shows: canvas point at its top-left, and pixels per canvas unit. */
export interface InkView {
  x: number;
  y: number;
  scale: number;
}

/**
 * Draws line art. Finished strokes are baked once into a coverage target (only new strokes are added; a
 * full redraw happens on undo, clear or resize); the stroke being drawn is redrawn every frame into its own
 * target, since its tail keeps changing. Both merge into the dye format the display shader reads.
 */
export class InkLayer {
  private readonly capsule: Program;
  private readonly convert: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly rgba8: TargetFormat;
  private committed: RenderTarget;
  private live: RenderTarget;
  private target: RenderTarget;
  private drawn: readonly InkStroke[] = [];
  private drawnLive = -1;
  private width: number;
  private height: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly format: TargetFormat,
    width: number,
    height: number,
  ) {
    this.width = width;
    this.height = height;
    this.rgba8 = { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    this.capsule = new Program(gl, capsuleFrag, 'capsule', capsuleVert);
    this.convert = new Program(gl, inkDyeFrag, 'inkDye.frag');

    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = SEGMENT_FLOATS * 4;
    for (const [name, offset] of [
      ['aA', 0],
      ['aB', 12],
    ] as const) {
      const loc = gl.getAttribLocation(this.capsule.program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(previousVao);

    this.committed = new RenderTarget(gl, width, height, this.rgba8);
    this.live = new RenderTarget(gl, width, height, this.rgba8);
    this.target = new RenderTarget(gl, width, height, format);
  }

  /** The line art as dye: rgb = optical density, a = coverage. */
  get dye(): RenderTarget {
    return this.target;
  }

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    for (const t of [this.committed, this.live, this.target]) t.dispose();
    this.committed = new RenderTarget(this.gl, width, height, this.rgba8);
    this.live = new RenderTarget(this.gl, width, height, this.rgba8);
    this.target = new RenderTarget(this.gl, width, height, this.format);
    this.drawn = [];
    this.drawnLive = -1;
  }

  /** Brings the targets up to date with the model. Cheap when nothing changed. */
  sync(model: InkModel): void {
    const view = { x: 0, y: 0, scale: this.height };
    const spacing = SPACING_PX / view.scale;
    let changed = false;

    if (model.strokes !== this.drawn) {
      // Only appended since last time? Then just draw the new strokes on top.
      const appended =
        model.strokes.length > this.drawn.length && this.drawn.every((s, i) => model.strokes[i] === s);
      if (!appended) this.clearTarget(this.committed);
      const start = appended ? this.drawn.length : 0;
      for (const s of model.strokes.slice(start)) this.drawStroke(this.committed, s, spacing, view);
      this.drawn = model.strokes;
      changed = true;
    }

    if (model.liveVersion !== this.drawnLive) {
      this.clearTarget(this.live);
      // The live stroke is always drawn as coverage; white-out is applied when merging (see inkDye.frag).
      if (model.current) this.draw(this.live, segmentsFor(model.current, spacing, false), view, false);
      this.drawnLive = model.liveVersion;
      changed = true;
    }

    if (changed) this.merge(model.current?.pen.erase ?? false);
  }

  /**
   * Renders finished strokes into this layer's dye from scratch, for any view (export at another size or
   * framing). `clipWidth` hides ink outside the original picture [0, clipWidth] x [0, 1].
   */
  renderStatic(strokes: readonly InkStroke[], view: InkView, clipWidth?: number): void {
    const spacing = SPACING_PX / view.scale;
    this.clearTarget(this.committed);
    this.clearTarget(this.live);
    if (clipWidth !== undefined) {
      const x0 = Math.round(-view.x * view.scale);
      const x1 = Math.round((clipWidth - view.x) * view.scale);
      const yTop = Math.round(-view.y * view.scale);
      const yBottom = Math.round((1 - view.y) * view.scale);
      this.gl.enable(this.gl.SCISSOR_TEST);
      this.gl.scissor(x0, this.height - yBottom, x1 - x0, yBottom - yTop);
    }
    for (const s of strokes) this.drawStroke(this.committed, s, spacing, view);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.drawn = [];
    this.drawnLive = -1;
    this.merge(false);
  }

  private merge(liveErase: boolean): void {
    this.target.bind();
    this.convert
      .use()
      .int('uCommitted', this.committed.attach(0))
      .int('uLive', this.live.attach(1))
      .int('uLiveErase', liveErase ? 1 : 0)
      .vec3('uDensity', BLACK);
    drawFullscreen(this.gl);
  }

  private drawStroke(t: RenderTarget, s: InkStroke, spacing: number, view: InkView): void {
    this.draw(t, segmentsFor(s, spacing, true), view, s.pen.erase ?? false);
  }

  private clearTarget(t: RenderTarget): void {
    t.bind();
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  /**
   * Adds segments to a coverage target: MAX blending, the union of the capsules. White-out writes
   * 1 - coverage with MIN blending instead, taking ink away.
   */
  private draw(t: RenderTarget, segments: Float32Array, view: InkView, erase: boolean): void {
    const count = segments.length / SEGMENT_FLOATS;
    if (count === 0) return;
    const gl = this.gl;
    t.bind();
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, segments, gl.STREAM_DRAW);
    this.capsule
      .use()
      .vec2('uOrigin', view.x, view.y)
      .float('uScale', view.scale)
      .vec2('uSize', t.width, t.height)
      .int('uErase', erase ? 1 : 0);
    gl.enable(gl.BLEND);
    gl.blendEquation(erase ? gl.MIN : gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(previousVao);
  }

  dispose(): void {
    for (const t of [this.committed, this.live, this.target]) t.dispose();
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteVertexArray(this.vao);
  }
}
