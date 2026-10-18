# Suminagashi

Drop ink on water and watch it bloom and swirl, then export the result as a wallpaper.
Two engines: a GPU fluid simulation (ink drifting in water) and a mathematical marbling mode
(Ebru / Suminagashi, after Aubrey Jaffer's marbling equations) with vector export.

Stack: TypeScript + Vite + raw WebGL2/GLSL. No runtime dependencies.

## Run

```bash
npm install
npm run dev
```

`npm test` runs the unit tests, `npm run build` type-checks and builds to `dist/`.

**Deploy:** `.github/workflows/ci.yml` tests, builds and publishes `dist/` to GitHub Pages on every push to `main`
(set the repository's *Settings → Pages → Source* to *GitHub Actions* once). `base: './'` in `vite.config.ts` makes
the build work under any sub-path.

**Controls** (toolbar at the top; `M` switches mode, each mode keeps its own picture):

- **Water** — click to drop ink (it blooms open), drag to pour a stroke; shift-drag or right-drag to stir without ink.
- **Marble** — `1` Drop: click for a drop, hold for a bigger one (it keeps pushing older ink outward into rings).
  `2` Tine: drag a stylus through the ink. `3` Comb: drag seven styluses at once. `Ctrl+Z` undoes a whole gesture.

Each drop or stroke takes the next palette color (the dot on **Style** shows which). **Style** picks the look and
symmetry, **Replay** (`R`) rebuilds the current picture from blank as a time-lapse, **Export** saves it.

## How it's built

- `src/gl/` — WebGL2 context, fullscreen-pass programs, render targets.
  Every simulation field is a `DoubleTarget` (ping-pong): a pass samples `read`, renders into `write`, then swaps,
  because a texture can't be read and written in the same draw.
- All targets are RGBA16F (needs `EXT_color_buffer_float` or `EXT_color_buffer_half_float`):
  velocity and pressure are signed, and ink needs more than 8 bits to fade smoothly.
- Fullscreen passes draw one oversized triangle generated from `gl_VertexID`; there are no vertex buffers.

### The fluid (`src/sim/fluid.ts`)

GPU "Stable Fluids" (Stam 1999) in a closed tank. Velocity lives on a coarse grid (256 cells on the short side),
ink on a fine one (1024), both stretched to the canvas aspect. Each frame:

1. **Splats** — pointer strokes add ink (`splat.frag`) and push the water (`force.frag`).
2. **Curl + vorticity confinement** — re-inject spin where eddies are, so ink curls instead of blurring.
3. **Projection** — divergence → ~25 Jacobi pressure iterations (warm-started from last frame's pressure)
   → subtract the pressure gradient. Water stays incompressible; walls mirror velocity so nothing leaks out.
4. **Advection** — semi-Lagrangian (trace each texel back along the velocity) for velocity. Ink uses
   **MacCormack** (`maccormack.frag`): advect forward, advect back, add half the round-trip error, clamp to the
   source neighborhood. Plain advection blurs a little every frame and ink turns to fog; this keeps filaments crisp.

Velocity is in sim cells per second. Stroke speed is capped (`MAX_STIR_SPEED`); faster flicks move ink many
cells per step and tear it into speckles.

### The ink look

- **Subtractive color.** The dye field stores optical density per channel (`rgb`) plus coverage (`a`), not color.
  Display is Beer–Lambert: `paper × exp(−density)`, in linear light, then sRGB-encoded. A palette color is converted
  so a full-strength layer on white paper shows exactly that color (`inkDensity` in `color.ts`). Mixed inks get
  darker and richer (indigo + vermilion → violet), never a muddy average.
- **Edge darkening.** Where a texel has more ink than its neighborhood, density is boosted — the thin dark rim
  pigment forms at the edge of a shape.
- **Blooming drops.** A click lands as a small bead that spreads to full size with an ease-out (`input/bloom.ts`).
- **Tuning.** Vorticity 8 (≈25 looks like smoke: hairy, ragged edges), velocity keeps 75 %/s so strokes glide and
  draw shapes out into bands, ink keeps 99.8 %/s so a piece holds still for export.

### Paper (`src/paper/`)

Both modes are printed on a procedural, seamlessly tiling sheet. One tile spans the canvas height and its
resolution follows it (512–2048, `paperTileSize`), with all dimensions defined as fractions of the tile, so the paper
looks the same at screen size and at wallpaper-export size.

- **Fibers & specks** — Canvas 2D draws curved strands (red channel) and bark specks (green), each at all 9 wrap
  offsets so strands crossing an edge continue on the other side. Seeded PRNG (`random.ts`): same seed, same sheet.
- **Bake** (`paper.frag`, once per paper/size change) — adds periodic value-noise fBm for pulp mottling and surface
  tooth, per-texel grain, and outputs `r` brightness offset, `gb` surface slope, `a` absorbency.
- **Display** — the sheet color is modulated by brightness and a raking light from the upper left on the slope;
  ink density is scaled by absorbency (cloudy pulp drinks more, fibers resist and show through as pale wisps);
  the sRGB output gets ±½-step dither against banding in soft washes.
- **Presets** (`presets.ts`): `washi` (long kozo fibers, specks, cloudy pulp — default), `cotton` (cold-press tooth),
  `smooth` (near-flat). Fibers are kept low-relief on purpose: raised 1-px strands catch a shadow and read as
  dark scratches.

### Marbling (`src/marbling/`)

Mathematical marbling after Aubrey Jaffer. Ink is a stack of closed polygons; every tool is a continuous map of the
plane applied to every vertex (`geometry.ts`). Coordinates are canvas heights, y down.

- **Drop** at `c`, radius `r`: `P → c + (P − c)·√(1 + r²/|P − c|²)`. Area-preserving and exactly opens a disc of
  radius `r`, so older ink is stretched into rings rather than covered. Drops compose (r² adds), so a held drop
  grows in small per-frame steps with an ease-out (`controller.ts`).
- **Tine / comb**: a stylus moved `a → b` drags each point along the motion by `|ab|·λ/(d + λ)·w`, `d` = distance
  across to the nearest stylus line, `w` = 1 alongside the segment easing to 0 just past its ends. Ink under the
  stylus travels with it; ink further away lags behind — that lag draws feathers and chevrons. It's a shear (points
  move only along the stroke) and the ease-out is wide enough relative to the step that the map can never fold ink
  over itself. Tine/comb motion is collected from pointer events and applied once per frame.
- **Symmetric copies** of an op are composed into one warp, so the picture is walked once per frame, not per copy.

### Keeping marbling fast (combing multiplies detail)

Every op warps every point, and each comb pass multiplies the length of every ink outline. A few full passes
used to freeze the page (`pointermove` / `requestAnimationFrame` handlers of 0.5–6 s). What keeps it bounded:

- **Adaptive outlines** (`warpPolygon`): an edge is split where the warped curve bends away from it by more than
  ~0.3 px (chord error), or where it's longer than `maxLen`; never below ~1 px (`minLen`, so tine cusps can't recurse
  forever). Points sitting on a straight line are removed. Off-screen, tolerances are 8× coarser.
- **Flat storage**: polygons are `Float64Array`s `[x0, y0, …]` and warps write into a reused scratch point. One JS object
  per point per frame made garbage collection the bottleneck (50–100 ms pauses).
- **GPU fill** (`layer.ts`, `fan.ts`): polygons are filled with stencil-then-cover (exact nonzero winding for any
  self-overlapping outline), 4× MSAA. A plain triangle fan over a polygon folded across the canvas overdraws every pixel
  hundreds of times, so outlines are fanned hierarchically: runs of 32 vertices fanned locally, joined by a skeleton
  polygon filled the same way, recursively — winding numbers add, so the result is exact. (Canvas 2D took 0.5 s+ per
  frame on heavily combed shapes.)
- **Point budget**: past 40k points fine detail gets coarser; the budget scales by 1/√copies under symmetry.
- **Raster fallback** (`raster.ts`): past 70k points the outlines hold more detail than the canvas has pixels, so the
  picture is *flattened*: rendered once into a base image at 2× resolution and the polygons dropped. From then on ink
  moves through a **coordinate map** (RG32F, one texel per canvas pixel: where this pixel's ink is in the base image).
  Each op updates it with the exact inverse of its warp — the drop inverts in closed form, the fold-free tine with a
  few Newton steps (`rasterWarp.frag`) — and the picture samples the base once through the map, so it stays sharp
  however long it's stirred. New drops are polygons on top until the next flatten. Checked against the polygon path:
  flatten, strokes and drops agree to within edge antialiasing. Undo keeps a map copy per step (depth 6 while
  rasterized); replay re-flattens at the same op. SVG export is off for a rasterized picture.

Result (Intel Iris Xe, 690×846 canvas, 10 full comb passes with fast pointer input): `pointermove` < 1 ms, frames
~0–20 ms CPU, one ~100–200 ms hitch at the moment of flattening.

### Style (`src/palettes.ts`, `src/settings.ts`, `src/ui/stylePanel.ts`)

- **Presets** set palette + paper + tone + how the water moves in one go (Classic suminagashi, Ottoman ebru,
  Indigo tide, Autumn maple, Ink study, Neon pop). Touching any control switches the preset menu to "Custom".
- **Ink palettes** (7), with *Cycle* (each drop takes the next color) or a pinned swatch.
  **Photo…** builds a palette from an image: downscaled to ≤96 px, near-white and transparent pixels dropped,
  seeded k-means++ (k = 5), sorted darkest first. Never uploaded anywhere.
- **Paper**: washi / cotton / smooth, and four light tones (ink is subtractive, so the sheet must be light).
- **Sliders**: drop size and ink rim (both modes); swirl and glide (water); comb gap (marble).
- Settings persist in `localStorage` (`suminagashi.settings.v1`), validated and clamped on load (`sanitize`), and
  are ignored if storage is unavailable.

### Symmetry (`src/input/symmetry.ts`)

Off, mirror, 4-way or radial (6-fold). Every gesture is repeated into copies around the canvas center: points by
an affine map, directions (stroke velocity, stylus motion) by its linear part. Coordinates must be isotropic for
rotations to stay round, so water UV is scaled by the aspect on the way in and out. Copies that land on top of each
other — a drop at the center, a stroke along a mirror line — are skipped (`distinctCopies`), or they'd stack.
Marbling stays exactly symmetric; the water starts symmetric and, being turbulent, slowly drifts out of it.

### Replay

Both modes keep a history from blank, and replaying it reproduces the picture **bit-exactly** (checked:
0 difference in the replayed ink field / identical polygons):

- **Water** logs each sim frame's inputs: `dt`, the splats (with their own radius, so later slider changes don't
  alter the past), new drops, and swirl/glide whenever they change. The sim is deterministic, so the same inputs
  from a cleared tank give the same field. Replay runs 4 sim frames per screen frame. The log is capped at ~20 min
  of water time; Clear starts a fresh one.
- **Marbling** logs every model op as data (`drop`, `grow`, `stroke`, `checkpoint`, `undo`, `clear`) stamped with
  marbling time; replay re-executes them at 3× with pauses longer than 0.4 s cut short.
- The live state is snapshotted first (`Fluid.snapshot` blits velocity/pressure/ink; marbling keeps shapes and undo
  stack), so stopping a replay early — click anywhere, `R`, or switching mode — puts the finished picture back.
- **Export → Replay video** records the replay to WebM, stopping when it ends.

### Export (`src/export/`, `src/ui/exportPanel.ts`)

- **Sizes**: screen, phone 1170×2532, 2560×1440, 4K, ultrawide 3440×1440, square 2048². Capped by the GPU's
  `MAX_TEXTURE_SIZE` / `MAX_VIEWPORT_DIMS`.
- **Framing** (`framingRegion`): *Fill* crops the picture (centered) to the wallpaper's shape; *Fit* shows all of it
  and extends the paper into margins. The region is a rectangle in picture UV, so the same math frames both modes.
- **PNG** — rendered offscreen into an RGBA8 target through the same `Display` pass as the screen (paper, edge
  darkening, dither all included), read back, flipped (GL rows start at the bottom) and encoded. Marble mode
  re-rasterizes the polygons at the export size, so edges stay crisp at 4K; water mode upsamples the dye field.
  The paper tile is re-baked for the export height. A 4K PNG is ~10 MB: the paper grain is per-pixel noise.
- **SVG** (marble only) — one `<path>` per ink shape in marbling units, viewBox = framing region, clipped to the
  original picture. Flat colors on the paper color; texture and ink shading are raster-only.
- **Video** — `MediaRecorder` on `canvas.captureStream()`, WebM (VP9 when available), at screen size: a 5 s clip
  (keep stirring while it records), or the whole replay.

Dev console: `__dbg.drop(x, y, colorIndex)`, `__dbg.push(x, y, vx, vy)`, `__dbg.view('velocity' | 'ink')`, `__dbg.info()`,
`__dbg.fluid.settings` (live sim settings), `__dbg.look.edge`, `__dbg.mode('water' | 'marble')`,
`__dbg.marbling` (shapes, `apply(warp)`, `undo()`), `__dbg.marble` (gesture controller: `down/move/up`),
`__dbg.settings` + `__dbg.applySettings()` (everything the Style panel sets), `__dbg.look.relief` / `.absorb`
(optional overrides of the paper preset),
`__dbg.tick(frames)` (advance frames by hand — rAF pauses in hidden tabs),
`__dbg.exporter.png(source, w, h, framing, look)` (returns the Blob without downloading),
`__dbg.replay.start() / .stop() / .active`.

## Status

- [x] WebGL2 core, ping-pong targets, ink drops
- [x] Fluid simulation (advection, pressure solve, vorticity)
- [x] Tune the ink look (subtractive color, MacCormack, edge darkening, blooming drops)
- [x] Marbling mode (drops, tines, combs as polygons; undo)
- [x] Paper texture and display shading (washi / cotton / smooth, relief light, absorbency, dither)
- [x] Wallpaper export (hi-res PNG, SVG, WebM; fill/fit framing)
- [x] Palettes, presets, UI (Style panel, photo palettes, paper tones, persisted settings)
- [x] Extras: symmetry, bit-exact replay (+ replay video), GitHub Pages CI
