import fullscreenVert from './shaders/fullscreen.vert?raw';

function compile(gl: WebGL2RenderingContext, type: number, source: string, name: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader "${name}" failed to compile:\n${log}`);
  }
  return shader;
}

/** A shader program: by default the shared fullscreen vertex shader plus one fragment shader. */
export class Program {
  private readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: WebGL2RenderingContext, fragSource: string, name: string, vertSource = fullscreenVert) {
    this.gl = gl;
    const vert = compile(gl, gl.VERTEX_SHADER, vertSource, `${name} (vertex)`);
    const frag = compile(gl, gl.FRAGMENT_SHADER, fragSource, name);
    const program = gl.createProgram()!;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program "${name}" failed to link:\n${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
  }

  use(): this {
    this.gl.useProgram(this.program);
    return this;
  }

  private loc(name: string): WebGLUniformLocation | null {
    let loc = this.locations.get(name);
    if (loc === undefined) {
      // Unused uniforms are optimized out and return null; setting them is then a harmless no-op.
      loc = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, loc);
    }
    return loc;
  }

  int(name: string, v: number): this {
    this.gl.uniform1i(this.loc(name), v);
    return this;
  }

  float(name: string, v: number): this {
    this.gl.uniform1f(this.loc(name), v);
    return this;
  }

  vec2(name: string, x: number, y: number): this {
    this.gl.uniform2f(this.loc(name), x, y);
    return this;
  }

  vec4(name: string, x: number, y: number, z: number, w: number): this {
    this.gl.uniform4f(this.loc(name), x, y, z, w);
    return this;
  }

  /** Uniform arrays (`uniform float x[N]`, `vec2 x[N]`, `vec4 x[N]`): pass the flattened components. */
  floats(name: string, v: Float32Array): this {
    if (v.length) this.gl.uniform1fv(this.loc(`${name}[0]`), v);
    return this;
  }

  vec2s(name: string, v: Float32Array): this {
    if (v.length) this.gl.uniform2fv(this.loc(`${name}[0]`), v);
    return this;
  }

  vec4s(name: string, v: Float32Array): this {
    if (v.length) this.gl.uniform4fv(this.loc(`${name}[0]`), v);
    return this;
  }

  vec3(name: string, v: readonly [number, number, number]): this {
    this.gl.uniform3f(this.loc(name), v[0], v[1], v[2]);
    return this;
  }
}
