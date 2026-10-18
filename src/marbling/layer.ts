import { drawFullscreen, type TargetFormat } from '../gl/context';
import { Program } from '../gl/program';
import { RenderTarget } from '../gl/target';
import type { Shape } from './marbling';
import { windingTriangleFloats, windingTriangles } from './fan';
import marbleFrag from '../gl/shaders/marble.frag?raw';
import polygonVert from '../gl/shaders/polygon.vert?raw';
import polygonFrag from '../gl/shaders/polygon.frag?raw';
import rasterDrawFrag from '../gl/shaders/rasterDraw.frag?raw';
import type { RasterBath } from './raster';

/**
 * Which part of the marbling the layer shows: `x, y` (marbling units) land at the layer's top-left,
 * `scale` is pixels per unit. `clipWidth`, if set, hides ink outside the original picture [0, clipWidth] x [0, 1].
 */
export interface MarbleView {
  x: number;
  y: number;
  scale: number;
  clipWidth?: number;
}

/** MSAA samples at most; exports use fewer when the buffers would get big (see samplesFor). */
const MAX_LAYER_SAMPLES = 4;
/** Rough memory cap for the multisampled color + depth/stencil buffers. */
const MSAA_BYTES_CAP = 120e6;

/**
 * Rasterizes the marbling polygons on the GPU and converts them into a dye-format target that the shared
 * display shader reads.
 *
 * Combed marbling is a few polygons folded into thousands of thin filaments, so a scanline can cross
 * thousands of edges; Canvas 2D fills that on the main thread and took hundreds of ms per frame. Here each
 * polygon is filled with the classic stencil-then-cover method, which handles any self-overlapping
 * polygon exactly (nonzero winding) and runs entirely on the GPU:
 *   1. stencil: draw triangles whose signed coverage sums to the winding number (a hierarchical fan, see
 *      fan.ts), color off; front faces increment the stencil, back faces decrement it;
 *   2. cover: draw the polygon's bounding box in its color where the stencil is nonzero, resetting it.
 * Shapes are drawn in order, later ones on top, into a multisampled buffer (antialiased edges), which is
 * then resolved and converted to ink density. Raster ink (see RasterBath), if any, is drawn first, below.
 */
export class MarbleLayer {
  private readonly polygon: Program;
  private readonly convert: Program;
  private readonly rasterDraw: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly rgba8: TargetFormat;
  private msaa: { fbo: WebGLFramebuffer; color: WebGLRenderbuffer; stencil: WebGLRenderbuffer; samples: number };
  private resolved: RenderTarget;
  private target: RenderTarget;
  private width: number;
  private height: number;
  private drawnVersion = -1;
  /** Triangle staging buffer, reused across frames (it's several MB at the point cap). */
  private staging = new Float32Array(0);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly format: TargetFormat,
    width: number,
    height: number,
  ) {
    this.width = width;
    this.height = height;
    this.rgba8 = { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    this.polygon = new Program(gl, polygonFrag, 'polygon', polygonVert);
    this.convert = new Program(gl, marbleFrag, 'marble.frag');
    this.rasterDraw = new Program(gl, rasterDrawFrag, 'rasterDraw.frag');

    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const loc = gl.getAttribLocation(this.polygon.program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(previousVao);

    this.msaa = this.createMsaa(width, height);
    this.resolved = new RenderTarget(gl, width, height, this.rgba8);
    this.target = new RenderTarget(gl, width, height, format);
  }

  /** The marbling as dye: rgb = optical density, a = coverage. */
  get dye(): RenderTarget {
    return this.target;
  }

  private samplesFor(width: number, height: number): number {
    const gl = this.gl;
    const max = Math.min(MAX_LAYER_SAMPLES, gl.getParameter(gl.MAX_SAMPLES) as number);
    // 4 bytes color + 4 bytes depth/stencil per sample.
    const affordable = Math.floor(MSAA_BYTES_CAP / (width * height * 8));
    return Math.max(1, Math.min(max, affordable));
  }

  private createMsaa(width: number, height: number) {
    const gl = this.gl;
    const samples = this.samplesFor(width, height);
    const fbo = gl.createFramebuffer()!;
    const color = gl.createRenderbuffer()!;
    const stencil = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Marbling buffer ${width}x${height}x${samples} is incomplete (0x${status.toString(16)}).`);
    }
    return { fbo, color, stencil, samples };
  }

  private disposeMsaa(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.msaa.fbo);
    gl.deleteRenderbuffer(this.msaa.color);
    gl.deleteRenderbuffer(this.msaa.stencil);
  }

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.disposeMsaa();
    this.msaa = this.createMsaa(width, height);
    this.resolved.dispose();
    this.resolved = new RenderTarget(this.gl, width, height, this.rgba8);
    this.target.dispose();
    this.target = new RenderTarget(this.gl, width, height, this.format);
    this.drawnVersion = -1;
  }

  /** Redraws if the picture changed since the last call. By default the view is the whole canvas. */
  update(shapes: readonly Shape[], version: number, view?: MarbleView, raster?: RasterBath | null): void {
    if (version === this.drawnVersion) return;
    this.drawnVersion = version;
    // Marbling units are canvas heights.
    this.drawInto(this.resolved, shapes, view ?? { x: 0, y: 0, scale: this.height }, raster ?? null);
    this.target.bind();
    this.convert.use().int('uInk', this.resolved.attach(0));
    drawFullscreen(this.gl);
  }

  /** Renders the picture's colors (premultiplied RGBA8) into a new target the caller owns (flattening). */
  renderColor(shapes: readonly Shape[], view: MarbleView, raster: RasterBath | null): RenderTarget {
    const out = new RenderTarget(this.gl, this.width, this.height, this.rgba8);
    this.drawInto(out, shapes, view, raster);
    return out;
  }

  private drawInto(dest: RenderTarget, shapes: readonly Shape[], v: MarbleView, raster: RasterBath | null): void {
    const { gl, width, height } = this;

    // All shapes' winding triangles in one buffer; each shape is a contiguous range of vertices.
    let capacity = 0;
    for (const s of shapes) capacity += windingTriangleFloats(s.pts.length >> 1);
    if (this.staging.length < capacity) this.staging = new Float32Array(Math.ceil(capacity * 1.25));
    const data = this.staging;
    const ranges: [number, number][] = [];
    let o = 0;
    for (const s of shapes) {
      const start = o;
      o = windingTriangles(s.pts, data, o);
      ranges.push([start / 2, (o - start) / 2]);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaa.fbo);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (v.clipWidth !== undefined) {
      // Hide ink outside the original picture (export framing with paper margins).
      const x0 = Math.round((0 - v.x) * v.scale);
      const x1 = Math.round((v.clipWidth - v.x) * v.scale);
      const yTop = Math.round((0 - v.y) * v.scale);
      const yBottom = Math.round((1 - v.y) * v.scale);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x0, height - yBottom, x1 - x0, yBottom - yTop);
    }

    // Raster ink first, underneath the polygons (fullscreen pass: uses the context's attribute-less VAO).
    const r = raster?.view;
    if (r) {
      this.rasterDraw
        .use()
        .int('uMap', r.map.attach(0))
        .int('uBase', r.base.attach(1))
        .float('uAspect', r.aspect)
        .vec2('uOrigin', v.x, v.y)
        .float('uScale', v.scale)
        .float('uHeight', height);
      drawFullscreen(gl);
    }

    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, o), gl.STREAM_DRAW);

    this.polygon
      .use()
      .vec2('uOrigin', v.x, v.y)
      .vec2('uScale', (2 * v.scale) / width, (2 * v.scale) / height);
    gl.enable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    shapes.forEach((s, index) => {
      const [first, count] = ranges[index];
      // 1. Winding number into the stencil.
      gl.colorMask(false, false, false, false);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
      gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
      this.polygon.int('uCover', 0);
      gl.drawArrays(gl.TRIANGLES, first, count);

      // 2. Paint where the winding is nonzero, and reset the stencil there for the next shape.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const pts = s.pts;
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i];
        const y = pts[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      gl.colorMask(true, true, true, true);
      gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
      this.polygon.int('uCover', 1).vec4('uBox', minX, minY, maxX, maxY).vec3('uColor', s.color);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    });
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(previousVao);

    // Resolve the samples (antialiasing).
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaa.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dest.fbo);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  dispose(): void {
    const gl = this.gl;
    this.disposeMsaa();
    this.resolved.dispose();
    this.target.dispose();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
  }
}
