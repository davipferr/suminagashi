import type { TargetFormat } from '../gl/context';
import { RenderTarget } from '../gl/target';
import { MarbleLayer } from '../marbling/layer';
import type { RasterBath } from '../marbling/raster';
import type { Shape } from '../marbling/marbling';
import { FULL_REGION, type Display, type Look } from '../render/display';
import type { RGB } from '../color';
import { framingRegion, marblingToSvg, type Framing } from './framing';

/** What to export: the water's dye field, or the marbling polygons (re-rasterized sharp at the export size). */
export type ExportSource =
  | { kind: 'water'; dye: RenderTarget; aspect: number }
  | { kind: 'marble'; shapes: readonly Shape[]; aspect: number; raster: RasterBath | null };

/** Lets the page repaint (status text) before a long synchronous render. Not rAF: that stalls in hidden tabs. */
const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

export class Exporter {
  private readonly rgba8: TargetFormat;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly format: TargetFormat,
    private readonly display: Display,
  ) {
    this.rgba8 = { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  }

  /** Largest width/height this GPU can render in one go. */
  get maxSize(): number {
    const gl = this.gl;
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, dims[0], dims[1]);
  }

  /** Renders the picture at width x height and encodes it as PNG. */
  async png(source: ExportSource, width: number, height: number, framing: Framing, look: Look): Promise<Blob> {
    if (Math.max(width, height) > this.maxSize) {
      throw new Error(`This GPU renders at most ${this.maxSize}px per side.`);
    }
    await yieldToBrowser();
    const pixels = this.render(source, width, height, framing, look);

    // WebGL rows start at the bottom; image rows start at the top.
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    ctx.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error('PNG encoding failed.');
    return blob;
  }

  /** The marbling as vector paths (flat colors, no paper texture). */
  svg(shapes: readonly Shape[], aspect: number, width: number, height: number, framing: Framing, paper: RGB): Blob {
    const region = framingRegion(aspect, width / height, framing);
    const text = marblingToSvg(shapes, aspect, region, width, height, paper);
    return new Blob([text], { type: 'image/svg+xml' });
  }

  private render(source: ExportSource, width: number, height: number, framing: Framing, look: Look): Uint8Array {
    const gl = this.gl;
    const region = framingRegion(source.aspect, width / height, framing);
    const out = new RenderTarget(gl, width, height, this.rgba8);
    try {
      if (source.kind === 'water') {
        this.display.draw(source.dye, out, look, { region });
      } else {
        // Re-rasterize the polygons at the export size so edges stay crisp, framed in the layer itself.
        const layer = new MarbleLayer(gl, this.format, width, height);
        try {
          layer.update(
            source.shapes,
            0,
            { x: region.x * source.aspect, y: region.y, scale: height / region.h, clipWidth: source.aspect },
            source.raster,
          );
          this.display.draw(layer.dye, out, look, { region: FULL_REGION });
        } finally {
          layer.dispose();
        }
      }
      const pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    } finally {
      out.dispose();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }
}

/**
 * Records the live canvas as WebM, at the on-screen size: for `until` seconds (a live-wallpaper clip),
 * or until the promise settles (e.g. a replay finishing). `onTick` gets the seconds left, or elapsed.
 */
export function recordVideo(
  canvas: HTMLCanvasElement,
  until: number | Promise<unknown>,
  onTick: (seconds: number) => void,
): Promise<Blob> {
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
  if (!type) return Promise.reject(new Error('This browser cannot record WebM video.'));

  const stream = canvas.captureStream(60);
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  return new Promise((resolve, reject) => {
    const countdown = typeof until === 'number';
    let s = countdown ? until : 0;
    const timer = setInterval(() => onTick(countdown ? --s : ++s), 1000);
    recorder.onstop = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: 'video/webm' }));
    };
    recorder.onerror = () => {
      clearInterval(timer);
      reject(new Error('Recording failed.'));
    };
    recorder.start();
    onTick(s);
    const stop = () => recorder.state !== 'inactive' && recorder.stop();
    if (countdown) setTimeout(stop, until * 1000);
    else until.finally(stop);
  });
}

/** Saves a blob through a temporary download link. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
