import { PALETTES, PAPER_TONES, STYLE_PRESETS, extractPalette, imagePixels } from '../palettes';
import { PAPERS, type PaperName } from '../paper/presets';
import { SYMMETRIES } from '../input/symmetry';
import { DEFAULT_SETTINGS, RANGES, paletteColors, type Settings } from '../settings';
import { popover } from './popover';

type Mode = 'water' | 'marble' | 'ink';

interface SliderDef {
  key: keyof typeof RANGES;
  label: string;
  /** Only shown in these modes. */
  modes: readonly Mode[];
  format: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

const SLIDERS: readonly SliderDef[] = [
  { key: 'dropSize', label: 'Drop size', modes: ['water', 'marble'], format: pct },
  { key: 'edge', label: 'Ink rim', modes: ['water', 'marble'], format: pct },
  { key: 'swirl', label: 'Swirl', modes: ['water'], format: (v) => String(v) },
  { key: 'glide', label: 'Glide', modes: ['water'], format: (v) => `${Math.round(v * 100)}%/s` },
  { key: 'combSpacing', label: 'Comb gap', modes: ['marble'], format: (v) => `${Math.round(v * 1000) / 10}%` },
  { key: 'inkWidth', label: 'Pen width', modes: ['ink'], format: pct },
  { key: 'inkStabilizer', label: 'Stabilizer', modes: ['ink'], format: pct },
];

const PAPER_LABELS: Record<PaperName, string> = { washi: 'Washi', cotton: 'Cotton', smooth: 'Smooth' };

interface Options {
  settings: Settings;
  mode: () => Mode;
  /** Called after any change; the app applies and saves the settings. */
  onChange: () => void;
}

/** Tiny DOM helper: element + string properties (className, textContent, type, …) + children. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

/** Wires the Style popover: preset, palette & color, paper & tone, and a few sliders. */
export function setupStylePanel(o: Options): { refresh: () => void } {
  const s = o.settings;
  const toggle = document.querySelector<HTMLButtonElement>('#style-toggle')!;
  const panel = document.querySelector<HTMLDivElement>('#style')!;
  const presetSelect = document.querySelector<HTMLSelectElement>('#style-preset')!;
  const paletteSelect = document.querySelector<HTMLSelectElement>('#style-palette')!;
  const colorRow = document.querySelector<HTMLDivElement>('#style-colors')!;
  const paperRow = document.querySelector<HTMLDivElement>('#style-paper')!;
  const toneRow = document.querySelector<HTMLDivElement>('#style-tones')!;
  const symmetryRow = document.querySelector<HTMLDivElement>('#style-symmetry')!;
  const sliderBox = document.querySelector<HTMLDivElement>('#style-sliders')!;
  const photoInput = document.querySelector<HTMLInputElement>('#style-photo')!;
  const status = document.querySelector<HTMLParagraphElement>('#style-status')!;

  presetSelect.add(new Option('Custom', ''));
  for (const p of STYLE_PRESETS) presetSelect.add(new Option(p.label, p.id));

  const changed = () => {
    o.onChange();
    refresh();
  };

  presetSelect.addEventListener('change', () => {
    const p = STYLE_PRESETS.find((x) => x.id === presetSelect.value);
    if (!p) return;
    Object.assign(s, { palette: p.palette, paper: p.paper, tone: p.tone, swirl: p.swirl, glide: p.glide, color: 'cycle' });
    changed();
  });

  paletteSelect.addEventListener('change', () => {
    s.palette = paletteSelect.value;
    s.color = 'cycle';
    changed();
  });

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file) return;
    status.textContent = 'Reading colors…';
    try {
      const colors = extractPalette(await imagePixels(file), 5);
      if (colors.length === 0) throw new Error('No usable colors in that image.');
      s.customColors = colors;
      s.palette = 'custom';
      s.color = 'cycle';
      status.textContent = `Palette from ${file.name}`;
      changed();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : 'Could not read that image.';
    }
  });

  // Sliders are built once; refresh() syncs their values and visibility.
  const sliders = SLIDERS.map((def) => {
    const r = RANGES[def.key];
    const input = el('input', { type: 'range', min: String(r.min), max: String(r.max), step: String(r.step) });
    const output = el('output');
    const row = el('label', { className: 'slider' }, el('span', {}, def.label), input, output);
    input.addEventListener('input', () => {
      s[def.key] = Number(input.value);
      output.textContent = def.format(s[def.key]);
      o.onChange();
      syncPreset();
    });
    sliderBox.append(row);
    return { def, input, output, row };
  });

  document.querySelector('#style-reset')!.addEventListener('click', () => {
    Object.assign(s, { ...DEFAULT_SETTINGS, customColors: s.customColors });
    status.textContent = '';
    changed();
  });

  function syncPreset(): void {
    const match = STYLE_PRESETS.find(
      (p) => p.palette === s.palette && p.paper === s.paper && p.tone === s.tone && p.swirl === s.swirl && p.glide === s.glide,
    );
    presetSelect.value = match?.id ?? '';
  }

  function refresh(): void {
    syncPreset();

    paletteSelect.replaceChildren(...PALETTES.map((p) => new Option(p.label, p.id)));
    if (s.customColors.length) paletteSelect.add(new Option('From photo', 'custom'));
    paletteSelect.value = s.palette;

    const colors = paletteColors(s);
    const cycle = el('button', { className: 'chip', textContent: '↻ Cycle', title: 'Each drop takes the next color' });
    cycle.setAttribute('aria-pressed', String(s.color === 'cycle'));
    cycle.addEventListener('click', () => {
      s.color = 'cycle';
      changed();
    });
    const swatches = colors.map((c, i) => {
      const b = el('button', { className: 'swatch', title: `Always use ${c}` });
      b.style.background = c;
      b.setAttribute('aria-label', `Ink ${c}`);
      b.setAttribute('aria-pressed', String(s.color === i));
      b.addEventListener('click', () => {
        s.color = i;
        changed();
      });
      return b;
    });
    const photo = el('button', { className: 'chip', textContent: 'Photo…', title: 'Take a palette from an image' });
    photo.addEventListener('click', () => photoInput.click());
    colorRow.replaceChildren(cycle, ...swatches, photo);

    paperRow.replaceChildren(
      ...(Object.keys(PAPERS) as PaperName[]).map((name) => {
        const b = el('button', { textContent: PAPER_LABELS[name] });
        b.setAttribute('aria-pressed', String(s.paper === name));
        b.addEventListener('click', () => {
          s.paper = name;
          changed();
        });
        return b;
      }),
    );

    toneRow.replaceChildren(
      ...PAPER_TONES.map((t) => {
        const b = el('button', { className: 'swatch tone', title: t.label });
        b.style.background = t.color;
        b.setAttribute('aria-label', `${t.label} paper`);
        b.setAttribute('aria-pressed', String(s.tone === t.id));
        b.addEventListener('click', () => {
          s.tone = t.id;
          changed();
        });
        return b;
      }),
    );

    symmetryRow.replaceChildren(
      ...SYMMETRIES.map(({ id, label }) => {
        const b = el('button', { textContent: label });
        b.setAttribute('aria-pressed', String(s.symmetry === id));
        b.addEventListener('click', () => {
          s.symmetry = id;
          changed();
        });
        return b;
      }),
    );

    const mode = o.mode();
    for (const { def, input, output, row } of sliders) {
      input.value = String(s[def.key]);
      output.textContent = def.format(s[def.key]);
      row.hidden = !def.modes.includes(mode);
    }
  }

  popover(toggle, panel, refresh);
  refresh();
  return { refresh };
}
