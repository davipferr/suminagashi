import { download, recordVideo, type Exporter, type ExportSource } from '../export/exporter';
import { EXPORT_SIZES, exportFilename, type Framing } from '../export/framing';
import type { Look } from '../render/display';
import { popover } from './popover';

const VIDEO_SECONDS = 5;

interface Options {
  exporter: Exporter;
  canvas: HTMLCanvasElement;
  look: Look;
  mode: () => 'water' | 'marble';
  screenSize: () => { width: number; height: number };
  /** The current picture (settles any drop that is still spreading). */
  source: () => ExportSource;
  /** Starts a replay of the current mode; resolves when it ends. Null if there's nothing to replay. */
  replay: () => Promise<void> | null;
  /** False once the marbling is partly raster ink (too detailed for vector paths). */
  vectorOk: () => boolean;
}

/** Wires the Export popover: size, framing, and PNG / SVG / video buttons. */
export function setupExportPanel(o: Options): void {
  const toggle = document.querySelector<HTMLButtonElement>('#export-toggle')!;
  const panel = document.querySelector<HTMLDivElement>('#export')!;
  const sizeSelect = document.querySelector<HTMLSelectElement>('#export-size')!;
  const framingSelect = document.querySelector<HTMLSelectElement>('#export-framing')!;
  const pngButton = document.querySelector<HTMLButtonElement>('#export-png')!;
  const svgButton = document.querySelector<HTMLButtonElement>('#export-svg')!;
  const videoButton = document.querySelector<HTMLButtonElement>('#export-video')!;
  const replayVideoButton = document.querySelector<HTMLButtonElement>('#export-replay')!;
  const status = document.querySelector<HTMLParagraphElement>('#export-status')!;
  const buttons = [pngButton, svgButton, videoButton, replayVideoButton];

  for (const s of EXPORT_SIZES) sizeSelect.add(new Option(s.label, s.id));

  function chosenSize(): { width: number; height: number } {
    const s = EXPORT_SIZES.find((x) => x.id === sizeSelect.value)!;
    return s.id === 'screen' ? o.screenSize() : s;
  }

  /** SVG only exists for marbling (the water is a field, not shapes). */
  function refresh(): void {
    const marble = o.mode() === 'marble';
    const vector = marble && o.vectorOk();
    svgButton.disabled = !vector;
    svgButton.title = !marble
      ? 'Only in Marble mode'
      : vector
        ? 'Vector paths, flat colors'
        : 'This picture got too detailed for vector paths (it was combed into pixel-fine lines); use PNG';
  }

  popover(toggle, panel, () => {
    refresh();
    status.textContent = '';
  });
  // Mode can change while the panel is open (keyboard shortcut).
  document.addEventListener('click', refresh);
  document.addEventListener('keyup', refresh);

  async function run(label: string, job: () => Promise<void>): Promise<void> {
    buttons.forEach((b) => (b.disabled = true));
    status.textContent = label;
    try {
      await job();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      console.error(err);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      refresh();
    }
  }

  pngButton.addEventListener('click', () => {
    const { width, height } = chosenSize();
    void run(`Rendering ${width}×${height}…`, async () => {
      const blob = await o.exporter.png(o.source(), width, height, framingSelect.value as Framing, o.look);
      download(blob, exportFilename(o.mode(), width, height, 'png'));
      status.textContent = `Saved ${width}×${height} PNG (${(blob.size / 1e6).toFixed(1)} MB).`;
    });
  });

  svgButton.addEventListener('click', () => {
    const { width, height } = chosenSize();
    void run('Writing SVG…', async () => {
      const src = o.source();
      if (src.kind !== 'marble') return;
      const blob = o.exporter.svg(src.shapes, src.aspect, width, height, framingSelect.value as Framing, o.look.paperColor);
      download(blob, exportFilename('marble', width, height, 'svg'));
      status.textContent = `Saved SVG (${(blob.size / 1e6).toFixed(1)} MB).`;
    });
  });

  videoButton.addEventListener('click', () => {
    void run('Recording…', async () => {
      const blob = await recordVideo(o.canvas, VIDEO_SECONDS, (left) => {
        status.textContent = `Recording… ${left}s — keep playing with the ink`;
      });
      download(blob, exportFilename(o.mode(), o.canvas.width, o.canvas.height, 'webm'));
      status.textContent = `Saved ${VIDEO_SECONDS}s WebM at screen size.`;
    });
  });

  replayVideoButton.addEventListener('click', () => {
    void run('Starting replay…', async () => {
      const finished = o.replay();
      if (!finished) throw new Error('Nothing to replay yet — make something first.');
      const blob = await recordVideo(o.canvas, finished, (s) => {
        status.textContent = `Recording the replay… ${s}s`;
      });
      download(blob, exportFilename(`${o.mode()}-replay`, o.canvas.width, o.canvas.height, 'webm'));
      status.textContent = 'Saved the replay as WebM.';
    });
  });
}
