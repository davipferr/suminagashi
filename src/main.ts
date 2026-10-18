import { createContext } from './gl/context';
import type { RenderTarget } from './gl/target';
import { Fluid } from './sim/fluid';
import { Marbling } from './marbling/marbling';
import { MarbleLayer } from './marbling/layer';
import { RasterBath } from './marbling/raster';
import { InkModel, type InkStroke } from './ink/ink';
import { inkReplayAt, inkTimeline, inkTimelineLength, type TimelineEntry } from './ink/replay';
import { InkLayer } from './ink/layer';
import { PENS, scaledPen, tunedPen, type PenName } from './ink/pen';
import { MarbleController, type MarbleTool } from './marbling/controller';
import { Display, type Look } from './render/display';
import { Exporter } from './export/exporter';
import { setupExportPanel } from './ui/exportPanel';
import { setupStylePanel } from './ui/stylePanel';
import { loadSettings, paletteColors, saveSettings, toneColor } from './settings';
import { strokePoints, type Point } from './input/stroke';
import { distinctCopies, symmetryCopies } from './input/symmetry';
import type { MarbleSnapshot } from './marbling/marbling';
import { bloomProgress } from './input/bloom';
import { hexToRgb, inkDensity, type RGB } from './color';
import './style.css';

/** Width of an ink stroke (drop radius while dragging), as a fraction of the canvas height; scaled by Drop size. */
const DROP_RADIUS = 0.03;
/** Final radius of a single drop after it has spread on the water; scaled by Drop size. */
const BLOOM_RADIUS = 0.08;
/** Seconds a drop takes to spread to full size. */
const BLOOM_TIME = 0.7;
/** Edge crispness of drops and strokes, 0 (soft) to 1 (razor). */
const DROP_HARDNESS = 0.75;
const STROKE_HARDNESS = 0.5;
/** The finger pushes a wider area of water than the ink it leaves. */
const FORCE_RADIUS = 0.05;
/**
 * Scales pointer speed into water speed. Force splats along a stroke overlap heavily
 * (spacing is half the drop radius), so each one carries only a fraction of the pointer speed.
 */
const STIR_GAIN = 0.25;
/**
 * Cap on the water speed a stroke can inject, in canvas heights per second. Past roughly this,
 * ink jumps many cells per step and tears into speckles instead of swirling.
 */
const MAX_STIR_SPEED = 1.5;
/** Largest simulation step; slower frames run the sim in slow motion instead of exploding. */
const MAX_DT = 1 / 30;
/** Replay speed: water sim frames per displayed frame; marbling time multiplier. */
const WATER_REPLAY_SPEED = 4;
const MARBLE_REPLAY_SPEED = 3;
/** Line art replays at this multiple of the drawing speed. */
const INK_REPLAY_SPEED = 2;
/** Pauses longer than this (seconds) between marbling gestures are cut short in a replay. */
const MARBLE_REPLAY_MAX_GAP = 0.4;
/** Water history is kept for this many sim frames (~20 min at 60 fps); beyond it, replay is off until Clear. */
const WATER_LOG_LIMIT = 72_000;

type Mode = 'water' | 'marble' | 'ink';
/** Ink mode's number keys: three pens, then three calligraphy brushes. */
const PEN_KEYS: readonly PenName[] = ['g', 'maru', 'white', 'sumi', 'qalam', 'broad'];
const MODES: readonly Mode[] = ['water', 'marble', 'ink'];

const HINTS: Record<Mode, string> = {
  water: 'drag to pour ink · shift-drag or right-drag to stir',
  marble: 'click or hold to drop ink · tine & comb drag through it · ctrl+z undo',
  ink: 'draw with a pen or mouse · pressure and speed shape the line · 4–6 calligraphy brushes · ctrl+z undo',
};

type Splat =
  | { kind: 'dye'; x: number; y: number; ink: RGB; r: number }
  | { kind: 'force'; x: number; y: number; vx: number; vy: number };

/** A new water drop; it blooms open to radius r over BLOOM_TIME. */
interface BloomSeed {
  x: number;
  y: number;
  ink: RGB;
  r: number;
}

/**
 * One water sim frame's inputs. Replaying these from a blank tank with the same dt reproduces the picture
 * (the sim is deterministic). Fluid settings are stored only when they change.
 */
interface WaterFrame {
  dt: number;
  splats?: Splat[];
  blooms?: BloomSeed[];
  fluid?: { curl: number; glide: number };
}

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const hint = document.querySelector<HTMLDivElement>('#hint')!;
const toolGroup = document.querySelector<HTMLDivElement>('#tools')!;
const inkTools = document.querySelector<HTMLDivElement>('#ink-tools')!;

function showError(message: string): void {
  const el = document.querySelector<HTMLDivElement>('#error')!;
  el.textContent = message;
  el.hidden = false;
}

function start(): void {
  const { gl, format } = createContext(canvas);
  const displayPass = new Display(gl, format);

  function canvasPixels(): { width: number; height: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return {
      width: Math.max(1, Math.round(canvas.clientWidth * dpr)),
      height: Math.max(1, Math.round(canvas.clientHeight * dpr)),
    };
  }

  let size = canvasPixels();
  canvas.width = size.width;
  canvas.height = size.height;
  const fluid = new Fluid(gl, format, size.width, size.height);
  const marbling = new Marbling();
  marbling.aspect = size.width / size.height;
  const marbleLayer = new MarbleLayer(gl, format, size.width, size.height);
  // Raster fallback for over-detailed marbling. Its coordinate map is RG32F, which needs float render targets.
  const raster = gl.getExtension('EXT_color_buffer_float')
    ? new RasterBath(gl, (shapes) => {
        // Flatten at twice the canvas resolution, so the base image stays crisp as it gets stirred further.
        const h = Math.min(4096, size.height * 2);
        const w = Math.min(4096, Math.round((h * size.width) / size.height));
        const layer = new MarbleLayer(gl, format, w, h);
        const base = layer.renderColor(shapes, { x: 0, y: 0, scale: h }, raster);
        layer.dispose();
        return { base, aspect: w / h, mapWidth: size.width, mapHeight: size.height };
      })
    : null;
  marbling.raster = raster;
  const ink = new InkModel();
  let pen: PenName = 'g';
  const inkLayer = new InkLayer(gl, format, size.width, size.height);

  function resize(): void {
    size = canvasPixels();
    if (canvas.width === size.width && canvas.height === size.height) return;
    // A replay can't survive the grids changing size under it.
    stopReplay();
    canvas.width = size.width;
    canvas.height = size.height;
    fluid.resize(size.width, size.height);
    marbleLayer.resize(size.width, size.height);
    inkLayer.resize(size.width, size.height);
    marbling.aspect = size.width / size.height;
  }
  new ResizeObserver(resize).observe(canvas);
  // ResizeObserver misses devicePixelRatio changes (browser zoom, moving to another monitor).
  const watchDpr = () =>
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        resize();
        watchDpr();
      },
      { once: true },
    );
  watchDpr();

  const settings = loadSettings();
  const look: Look = { edge: settings.edge, paper: settings.paper, paperColor: hexToRgb(toneColor(settings)) };
  const nextInkDot = document.querySelector<HTMLSpanElement>('#next-ink')!;

  // --- colors: each new drop or stroke takes the next palette color, unless one is pinned ---
  /** sRGB colors of the active palette, and the same as ink densities (what the water's dye stores). */
  let colors: RGB[] = [];
  let inks: RGB[] = [];
  let paletteKey = '';
  let colorIndex = -1;

  const peekColor = () =>
    settings.color === 'cycle' ? (colorIndex + 1) % colors.length : Math.min(settings.color, colors.length - 1);
  function pickColor(): number {
    const i = peekColor();
    if (settings.color === 'cycle') colorIndex = i;
    nextInkDot.style.background = paletteColors(settings)[peekColor()];
    return i;
  }

  const marble = new MarbleController(marbling, () => colors[pickColor()]);

  /** Pushes the Style settings into the sim, the marbling and the display, and saves them. */
  function applySettings(): void {
    const hex = paletteColors(settings);
    if (hex.join() !== paletteKey) {
      paletteKey = hex.join();
      colors = hex.map(hexToRgb);
      inks = colors.map(inkDensity);
      colorIndex = -1;
    }
    look.edge = settings.edge;
    look.paper = settings.paper;
    look.paperColor = hexToRgb(toneColor(settings));
    document.documentElement.style.setProperty('--paper', toneColor(settings));
    fluid.settings.curl = settings.swirl;
    fluid.settings.velocityKeepPerSecond = settings.glide;
    marble.settings.dropScale = settings.dropSize;
    marble.settings.combSpacing = settings.combSpacing;
    marble.settings.symmetry = settings.symmetry;
    ink.setStabilizer(settings.inkStabilizer);
    nextInkDot.style.background = hex[peekColor()];
    saveSettings(settings);
  }
  applySettings();
  let stylePanel: { refresh: () => void } | null = null;

  // --- mode & tool switching ---
  let mode: Mode = 'water';

  function setMode(next: Mode): void {
    stopReplay();
    mode = next;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    }
    toolGroup.hidden = mode !== 'marble';
    inkTools.hidden = mode !== 'ink';
    stylePanel?.refresh();
    hint.textContent = HINTS[mode];
    hint.classList.remove('gone');
  }

  function setPen(next: PenName): void {
    pen = next;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pen]')) {
      b.setAttribute('aria-pressed', String(b.dataset.pen === next));
    }
  }

  function setTool(next: MarbleTool): void {
    marble.tool = next;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      b.setAttribute('aria-pressed', String(b.dataset.tool === next));
    }
  }

  function clear(): void {
    stopReplay();
    if (mode === 'water') {
      fluid.clear();
      pending.length = 0;
      newBlooms.length = 0;
      blooms.length = 0;
      // A clear tank is a fresh start for the water history.
      waterLog.length = 0;
      waterLogFull = false;
      loggedFluid = '';
    } else if (mode === 'ink') {
      ink.cancel();
      ink.clear();
    } else {
      marble.settle();
      marbling.clear();
    }
  }

  function undo(): void {
    if (replay) return;
    if (mode === 'ink') {
      ink.cancel();
      ink.undo();
      return;
    }
    if (mode !== 'marble') return;
    marble.settle();
    marbling.undo();
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    b.addEventListener('click', () => setMode(b.dataset.mode as Mode));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    b.addEventListener('click', () => setTool(b.dataset.tool as MarbleTool));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pen]')) {
    b.addEventListener('click', () => setPen(b.dataset.pen as PenName));
  }
  document.querySelector('#undo')!.addEventListener('click', undo);
  document.querySelector('#ink-undo')!.addEventListener('click', undo);
  document.querySelector('#clear')!.addEventListener('click', clear);
  const replayButton = document.querySelector<HTMLButtonElement>('#replay')!;
  replayButton.addEventListener('click', () => (replay ? stopReplay() : void startReplay()));

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tools: Record<string, MarbleTool> = { '1': 'drop', '2': 'tine', '3': 'comb' };
    if (e.key === 'm') setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    else if (e.key === 'r') replayButton.click();
    else if (tools[e.key] && mode === 'marble') setTool(tools[e.key]);
    else if (mode === 'ink' && /^[1-6]$/.test(e.key)) setPen(PEN_KEYS[+e.key - 1]);
  });

  // --- water history & replay state (declared before the first setMode/clear can touch them) ---
  const waterLog: WaterFrame[] = [];
  let waterLogFull = false;
  /** Fluid settings last written to the log, to store them only on change. */
  let loggedFluid = '';
  let replay: {
    mode: Mode;
    /** Next log entry to play. */
    index: number;
    /** Marbling replay clock. */
    t: number;
    marbleSnapshot: MarbleSnapshot | null;
    /** Ink: what's being replayed, its timeline, and the stand-in model the layer draws meanwhile. */
    ink?: { strokes: readonly InkStroke[]; timeline: TimelineEntry[]; view: InkModel; prefixes: (readonly InkStroke[])[] };
    done: () => void;
  } | null = null;

  setMode('water');
  setTool('drop');
  setPen('g');

  // --- water input ---
  // Drag pours ink and pushes the water; shift-drag or right-drag only stirs.
  const pending: Splat[] = [];
  /** Drops landed since the last sim frame. */
  const newBlooms: BloomSeed[] = [];
  /** Drops still spreading; re-splatted each frame at a growing radius. */
  const blooms: (BloomSeed & { age: number })[] = [];

  /**
   * Symmetric copies for water input. Water UV isn't isotropic, so points go through x * aspect
   * (and back) to keep rotations round; directions likewise.
   */
  function waterCopies(...at: Point[]): ((p: Point, v?: Point) => { p: Point; v: Point })[] {
    const a = size.width / size.height;
    const iso = at.map((p) => ({ x: p.x * a, y: p.y }));
    const copies = distinctCopies(symmetryCopies(settings.symmetry, { x: a / 2, y: 0.5 }), ...iso);
    return copies.map((t) => (p, v = { x: 0, y: 0 }) => {
      const q = t.point({ x: p.x * a, y: p.y });
      const w = t.dir({ x: v.x * a, y: v.y });
      return { p: { x: q.x / a, y: q.y }, v: { x: w.x / a, y: w.y } };
    });
  }
  let dragging = false;
  let inking = false;
  /** Ink of the current water stroke. */
  let strokeInk: RGB = [0, 0, 0];
  let last: Point = { x: 0, y: 0 };
  let lastTime = 0;

  /** Water coordinates: UV, y up. */
  function toUv(e: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: 1 - (e.clientY - rect.top) / rect.height };
  }

  /** Pen pressure, or null when the device has none (mouse, most touch screens). */
  const pressureOf = (e: PointerEvent) => (e.pointerType === 'pen' ? Math.max(e.pressure, 0.01) : null);

  /** Marbling (and ink) coordinates: canvas heights, y down. */
  function toMarble(e: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.height, y: (e.clientY - rect.top) / rect.height };
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    // A click during a replay just stops it (and puts the finished picture back).
    if (replay) {
      stopReplay();
      return;
    }
    // Capture can be refused (e.g. the pointer is already gone); drawing works without it.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* keep going */
    }
    dragging = true;
    hint.classList.add('gone');
    if (mode === 'ink') {
      if (e.button === 0) {
        const tuning = { ink: settings.brushInk, bleed: settings.brushBleed, angle: settings.nibAngle };
        ink.begin(toMarble(e), e.timeStamp / 1000, pressureOf(e), tunedPen(scaledPen(PENS[pen], settings.inkWidth), tuning));
      }
      return;
    }
    if (mode === 'marble') {
      marble.down(toMarble(e));
      return;
    }
    inking = e.button === 0 && !e.shiftKey;
    last = toUv(e);
    lastTime = e.timeStamp;
    if (inking) {
      strokeInk = inks[pickColor()];
      const r = BLOOM_RADIUS * settings.dropSize;
      for (const copy of waterCopies(last)) newBlooms.push({ ...copy(last).p, ink: strokeInk, r });
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (mode === 'ink') {
      // A pen reports far more samples than frames (often 240 Hz); the browser coalesces them into one
      // event per frame. Use all of them, or quick flicks come out as polylines.
      // Some browsers (and synthetic events) give an empty list: then the event itself is the only sample.
      const coalesced = e.getCoalescedEvents?.() ?? [];
      for (const c of coalesced.length ? coalesced : [e]) ink.add(toMarble(c), c.timeStamp / 1000, pressureOf(c));
      return;
    }
    if (mode === 'marble') {
      marble.move(toMarble(e));
      return;
    }
    const p = toUv(e);
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const elapsed = Math.min(Math.max((e.timeStamp - lastTime) / 1000, 1 / 240), 0.1);
    let vx = ((p.x - last.x) / elapsed) * STIR_GAIN;
    let vy = ((p.y - last.y) / elapsed) * STIR_GAIN;
    const speed = Math.hypot(vx * aspect, vy);
    if (speed > MAX_STIR_SPEED) {
      vx *= MAX_STIR_SPEED / speed;
      vy *= MAX_STIR_SPEED / speed;
    }
    const r = DROP_RADIUS * settings.dropSize;
    const copies = waterCopies(last, p);
    for (const q of strokePoints(last, p, aspect, r * 0.5)) {
      for (const copy of copies) {
        const c = copy(q, { x: vx, y: vy });
        pending.push({ kind: 'force', ...c.p, vx: c.v.x, vy: c.v.y });
        if (inking) pending.push({ kind: 'dye', ...c.p, ink: strokeInk, r });
      }
    }
    last = p;
    lastTime = e.timeStamp;
  });

  const stop = (e: PointerEvent) => {
    dragging = false;
    marble.up();
    ink.end(e.timeStamp / 1000);
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  // --- frame loop ---
  let view = 0;

  function display(dye: RenderTarget): void {
    displayPass.draw(dye, { fbo: null, ...size }, look, {
      velocity: fluid.velocityField,
      showVelocity: mode === 'water' && view === 1,
    });
  }

  /** One water sim frame with the given inputs (live, or from the log during a replay). */
  function stepWater(frame: WaterFrame): void {
    if (frame.fluid) {
      fluid.settings.curl = frame.fluid.curl;
      fluid.settings.velocityKeepPerSecond = frame.fluid.glide;
    }
    for (const s of frame.splats ?? []) {
      if (s.kind === 'dye') fluid.addDye(s.x, s.y, s.ink, s.r, STROKE_HARDNESS);
      else fluid.addForce(s.x, s.y, s.vx, s.vy, FORCE_RADIUS);
    }
    for (const b of frame.blooms ?? []) blooms.push({ ...b, age: 0 });
    for (let i = blooms.length - 1; i >= 0; i--) {
      const b = blooms[i];
      b.age += frame.dt;
      fluid.addDye(b.x, b.y, b.ink, b.r * bloomProgress(b.age, BLOOM_TIME), DROP_HARDNESS);
      if (b.age >= BLOOM_TIME) blooms.splice(i, 1);
    }
    fluid.step(frame.dt);
  }

  /** Live water frame: gathers this frame's input, logs it, runs it. */
  function liveWater(dt: number): void {
    const frame: WaterFrame = { dt };
    if (pending.length) frame.splats = pending.splice(0);
    if (newBlooms.length) frame.blooms = newBlooms.splice(0);
    const fluidKey = settings.swirl + '/' + settings.glide;
    if (fluidKey !== loggedFluid) {
      loggedFluid = fluidKey;
      frame.fluid = { curl: settings.swirl, glide: settings.glide };
    }
    if (waterLog.length < WATER_LOG_LIMIT) waterLog.push(frame);
    else waterLogFull = true;
    stepWater(frame);
  }

  // --- replay: rebuild the current mode's picture from blank, as a time-lapse ---
  const canReplay = () =>
    mode === 'ink'
      ? ink.strokes.length > 0
      : mode === 'water'
        ? !waterLogFull && waterLog.some((f) => f.splats || f.blooms)
        : marbling.log.length > 0;

  /** Starts a replay of the current mode; resolves when it ends (finished or stopped). */
  function startReplay(): Promise<void> | null {
    stopReplay();
    if (!canReplay()) return null;
    marble.settle();
    dragging = false;
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    if (mode === 'ink') {
      // The drawing itself is untouched: the replay draws a stand-in model that grows stroke by stroke.
      ink.cancel();
      const strokes = ink.strokes;
      const prefixes: (readonly InkStroke[])[] = strokes.map((_, i) => strokes.slice(0, i));
      prefixes.push(strokes);
      replay = { mode, index: 0, t: 0, marbleSnapshot: null, done, ink: { strokes, timeline: inkTimeline(strokes), view: new InkModel(), prefixes } };
    } else if (mode === 'water') {
      fluid.snapshot();
      fluid.clear();
      pending.length = 0;
      newBlooms.length = 0;
      blooms.length = 0;
      replay = { mode, index: 0, t: 0, marbleSnapshot: null, done };
    } else {
      const marbleSnapshot = marbling.snapshot();
      marbling.reset();
      marbling.recording = false;
      replay = { mode, index: 0, t: marbling.log[0].t, marbleSnapshot, done };
    }
    replayButton.textContent = 'Stop';
    hint.textContent = 'replaying… click anywhere to stop';
    hint.classList.remove('gone');
    return finished;
  }

  /** Ends a replay, putting back the exact picture it started from. */
  function stopReplay(): void {
    const r = replay;
    if (!r) return;
    replay = null;
    if (r.mode === 'ink') {
      // Nothing to restore: the real drawing was never touched; the layer re-syncs to it next frame.
    } else if (r.mode === 'water') {
      fluid.restoreSnapshot();
      blooms.length = 0;
      // The log may have switched fluid settings; go back to the current ones.
      fluid.settings.curl = settings.swirl;
      fluid.settings.velocityKeepPerSecond = settings.glide;
    } else {
      marbling.restore(r.marbleSnapshot!);
      marbling.recording = true;
    }
    replayButton.textContent = 'Replay';
    hint.textContent = HINTS[mode];
    hint.classList.add('gone');
    r.done();
  }

  function advanceReplay(dt: number): void {
    const r = replay!;
    if (r.mode === 'ink' && r.ink) {
      const { strokes, timeline, view, prefixes } = r.ink;
      r.t += dt * INK_REPLAY_SPEED;
      const at = inkReplayAt(strokes, timeline, r.t);
      // Reuse the same prefix arrays, so the layer only draws strokes as they're finished.
      view.strokes = prefixes[at.done];
      view.current = at.partial;
      view.liveVersion++;
      if (r.t >= inkTimelineLength(timeline) + 0.3) stopReplay();
      return;
    }
    if (r.mode === 'water') {
      for (let k = 0; k < WATER_REPLAY_SPEED && r.index < waterLog.length; k++) stepWater(waterLog[r.index++]);
      if (r.index >= waterLog.length) stopReplay();
      return;
    }
    const log = marbling.log;
    r.t += dt * MARBLE_REPLAY_SPEED;
    if (r.index < log.length) r.t = Math.max(r.t, log[r.index].t - MARBLE_REPLAY_MAX_GAP);
    while (r.index < log.length && log[r.index].t <= r.t) marbling.execute(log[r.index++].op);
    if (r.index >= log.length) stopReplay();
  }

  let previous = performance.now();
  function tick(dt: number): void {
    if (replay) advanceReplay(dt);
    // Only the visible mode runs; the other one keeps its state, paused.
    if (mode === 'ink') {
      // A brush resting on the paper keeps soaking in. (Event timestamps share performance.now()'s clock.)
      if (!replay) ink.hold(performance.now() / 1000);
      inkLayer.sync(replay?.ink ? replay.ink.view : ink, displayPass.paperFor(look, size.height));
      display(inkLayer.dye);
    } else if (mode === 'water') {
      if (!replay) liveWater(dt);
      display(fluid.dye);
    } else {
      if (!replay) {
        marbling.clock += dt;
        marble.update(dt);
      }
      marbleLayer.update(marbling.shapes, marbling.version, undefined, raster);
      display(marbleLayer.dye);
    }
    replayButton.disabled = !replay && !canReplay();
  }

  function frame(now: number): void {
    tick(Math.min((now - previous) / 1000, MAX_DT));
    previous = now;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // --- panels ---
  stylePanel = setupStylePanel({ settings, mode: () => mode, onChange: applySettings });

  const exporter = new Exporter(gl, format, displayPass);
  setupExportPanel({
    exporter,
    canvas,
    look,
    mode: () => mode,
    screenSize: () => size,
    replay: startReplay,
    source: () =>
      mode === 'ink'
        ? (ink.end(), { kind: 'ink', strokes: ink.strokes, aspect: size.width / size.height })
        : mode === 'water'
        ? { kind: 'water', dye: fluid.dye, aspect: size.width / size.height }
        : (marble.settle(), { kind: 'marble', shapes: marbling.shapes, aspect: size.width / size.height, raster }),
    vectorOk: () => !marbling.rasterized,
  });

  if (import.meta.env.DEV) {
    // Dev hooks for poking the simulation from the console.
    Object.assign(window, {
      __dbg: {
        drop: (x: number, y: number, i = 0) =>
          newBlooms.push({ x, y, ink: inks[i % inks.length], r: BLOOM_RADIUS * settings.dropSize }),
        push: (x: number, y: number, vx: number, vy: number) => pending.push({ kind: 'force', x, y, vx, vy }),
        view: (name: 'ink' | 'velocity') => (view = name === 'velocity' ? 1 : 0),
        mode: setMode,
        /** Runs frames by hand, e.g. when rAF is paused in a hidden tab. */
        tick: (frames = 1, dt = 1 / 60) => {
          for (let i = 0; i < frames; i++) tick(dt);
        },
        fluid,
        marbling,
        raster,
        ink,
        marble,
        look,
        settings,
        applySettings,
        exporter,
        replay: {
          start: startReplay,
          stop: stopReplay,
          get active() {
            return replay !== null;
          },
          waterLog,
        },
        info: () => ({
          canvas: size,
          sim: fluid.simSize,
          dye: fluid.dyeSize,
          shapes: marbling.shapes.length,
          points: marbling.pointCount,
        }),
      },
    });
  }
}

try {
  start();
} catch (err) {
  console.error(err);
  showError(err instanceof Error ? err.message : String(err));
}
