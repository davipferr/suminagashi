import { drawFullscreen } from '../gl/context';
import { Program } from '../gl/program';
import { RenderTarget } from '../gl/target';
import type { MarbleOp, RasterBackend, Shape } from './marbling';
import rasterWarpFrag from '../gl/shaders/rasterWarp.frag?raw';
import rasterInitFrag from '../gl/shaders/rasterInit.frag?raw';

/** Ops combine at most this many symmetric copies, and combs at most this many tines (shader array sizes). */
const MAX_COPIES = 6;
const MAX_TINES = 12;

/** A flattened picture: an RGBA8 image of the ink (premultiplied), covering marbling x in [0, aspect]. */
interface Base {
  target: RenderTarget;
  aspect: number;
  refs: number;
}

/** A saved raster state (for undo and replay snapshots): its own copy of the map, a shared base. */
interface Saved {
  map: RenderTarget;
  base: Base;
  refs: number;
}

/** What `flatten` needs from the app: the current picture rendered into a new, larger image. */
export type Rasterize = (shapes: readonly Shape[]) => {
  base: RenderTarget;
  aspect: number;
  mapWidth: number;
  mapHeight: number;
};

/**
 * The part of the marbling that lives as an image instead of polygons.
 *
 * Combing multiplies the length of every ink outline with each pass; after enough passes the outlines hold
 * more points than the canvas has pixels and no polygon budget can keep up. At that point the picture is
 * flattened: rendered once into a base image (at 2x resolution), and the polygons are dropped. From then on
 * the ink isn't moved by moving points but by a coordinate map: for each canvas pixel, where its ink is in
 * the base image. Each op updates the map with the exact inverse of its warp (rasterWarp.frag), and the
 * picture is drawn by sampling the base image through the map once, so it stays sharp however much it's
 * stirred. New drops are polygons again, drawn on top, until the next flatten.
 */
export class RasterBath implements RasterBackend {
  private base: Base | null = null;
  /** Live coordinate map (RG32F) and its ping-pong partner. */
  private map: RenderTarget | null = null;
  private spare: RenderTarget | null = null;
  private readonly warpProgram: Program;
  private readonly initProgram: Program;
  private readonly rg32f;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly rasterize: Rasterize,
  ) {
    this.warpProgram = new Program(gl, rasterWarpFrag, 'rasterWarp.frag');
    this.initProgram = new Program(gl, rasterInitFrag, 'rasterInit.frag');
    this.rg32f = { internalFormat: gl.RG32F, format: gl.RG, type: gl.FLOAT };
  }

  get active(): boolean {
    return this.base !== null;
  }

  /** For drawing: the base image, the live map and the aspect the map was made at. */
  get view(): { base: RenderTarget; map: RenderTarget; aspect: number } | null {
    return this.base && this.map ? { base: this.base.target, map: this.map, aspect: this.base.aspect } : null;
  }

  private newMap(width: number, height: number): RenderTarget {
    return new RenderTarget(this.gl, width, height, this.rg32f, 'clamp', 'nearest');
  }

  private setMapSize(width: number, height: number): void {
    if (this.map?.width === width && this.map.height === height) return;
    this.map?.dispose();
    this.spare?.dispose();
    this.map = this.newMap(width, height);
    this.spare = this.newMap(width, height);
  }

  private dropBase(): void {
    if (this.base && --this.base.refs === 0) this.base.target.dispose();
    this.base = null;
  }

  flatten(shapes: readonly Shape[]): void {
    // Renders the current picture, including the current raster part, before replacing it.
    const r = this.rasterize(shapes);
    this.dropBase();
    this.base = { target: r.base, aspect: r.aspect, refs: 1 };
    this.setMapSize(r.mapWidth, r.mapHeight);
    this.map!.bind();
    this.initProgram.use();
    drawFullscreen(this.gl);
  }

  warp(op: MarbleOp): void {
    if (!this.base || !this.map || !this.spare) return;
    const p = this.warpProgram;
    const gl = this.gl;
    this.spare.bind();
    p.use().int('uMap', this.map.attach(0)).float('uAspect', this.base.aspect);
    if (op.op === 'drop' || op.op === 'grow') {
      const cs = op.cs.slice(0, MAX_COPIES);
      const centers = new Float32Array(cs.flatMap((c) => [c.x, c.y]));
      p.int('uKind', 0).int('uCount', cs.length).vec2s('uCenters', centers);
      p.float('uR2', op.op === 'drop' ? op.r * op.r : op.dr2);
    } else if (op.op === 'stroke') {
      const segs = op.segs.slice(0, MAX_COPIES);
      const tines = op.offsets.slice(0, MAX_TINES);
      p.int('uKind', 1).int('uCount', segs.length);
      p.vec4s('uSegs', new Float32Array(segs.flatMap((s) => [s.a.x, s.a.y, s.b.x, s.b.y])));
      p.floats('uOffsets', new Float32Array(tines)).int('uOffsetCount', tines.length).float('uLambda', op.lambda);
    } else {
      return;
    }
    drawFullscreen(gl);
    [this.map, this.spare] = [this.spare, this.map];
  }

  save(): unknown {
    if (!this.base || !this.map) return null;
    const copy = this.newMap(this.map.width, this.map.height);
    this.map.blitTo(copy, 'nearest');
    this.base.refs++;
    const saved: Saved = { map: copy, base: this.base, refs: 1 };
    return saved;
  }

  load(state: unknown): void {
    const s = state as Saved | null;
    if (!s) {
      this.clear();
      return;
    }
    s.base.refs++;
    this.dropBase();
    this.base = s.base;
    this.setMapSize(s.map.width, s.map.height);
    s.map.blitTo(this.map!, 'nearest');
  }

  retain(state: unknown): void {
    if (state) (state as Saved).refs++;
  }

  release(state: unknown): void {
    const s = state as Saved | null;
    if (!s || --s.refs > 0) return;
    s.map.dispose();
    if (--s.base.refs === 0) s.base.target.dispose();
  }

  clear(): void {
    this.dropBase();
    this.map?.dispose();
    this.spare?.dispose();
    this.map = this.spare = null;
  }
}
