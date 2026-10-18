/** Texture format used for every simulation render target. */
export interface TargetFormat {
  internalFormat: number;
  format: number;
  type: number;
}

export interface GLContext {
  gl: WebGL2RenderingContext;
  /** RGBA16F: velocity and pressure need signed values, and ink needs more than 8 bits to fade smoothly. */
  format: TargetFormat;
}

export function createContext(canvas: HTMLCanvasElement): GLContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    // Export reads the canvas back after a frame, so keep the drawing buffer.
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('WebGL2 is not supported in this browser.');

  // Half-float textures are filterable in core WebGL2, but rendering into them needs an extension.
  const floatTargets =
    gl.getExtension('EXT_color_buffer_float') !== null ||
    gl.getExtension('EXT_color_buffer_half_float') !== null;
  if (!floatTargets) throw new Error('This GPU cannot render to half-float textures, which the water simulation needs.');

  const format: TargetFormat = { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };

  // The fullscreen triangle is generated from gl_VertexID, but a VAO must still be bound.
  gl.bindVertexArray(gl.createVertexArray());
  gl.disable(gl.BLEND);

  return { gl, format };
}

/** Draws the fullscreen triangle with whatever program and framebuffer are bound. */
export function drawFullscreen(gl: WebGL2RenderingContext): void {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Binds the default framebuffer (the canvas) and sets the viewport to it. */
export function bindScreen(gl: WebGL2RenderingContext): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
}
