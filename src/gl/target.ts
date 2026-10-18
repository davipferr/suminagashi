import type { TargetFormat } from './context';

/** A texture you can render into (texture + framebuffer). */
export class RenderTarget {
  readonly texture: WebGLTexture;
  readonly fbo: WebGLFramebuffer;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
    format: TargetFormat,
    /** 'repeat' for tileable textures (the paper); simulation fields clamp at the tank walls. */
    wrap: 'clamp' | 'repeat' = 'clamp',
    /** 'nearest' for 32-bit float data, which isn't filterable on every GPU (read it with texelFetch). */
    filter: 'linear' | 'nearest' = 'linear',
  ) {
    const wrapMode = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    const filterMode = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode);
    gl.texImage2D(gl.TEXTURE_2D, 0, format.internalFormat, width, height, 0, format.format, format.type, null);

    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Render target ${width}x${height} is incomplete (status 0x${status.toString(16)}).`);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Makes this the draw target and sizes the viewport to it. */
  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  /** Binds the texture to a texture unit and returns the unit, ready for a sampler uniform. */
  attach(unit: number): number {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    return unit;
  }

  /** Copies (stretching if sizes differ) this target's contents into `dest`. */
  blitTo(dest: RenderTarget, filter: 'linear' | 'nearest' = 'linear'): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dest.fbo);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, dest.width, dest.height, gl.COLOR_BUFFER_BIT, filter === 'linear' ? gl.LINEAR : gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.fbo);
  }
}

/**
 * Two render targets used in turn: a pass reads `read` and writes `write`, then `swap()`.
 * A texture can't be sampled and rendered into at the same time, so every simulation field is one of these.
 */
export class DoubleTarget {
  read: RenderTarget;
  write: RenderTarget;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    width: number,
    height: number,
    private readonly format: TargetFormat,
  ) {
    this.read = new RenderTarget(gl, width, height, format);
    this.write = new RenderTarget(gl, width, height, format);
  }

  get width(): number {
    return this.read.width;
  }

  get height(): number {
    return this.read.height;
  }

  swap(): void {
    [this.read, this.write] = [this.write, this.read];
  }

  /** Reallocates at a new size, carrying the current contents over. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    const read = new RenderTarget(this.gl, width, height, this.format);
    this.read.blitTo(read);
    this.read.dispose();
    this.write.dispose();
    this.read = read;
    this.write = new RenderTarget(this.gl, width, height, this.format);
  }
}
