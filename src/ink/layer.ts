import { drawFullscreen, type TargetFormat } from '../gl/context';
import { Program } from '../gl/program';
import { RenderTarget } from '../gl/target';
import { inkDensity } from '../color';
import type { InkPaper } from '../render/display';
import { SEGMENT_FLOATS } from './pen';
import { BLEED_FLOATS, BRISTLE_FLOATS, type BrushMarks } from './brush';
import { brushMarksFor, segmentsFor, type InkModel, type InkStroke } from './ink';
import capsuleVert from '../gl/shaders/capsule.vert?raw';
import capsuleFrag from '../gl/shaders/capsule.frag?raw';
import brushVert from '../gl/shaders/brush.vert?raw';
import brushCommon from '../gl/shaders/brushCommon.glsl?raw';
import bristleFrag from '../gl/shaders/bristle.frag?raw';
import bleedFrag from '../gl/shaders/bleed.frag?raw';
import inkDyeFrag from '../gl/shaders/inkDye.frag?raw';

/** Pure black ink: the darkest the paper model allows (1% of the light through). */
const BLACK = inkDensity([0, 0, 0]);
/** Resample strokes every this many pixels. */
const SPACING_PX = 1.5;
/** Darkness of a brush's bleed halo, as coverage (the core is 1). */
const HALO = 0.42;
/** The bleed shader's halo can feather out to this many times its nominal reach. */
const HALO_PAD = 1.5;

const brushShader = (body: string) => `#version 300 es\nprecision highp float;\n${brushCommon}\n${body}`;

/** Which part of the canvas a target shows: canvas point at its top-left, and pixels per canvas unit. */
export interface InkView {
  x: number;
  y: number;
  scale: number;
}

/** A program drawing one instanced quad per segment, with its own vertex layout. */
interface Instanced {
  program: Program;
  vao: WebGLVertexArrayObject;
  floats: number;
}

/**
 * Draws line art. Finished strokes are baked once into a coverage target (only new strokes are added; a
 * full redraw happens on undo, clear or resize); the stroke being drawn is redrawn every frame into its own
 * target, since its tail keeps changing. Both merge into the dye format the display shader reads.
 * Pens are unions of SDF capsules; brushes are bristle tracks plus a bleed halo shaped by the paper.
 */
export class InkLayer {
  private readonly capsule: Instanced;
  private readonly bristle: Instanced;
  private readonly bleed: Instanced;
  private readonly convert: Program;
  private readonly vbo: WebGLBuffer;
  private readonly rgba8: TargetFormat;
  private committed: RenderTarget;
  private live: RenderTarget;
  private target: RenderTarget;
  private drawn: readonly InkStroke[] = [];
  private drawnLive = -1;
  /** The paper brush strokes were last soaked into. */
  private drawnPaper = '';
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
    this.vbo = gl.createBuffer()!;
    this.capsule = this.instanced(new Program(gl, capsuleFrag, 'capsule', capsuleVert), SEGMENT_FLOATS, 3);
    this.bristle = this.instanced(new Program(gl, brushShader(bristleFrag), 'bristle', brushVert), BRISTLE_FLOATS, 4);
    this.bleed = this.instanced(new Program(gl, brushShader(bleedFrag), 'bleed', brushVert), BLEED_FLOATS, 4);
    this.convert = new Program(gl, inkDyeFrag, 'inkDye.frag');

    this.committed = new RenderTarget(gl, width, height, this.rgba8);
    this.live = new RenderTarget(gl, width, height, this.rgba8);
    this.target = new RenderTarget(gl, width, height, format);
  }

  /** A VAO reading segment instances (two end records aA, aB of `size` floats each) from the shared buffer. */
  private instanced(program: Program, floats: number, size: number): Instanced {
    const gl = this.gl;
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    for (const [name, offset] of [
      ['aA', 0],
      ['aB', size * 4],
    ] as const) {
      const loc = gl.getAttribLocation(program.program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, floats * 4, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(previousVao);
    return { program, vao, floats };
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
  sync(model: InkModel, paper: InkPaper): void {
    const view = { x: 0, y: 0, scale: this.height };
    const spacing = SPACING_PX / view.scale;
    let changed = false;

    // Brush strokes soak into the paper, so a different sheet means drawing them again.
    const paperKey = `${paper.kind}:${paper.texture.width}:${paper.wick}`;
    if (paperKey !== this.drawnPaper) {
      if (model.strokes.some((s) => s.pen.brush)) {
        this.clearTarget(this.committed);
        this.drawn = [];
      }
      this.drawnPaper = paperKey;
      this.drawnLive = -1;
    }

    if (model.strokes !== this.drawn) {
      // Only appended since last time? Then just draw the new strokes on top.
      const appended =
        model.strokes.length > this.drawn.length && this.drawn.every((s, i) => model.strokes[i] === s);
      if (!appended) this.clearTarget(this.committed);
      const start = appended ? this.drawn.length : 0;
      for (const s of model.strokes.slice(start)) this.drawStroke(this.committed, s, spacing, view, paper);
      this.drawn = model.strokes;
      changed = true;
    }

    if (model.liveVersion !== this.drawnLive) {
      this.clearTarget(this.live);
      // The live stroke is always drawn as coverage; white-out is applied when merging (see inkDye.frag).
      const s = model.current;
      if (s?.pen.brush) this.drawBrush(this.live, brushMarksFor(s, spacing, false), view, paper);
      else if (s) this.draw(this.live, segmentsFor(s, spacing, false), view, false);
      this.drawnLive = model.liveVersion;
      changed = true;
    }

    if (changed) this.merge(model.current?.pen.erase ?? false);
  }

  /**
   * Renders finished strokes into this layer's dye from scratch, for any view (export at another size or
   * framing). `clipWidth` hides ink outside the original picture [0, clipWidth] x [0, 1].
   */
  renderStatic(strokes: readonly InkStroke[], view: InkView, paper: InkPaper, clipWidth?: number): void {
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
    for (const s of strokes) this.drawStroke(this.committed, s, spacing, view, paper);
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

  private drawStroke(t: RenderTarget, s: InkStroke, spacing: number, view: InkView, paper: InkPaper): void {
    if (s.pen.brush) this.drawBrush(t, brushMarksFor(s, spacing, true), view, paper);
    else this.draw(t, segmentsFor(s, spacing, true), view, s.pen.erase ?? false);
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
    this.drawInstances(t, this.capsule, segments, erase, (p) =>
      p.vec2('uOrigin', view.x, view.y).float('uScale', view.scale).vec2('uSize', t.width, t.height).int('uErase', erase ? 1 : 0),
    );
  }

  /** A brush stroke: the bleed halo first, then the bristle tracks, both MAX-blended like pen strokes. */
  private drawBrush(t: RenderTarget, marks: BrushMarks, view: InkView, paper: InkPaper): void {
    const common = (p: Program) =>
      p
        .vec2('uOrigin', view.x, view.y)
        .float('uScale', view.scale)
        .vec2('uSize', t.width, t.height)
        .int('uPaperTex', paper.texture.attach(2));
    this.drawInstances(t, this.bleed, marks.bleed, false, (p) =>
      common(p).float('uReachPad', HALO_PAD * paper.wick).float('uWick', paper.wick).float('uHalo', HALO),
    );
    this.drawInstances(t, this.bristle, marks.bristles, false, (p) => common(p).float('uReachPad', 0));
  }

  private drawInstances(
    t: RenderTarget,
    kind: Instanced,
    data: Float32Array,
    erase: boolean,
    uniforms: (p: Program) => void,
  ): void {
    const count = data.length / kind.floats;
    if (count === 0) return;
    const gl = this.gl;
    t.bind();
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    gl.bindVertexArray(kind.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    uniforms(kind.program.use());
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
    for (const k of [this.capsule, this.bristle, this.bleed]) this.gl.deleteVertexArray(k.vao);
  }
}
