import { drawFullscreen, type TargetFormat } from '../gl/context';
import { Program } from '../gl/program';
import type { RenderTarget } from '../gl/target';
import { Paper } from '../paper/paper';
import { PAPERS, type PaperName } from '../paper/presets';
import { srgbToLinear, type RGB } from '../color';
import type { Region } from '../export/framing';
import displayFrag from '../gl/shaders/display.frag?raw';

/** Display tweakables shared by the live view and exports. */
export interface Look {
  /** Strength of the dark rim where ink pools at the edge of a shape. */
  edge: number;
  paper: PaperName;
  /** Sheet color, sRGB 0..1. */
  paperColor: RGB;
  /** Overrides the paper preset's raking light. */
  relief?: number;
  /** Overrides the paper preset's absorbency. */
  absorb?: number;
}

/** Where to draw: the canvas (fbo null) or an offscreen target. */
export interface Surface {
  fbo: WebGLFramebuffer | null;
  width: number;
  height: number;
}

export const FULL_REGION: Region = { x: 0, y: 0, w: 1, h: 1 };

/** Final pass: paper seen through the ink (see display.frag). */
export class Display {
  private readonly program: Program;
  private readonly paper: Paper;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    format: TargetFormat,
  ) {
    this.program = new Program(gl, displayFrag, 'display.frag');
    this.paper = new Paper(gl, format);
  }

  draw(
    dye: RenderTarget,
    out: Surface,
    look: Look,
    options: { region?: Region; velocity?: RenderTarget; showVelocity?: boolean } = {},
  ): void {
    const gl = this.gl;
    const region = options.region ?? FULL_REGION;
    const preset = PAPERS[look.paper];
    // Re-bakes only when the paper kind or the needed tile resolution changes.
    this.paper.ensure(look.paper, out.height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, out.width, out.height);
    this.program
      .use()
      .int('uDye', dye.attach(0))
      .int('uVelocity', (options.velocity ?? dye).attach(1))
      .int('uPaperTex', this.paper.texture.attach(2))
      .vec2('uDyeTexel', 1 / dye.width, 1 / dye.height)
      .vec4('uDyeRegion', region.x, region.y, region.w, region.h)
      // One paper tile spans the output height.
      .vec2('uPaperScale', out.width / out.height, 1)
      .vec3('uPaper', srgbToLinear(look.paperColor))
      .float('uEdge', look.edge)
      .float('uRelief', look.relief ?? preset.relief)
      .float('uAbsorb', look.absorb ?? preset.absorb)
      .int('uView', options.showVelocity ? 1 : 0);
    drawFullscreen(gl);
  }
}
