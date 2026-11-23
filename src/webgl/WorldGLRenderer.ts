import { getBiomeDef } from '../engine/biomes';
import { computeCellWorldThrustDir } from '../engine/softBodyPhysics';
import { TissueType, WorldState } from '../types/morphogenesis';
import { ParticleTFPass } from './ParticleTFPass';
import {
  ATP_GLYPH_FRAG,
  ATP_GLYPH_VERT,
  CELL_INSTANCED_FRAG,
  CELL_INSTANCED_VERT,
  CHEM_DIFFUSE_FRAG,
  FLAGELLA_INSTANCED_VERT,
  GLOW_POINT_FRAG,
  GLOW_POINT_VERT,
  LINE_FRAG,
  LINE_VERT,
  QUAD_VERT,
  WORLD_BG_FRAG,
} from './WorldGpuShaders';
import {
  RenderTargetFBO,
  createFullscreenQuadVAO,
  createProgram,
  createRGBA8Texture,
  createRenderTarget,
} from './glUtils';

const ATP_GLYPH_W = 6.8;
const ATP_GLYPH_H = 9.2;
const ATP_GLYPH_ADV = 8.4;

/**
 * Pure WebGL2 World Ecosystem Renderer:
 * 1. GPU Ping-Pong Chemical Diffusion FBO (`160x100`)
 * 2. Fullscreen Procedural Biome + Volumetric Sunlight + Battle Containment Wall
 * 3. WebGL2 Transform Feedback Ambient Micro-Current Spores (`ParticleTFPass`)
 * 4. GPU-Instanced Soft-Body Cell Quads (tissue LUT & faction tinting in GLSL)
 * 5. Chitin Spikes, Spring Topology & Faction Perimeter Line Pass
 * 6. GPU-Instanced Flagella Sinusoidal Whips + Rear Thrust Vector Arrows
 * 7. Food Pellets, Photosynthetic Flora, Sensor Receptors & Pixel-Art Mating Hearts
 * 8. GPU-Instanced Faint Alpha-Blended ATP % Overlay (replaces dynamic HTML DOM roster)
 */
export class WorldGLRenderer {
  private gl: WebGL2RenderingContext;
  private diffuseProg: WebGLProgram;
  private bgProg: WebGLProgram;
  private cellProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private flagellaProg: WebGLProgram;
  private pointProg: WebGLProgram;
  private atpProg: WebGLProgram;
  private particleTF: ParticleTFPass;

  private quadVAO: WebGLVertexArrayObject;
  private quadVBO: WebGLBuffer;
  private unitQuadVBO: WebGLBuffer;

  private chemRawTex: WebGLTexture;
  private chemBytes: Uint8Array;
  private chemFboA: RenderTargetFBO;
  private chemFboB: RenderTargetFBO;
  private chemPing = false;
  private chemCols = 0;
  private chemRows = 0;

  // Instanced cell buffer: 13 floats per cell
  private cellVAO: WebGLVertexArrayObject;
  private cellInstVBO: WebGLBuffer;
  private cellInstData = new Float32Array(7000 * 13);

  // Line topology buffer (boundary membranes, springs, spikes, gradient vectors)
  private lineVAO: WebGLVertexArrayObject;
  private lineVBO: WebGLBuffer;
  private lineData = new Float32Array(14000 * 6);

  // Instanced flagella buffer: 9 floats per active flagellum
  private flagellaVAO: WebGLVertexArrayObject;
  private flagInstVBO: WebGLBuffer;
  private flagInstData = new Float32Array(3000 * 9);

  // Pellets, sensor eyes, and pixel hearts
  private pointVAO: WebGLVertexArrayObject;
  private pointVBO: WebGLBuffer;
  private pointData = new Float32Array(1536 * 8);

  // Instanced ATP % glyph overlay buffer: 9 floats per digit glyph
  private atpVAO: WebGLVertexArrayObject;
  private atpInstVBO: WebGLBuffer;
  private atpInstData = new Float32Array(512 * 9);

  private sunZonesData = new Float32Array(12);
  private lastTimeSec = 0;

  // Cached uniform locations
  private uDiffRawChem: WebGLUniformLocation | null;
  private uDiffPrevChem: WebGLUniformLocation | null;
  private uDiffTexel: WebGLUniformLocation | null;

  private uBgChemTex: WebGLUniformLocation | null;
  private uBgWorldSize: WebGLUniformLocation | null;
  private uBgShowChem: WebGLUniformLocation | null;
  private uBgTime: WebGLUniformLocation | null;
  private uBgShaderStyle: WebGLUniformLocation | null;
  private uBgInner: WebGLUniformLocation | null;
  private uBgOuter: WebGLUniformLocation | null;
  private uBgSunTint: WebGLUniformLocation | null;
  private uBgSunLevel: WebGLUniformLocation | null;
  private uBgSunZones: WebGLUniformLocation | null;
  private uBgBattleEnabled: WebGLUniformLocation | null;
  private uBgBarrierActive: WebGLUniformLocation | null;
  private uBgBarrierX: WebGLUniformLocation | null;
  private uBgBarrierHp: WebGLUniformLocation | null;

  private uCellWorldSize: WebGLUniformLocation | null;
  private uLineWorldSize: WebGLUniformLocation | null;
  private uFlagWorldSize: WebGLUniformLocation | null;
  private uPointWorldSize: WebGLUniformLocation | null;
  private uPointDpr: WebGLUniformLocation | null;
  private uAtpWorldSize: WebGLUniformLocation | null;

  constructor(
    gl: WebGL2RenderingContext,
    chemCols: number,
    chemRows: number,
    worldWidth = 1600,
    worldHeight = 1000,
  ) {
    this.gl = gl;
    this.chemCols = chemCols;
    this.chemRows = chemRows;

    this.diffuseProg = createProgram(gl, QUAD_VERT, CHEM_DIFFUSE_FRAG);
    this.bgProg = createProgram(gl, QUAD_VERT, WORLD_BG_FRAG);
    this.cellProg = createProgram(gl, CELL_INSTANCED_VERT, CELL_INSTANCED_FRAG);
    this.lineProg = createProgram(gl, LINE_VERT, LINE_FRAG);
    this.flagellaProg = createProgram(gl, FLAGELLA_INSTANCED_VERT, LINE_FRAG);
    this.pointProg = createProgram(gl, GLOW_POINT_VERT, GLOW_POINT_FRAG);
    this.atpProg = createProgram(gl, ATP_GLYPH_VERT, ATP_GLYPH_FRAG);
    this.particleTF = new ParticleTFPass(gl, worldWidth, worldHeight);

    this.uDiffRawChem = gl.getUniformLocation(this.diffuseProg, 'uRawChem');
    this.uDiffPrevChem = gl.getUniformLocation(this.diffuseProg, 'uPrevChem');
    this.uDiffTexel = gl.getUniformLocation(this.diffuseProg, 'uTexel');

    this.uBgChemTex = gl.getUniformLocation(this.bgProg, 'uChemTex');
    this.uBgWorldSize = gl.getUniformLocation(this.bgProg, 'uWorldSize');
    this.uBgShowChem = gl.getUniformLocation(this.bgProg, 'uShowChem');
    this.uBgTime = gl.getUniformLocation(this.bgProg, 'uTime');
    this.uBgShaderStyle = gl.getUniformLocation(this.bgProg, 'uShaderStyle');
    this.uBgInner = gl.getUniformLocation(this.bgProg, 'uBgInner');
    this.uBgOuter = gl.getUniformLocation(this.bgProg, 'uBgOuter');
    this.uBgSunTint = gl.getUniformLocation(this.bgProg, 'uSunTint');
    this.uBgSunLevel = gl.getUniformLocation(this.bgProg, 'uSunLevel');
    this.uBgSunZones = gl.getUniformLocation(this.bgProg, 'uSunZones');
    this.uBgBattleEnabled = gl.getUniformLocation(this.bgProg, 'uBattleEnabled');
    this.uBgBarrierActive = gl.getUniformLocation(this.bgProg, 'uBarrierActive');
    this.uBgBarrierX = gl.getUniformLocation(this.bgProg, 'uBarrierX');
    this.uBgBarrierHp = gl.getUniformLocation(this.bgProg, 'uBarrierHp');

    this.uCellWorldSize = gl.getUniformLocation(this.cellProg, 'uWorldSize');
    this.uLineWorldSize = gl.getUniformLocation(this.lineProg, 'uWorldSize');
    this.uFlagWorldSize = gl.getUniformLocation(this.flagellaProg, 'uWorldSize');
    this.uPointWorldSize = gl.getUniformLocation(this.pointProg, 'uWorldSize');
    this.uPointDpr = gl.getUniformLocation(this.pointProg, 'uDpr');
    this.uAtpWorldSize = gl.getUniformLocation(this.atpProg, 'uWorldSize');

    const quad = createFullscreenQuadVAO(gl);
    this.quadVAO = quad.vao;
    this.quadVBO = quad.vbo;

    // Shared [0,1]^2 unit quad TRIANGLE_STRIP VBO
    this.unitQuadVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    this.chemBytes = new Uint8Array(chemCols * chemRows * 4);
    this.chemRawTex = createRGBA8Texture(gl, chemCols, chemRows, gl.LINEAR, null);
    this.chemFboA = createRenderTarget(gl, chemCols, chemRows, gl.LINEAR);
    this.chemFboB = createRenderTarget(gl, chemCols, chemRows, gl.LINEAR);

    // Instanced Cell VAO
    this.cellVAO = gl.createVertexArray()!;
    this.cellInstVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.cellVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellInstVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.cellInstData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 52, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 52, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 52, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 52, 48);
    gl.vertexAttribDivisor(4, 1);

    // Line VAO
    this.lineVAO = gl.createVertexArray()!;
    this.lineVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);

    // Instanced Flagella VAO
    this.flagellaVAO = gl.createVertexArray()!;
    this.flagInstVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.flagellaVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flagInstVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.flagInstData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 36, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 36, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 36, 32);
    gl.vertexAttribDivisor(2, 1);

    // Glow Points VAO
    this.pointVAO = gl.createVertexArray()!;
    this.pointVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.pointVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.pointData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 32, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 32, 28);

    // Instanced ATP % Overlay VAO
    this.atpVAO = gl.createVertexArray()!;
    this.atpInstVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.atpVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.atpInstVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.atpInstData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 36, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 36, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 36, 20);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);
  }

  private ensureCellCapacity(floatsNeeded: number): void {
    if (floatsNeeded <= this.cellInstData.length) return;
    const next = new Float32Array(Math.ceil(floatsNeeded * 1.5));
    next.set(this.cellInstData);
    this.cellInstData = next;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.cellInstVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.cellInstData.byteLength, this.gl.DYNAMIC_DRAW);
  }

  private ensureLineCapacity(floatsNeeded: number): void {
    if (floatsNeeded <= this.lineData.length) return;
    const next = new Float32Array(Math.ceil(floatsNeeded * 1.5));
    next.set(this.lineData);
    this.lineData = next;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.lineVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.lineData.byteLength, this.gl.DYNAMIC_DRAW);
  }

  private ensureFlagellaCapacity(floatsNeeded: number): void {
    if (floatsNeeded <= this.flagInstData.length) return;
    const next = new Float32Array(Math.ceil(floatsNeeded * 1.5));
    next.set(this.flagInstData);
    this.flagInstData = next;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.flagInstVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.flagInstData.byteLength, this.gl.DYNAMIC_DRAW);
  }

  private ensurePointCapacity(floatsNeeded: number): void {
    if (floatsNeeded <= this.pointData.length) return;
    const next = new Float32Array(Math.ceil(floatsNeeded * 1.5));
    next.set(this.pointData);
    this.pointData = next;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.pointVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.pointData.byteLength, this.gl.DYNAMIC_DRAW);
  }

  private ensureAtpCapacity(floatsNeeded: number): void {
    if (floatsNeeded <= this.atpInstData.length) return;
    const next = new Float32Array(Math.ceil(floatsNeeded * 1.5));
    next.set(this.atpInstData);
    this.atpInstData = next;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.atpInstVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.atpInstData.byteLength, this.gl.DYNAMIC_DRAW);
  }

  render(
    world: WorldState,
    options: {
      selectedOrgId: number | null;
      showChemFields: boolean;
      showGradientArrows: boolean;
      showPhysicsMesh: boolean;
      sunlightLevel: number;
      dpr: number;
      timeSec: number;
      paused?: boolean;
    },
  ): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const targetW = Math.round(world.width * options.dpr);
    const targetH = Math.round(world.height * options.dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const dt = this.lastTimeSec > 0 ? Math.min(0.05, Math.max(0.001, options.timeSec - this.lastTimeSec)) : 0.016;
    this.lastTimeSec = options.timeSec;
    const biome = getBiomeDef(world.biomeId);

    // 1. GPU Ping-Pong Chemical Diffusion FBO
    if (options.showChemFields) {
      const len = this.chemCols * this.chemRows;
      const food = world.foodField;
      const scent = world.scentField;
      const toxin = world.toxinField;
      const bytes = this.chemBytes;
      for (let i = 0; i < len; i++) {
        const o = i * 4;
        bytes[o] = Math.min(255, Math.max(0, (food[i] * 255) | 0));
        bytes[o + 1] = Math.min(255, Math.max(0, (scent[i] * 255) | 0));
        bytes[o + 2] = Math.min(255, Math.max(0, (toxin[i] * 255) | 0));
        bytes[o + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.chemRawTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.chemCols, this.chemRows, gl.RGBA, gl.UNSIGNED_BYTE, bytes);

      const srcFbo = this.chemPing ? this.chemFboA : this.chemFboB;
      const dstFbo = this.chemPing ? this.chemFboB : this.chemFboA;
      this.chemPing = !this.chemPing;

      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo.fbo);
      gl.viewport(0, 0, this.chemCols, this.chemRows);
      gl.disable(gl.BLEND);
      gl.useProgram(this.diffuseProg);
      gl.bindVertexArray(this.quadVAO);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.chemRawTex);
      gl.uniform1i(this.uDiffRawChem, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex);
      gl.uniform1i(this.uDiffPrevChem, 1);
      gl.uniform2f(this.uDiffTexel, 1 / this.chemCols, 1 / this.chemRows);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    const activeChemTex = (this.chemPing ? this.chemFboA : this.chemFboB).tex;

    // 2. Fullscreen Biome Fluid Backdrop + Sunlight Rays + Chemical Plumes + Battle Wall
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.bgProg);
    gl.bindVertexArray(this.quadVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, activeChemTex);
    gl.uniform1i(this.uBgChemTex, 0);
    gl.uniform2f(this.uBgWorldSize, world.width, world.height);
    gl.uniform1f(this.uBgShowChem, options.showChemFields ? 1.0 : 0.0);
    gl.uniform1f(this.uBgTime, options.timeSec);
    gl.uniform1f(this.uBgShaderStyle, biome.shaderStyle);
    gl.uniform3f(this.uBgInner, biome.bgInnerRgb[0], biome.bgInnerRgb[1], biome.bgInnerRgb[2]);
    gl.uniform3f(this.uBgOuter, biome.bgOuterRgb[0], biome.bgOuterRgb[1], biome.bgOuterRgb[2]);
    gl.uniform3f(this.uBgSunTint, biome.sunTintRgb[0], biome.sunTintRgb[1], biome.sunTintRgb[2]);
    gl.uniform1f(this.uBgSunLevel, biome.ambientSunlight * options.sunlightLevel);

    const szData = this.sunZonesData;
    szData.fill(0);
    for (let i = 0; i < 3; i++) {
      const sz = world.sunZones[i];
      if (sz) {
        szData[i * 4] = sz.x;
        szData[i * 4 + 1] = sz.y;
        szData[i * 4 + 2] = sz.radius;
        szData[i * 4 + 3] = sz.intensity;
      }
    }
    gl.uniform4fv(this.uBgSunZones, szData);
    gl.uniform1f(this.uBgBattleEnabled, world.battle.enabled ? 1.0 : 0.0);
    gl.uniform1f(this.uBgBarrierActive, world.battle.barrierActive ? 1.0 : 0.0);
    gl.uniform1f(this.uBgBarrierX, world.battle.barrierX);
    gl.uniform1f(
      this.uBgBarrierHp,
      world.battle.barrierMaxHealth > 0 ? world.battle.barrierHealth / world.battle.barrierMaxHealth : 0,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // 3. GPU Transform Feedback Suspended Biome Motes
    this.particleTF.stepAndRender(
      world.width,
      world.height,
      biome.currentX,
      biome.currentY,
      options.paused ? 0 : dt,
      options.dpr,
      biome.sunTintRgb,
    );

    // 4. Pack Lightweight Instanced Cell, Flagella, Line, Point & ATP Overlay Buffers
    let cellFloats = 0;
    let lineFloats = 0;
    let flagFloats = 0;
    let pointFloats = 0;
    let atpFloats = 0;

    const pushLine = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number) => {
      this.ensureLineCapacity(lineFloats + 12);
      const d = this.lineData;
      d[lineFloats++] = x0; d[lineFloats++] = y0; d[lineFloats++] = r; d[lineFloats++] = g; d[lineFloats++] = b; d[lineFloats++] = a;
      d[lineFloats++] = x1; d[lineFloats++] = y1; d[lineFloats++] = r; d[lineFloats++] = g; d[lineFloats++] = b; d[lineFloats++] = a;
    };

    const pushPoint = (x: number, y: number, size: number, r: number, g: number, b: number, a: number, kind: number) => {
      this.ensurePointCapacity(pointFloats + 8);
      const d = this.pointData;
      d[pointFloats++] = x; d[pointFloats++] = y; d[pointFloats++] = size;
      d[pointFloats++] = r; d[pointFloats++] = g; d[pointFloats++] = b; d[pointFloats++] = a;
      d[pointFloats++] = kind;
    };

    const pushCircleLines = (cx: number, cy: number, rad: number, steps: number, r: number, g: number, b: number, a: number) => {
      for (let k = 0; k < steps; k++) {
        const a0 = (k / steps) * Math.PI * 2;
        const a1 = ((k + 1) / steps) * Math.PI * 2;
        pushLine(cx + Math.cos(a0) * rad, cy + Math.sin(a0) * rad, cx + Math.cos(a1) * rad, cy + Math.sin(a1) * rad, r, g, b, a);
      }
    };

    if (options.showGradientArrows) {
      const cw = world.width / world.chemCols;
      const ch = world.height / world.chemRows;
      for (let gy = 2; gy < world.chemRows - 2; gy += 4) {
        for (let gx = 2; gx < world.chemCols - 2; gx += 4) {
          const idx = gy * world.chemCols + gx;
          const dx = world.foodField[idx + 1] - world.foodField[idx - 1];
          const dy = world.foodField[idx + world.chemCols] - world.foodField[idx - world.chemCols];
          const mag = Math.hypot(dx, dy);
          if (mag < 0.008) continue;
          const cx = (gx + 0.5) * cw;
          const cy = (gy + 0.5) * ch;
          const scale = Math.min(18, mag * 140);
          pushLine(cx, cy, cx + (dx / mag) * scale, cy + (dy / mag) * scale, 0.204, 0.827, 0.6, 0.48);
        }
      }
    }

    for (let i = 0; i < world.pellets.length; i++) {
      const p = world.pellets[i];
      pushPoint(
        p.x,
        p.y,
        p.radius * 3.5 * Math.max(0.45, Math.min(1.15, p.amount)),
        p.isPhotosynthetic ? 0.52 : 0.063,
        p.isPhotosynthetic ? 0.92 : 0.725,
        p.isPhotosynthetic ? 0.32 : 0.506,
        0.94,
        p.isPhotosynthetic ? 0.5 : 0.0,
      );
    }

    const battleActive = world.battle.enabled;
    for (let oi = 0; oi < world.organisms.length; oi++) {
      const org = world.organisms[oi];
      const verts = org.mesh.vertices;
      const cells = org.mesh.cells;
      const isSelected = org.id === options.selectedOrgId;
      const dmg = org.damageFlash;
      const faction = org.faction;
      const baseAlpha = Math.max(0.48, 0.72 + org.energyReserve * 0.0028);
      const effAlpha = battleActive && faction === 'neutral' ? Math.max(0.42, baseAlpha * 0.8) : baseAlpha;
      const factionMode = !battleActive ? 0 : faction === 'player' ? 1 : faction === 'ai' ? 2 : 3;

      this.ensureCellCapacity(cellFloats + cells.length * 13);
      const cd = this.cellInstData;

      for (let ci = 0; ci < cells.length; ci++) {
        const cell = cells[ci];
        const vTL = verts[cell.vTL];
        const vTR = verts[cell.vTR];
        const vBR = verts[cell.vBR];
        const vBL = verts[cell.vBL];

        const musclePulse = cell.tissue === TissueType.MUSCLE ? Math.max(0, -cell.activation * 0.85) : 0;
        cd[cellFloats++] = vTL.x;
        cd[cellFloats++] = vTL.y;
        cd[cellFloats++] = vTR.x;
        cd[cellFloats++] = vTR.y;
        cd[cellFloats++] = vBR.x;
        cd[cellFloats++] = vBR.y;
        cd[cellFloats++] = vBL.x;
        cd[cellFloats++] = vBL.y;
        cd[cellFloats++] = cell.tissue;
        cd[cellFloats++] = factionMode;
        cd[cellFloats++] = effAlpha;
        cd[cellFloats++] = dmg;
        cd[cellFloats++] = musclePulse;

        if (cell.sensorWeight > 0.2) {
          const sx = (vTL.x + vTR.x + vBR.x + vBL.x) * 0.25;
          const sy = (vTL.y + vTR.y + vBR.y + vBL.y) * 0.25;
          pushPoint(sx, sy, 5.2, 0.745, 0.949, 0.392, 0.95, 1.0);
          if (Math.hypot(cell.gradientX, cell.gradientY) > 0.03) {
            pushLine(sx, sy, sx + cell.gradientX * 24, sy + cell.gradientY * 24, 0.639, 0.902, 0.208, 0.55);
          }
        }

        if (cell.spikeWeight > 0.15 || cell.tissue === TissueType.SPIKE) {
          const cx = (vTL.x + vTR.x + vBR.x + vBL.x) * 0.25;
          const cy = (vTL.y + vTR.y + vBR.y + vBL.y) * 0.25;
          const odx = cx - org.mesh.comX;
          const ody = cy - org.mesh.comY;
          const oLen = Math.hypot(odx, ody);
          const nx = oLen > 1e-4 ? odx / oLen : Math.cos(org.mesh.headingAngle);
          const ny = oLen > 1e-4 ? ody / oLen : Math.sin(org.mesh.headingAngle);
          const px = -ny;
          const py = nx;
          const armed = org.neuralNet.isAggressive;
          const barbReach = armed ? org.mesh.cellSize * (2.25 + org.neuralNet.aggressionOut * 0.55) : org.mesh.cellSize * 1.1;
          const tipX = cx + nx * barbReach;
          const tipY = cy + ny * barbReach;
          const baseHalf = org.mesh.cellSize * (armed ? 0.48 : 0.34);
          const sr = armed ? 0.99 : 0.68;
          const sg = armed ? 0.42 : 0.72;
          const sb = armed ? 0.56 : 0.82;
          const sa = armed ? 0.96 : 0.58;
          pushLine(cx + px * baseHalf, cy + py * baseHalf, tipX, tipY, sr, sg, sb, sa);
          pushLine(cx - px * baseHalf, cy - py * baseHalf, tipX, tipY, sr, sg, sb, sa);
        }

        if (cell.flagellaWeight > 0.15) {
          const isBraking = cell.thrustDotForward < -0.15;
          const throttle = isBraking ? org.neuralNet.brakeOut : org.neuralNet.cruiseOut;
          if (throttle > 0.03 || isSelected) {
            const cx = (vTL.x + vTR.x + vBR.x + vBL.x) * 0.25;
            const cy = (vTL.y + vTR.y + vBR.y + vBL.y) * 0.25;
            const worldThrust = computeCellWorldThrustDir(
              cell,
              verts,
              org.mesh.headingAngle,
              org.steerBias,
              org.musclePhaseTime,
            );
            this.ensureFlagellaCapacity(flagFloats + 9);
            const fd = this.flagInstData;
            fd[flagFloats++] = cx;
            fd[flagFloats++] = cy;
            fd[flagFloats++] = worldThrust.fxDir;
            fd[flagFloats++] = worldThrust.fyDir;
            fd[flagFloats++] = 10 + cell.flagellaWeight * (6 + throttle * 12);
            fd[flagFloats++] = org.musclePhaseTime * (1.2 + throttle * 3.1) + cell.gx * 0.8;
            fd[flagFloats++] = Math.min(0.95, 0.26 + throttle * 0.7);
            fd[flagFloats++] = isBraking ? 1.0 : 0.0;
            fd[flagFloats++] = throttle > 0.06 || isSelected ? 1.0 : 0.0;
          }
        }
      }

      if (options.showPhysicsMesh) {
        const springs = org.mesh.springs;
        for (let si = 0; si < springs.length; si++) {
          const sp = springs[si];
          const a = verts[sp.v0];
          const b = verts[sp.v1];
          if (sp.isMuscle) pushLine(a.x, a.y, b.x, b.y, 0.957, 0.447, 0.714, 0.9);
          else pushLine(a.x, a.y, b.x, b.y, 0.58, 0.639, 0.722, 0.28);
        }
      }

      const bEdges = org.mesh.boundaryEdges;
      let mr = isSelected ? 0.133 : 0.886;
      let mg = isSelected ? 0.827 : 0.91;
      let mb = isSelected ? 0.933 : 0.941;
      let ma = isSelected ? 0.95 : 0.35;
      if (battleActive) {
        if (faction === 'player') { mr = 0.22; mg = 0.92; mb = 1.0; ma = 0.94; }
        else if (faction === 'ai') { mr = 1.0; mg = 0.3; mb = 0.38; ma = 0.94; }
        else { mr = 0.9; mg = 0.78; mb = 0.4; ma = 0.75; }
      }
      for (let ei = 0; ei < bEdges.length; ei++) {
        const [va, vb] = bEdges[ei];
        pushLine(verts[va].x, verts[va].y, verts[vb].x, verts[vb].y, mr, mg, mb, ma);
      }

      if (battleActive) {
        const cx = org.mesh.comX;
        const cy = org.mesh.comY;
        const hr = org.mesh.boundRadius + 4.5;
        if (faction === 'player') {
          pushCircleLines(cx, cy, hr, 24, 0.18, 0.9, 1.0, 0.68);
        } else if (faction === 'ai') {
          pushCircleLines(cx, cy, hr, 20, 1.0, 0.28, 0.36, 0.72);
          const dr = org.mesh.boundRadius + 8.5;
          pushLine(cx, cy - dr, cx + dr, cy, 1.0, 0.34, 0.42, 0.65);
          pushLine(cx + dr, cy, cx, cy + dr, 1.0, 0.34, 0.42, 0.65);
          pushLine(cx, cy + dr, cx - dr, cy, 1.0, 0.34, 0.42, 0.65);
          pushLine(cx - dr, cy, cx, cy - dr, 1.0, 0.34, 0.42, 0.65);
        } else {
          pushCircleLines(cx, cy, hr, 8, 0.88, 0.76, 0.38, 0.55);
        }
      }

      if (org.mood === 'amorous' && !isSelected) {
        pushCircleLines(org.mesh.comX, org.mesh.comY, org.mesh.boundRadius + 5, 18, 0.98, 0.45, 0.62, 0.36);
      }
      if (isSelected) {
        pushCircleLines(org.mesh.comX, org.mesh.comY, org.mesh.boundRadius + 11, 28, 0.133, 0.827, 0.933, 0.9);
      }

      // Faint Alpha-Blended ATP % Overlay rendered directly over organism in WebGL2
      const atpInt = Math.max(0, Math.min(100, Math.round(org.energyReserve)));
      const dCount = atpInt >= 100 ? 4 : atpInt >= 10 ? 3 : 2;
      const totalWidth = (dCount - 1) * ATP_GLYPH_ADV + ATP_GLYPH_W;
      const startX = org.mesh.comX - totalWidth * 0.5;
      const startY = org.mesh.comY - ATP_GLYPH_H * 0.5;

      let ar = 0.86, ag = 0.96, ab = 0.92;
      let aa = isSelected ? 0.66 : atpInt < 25 ? 0.52 : 0.38;
      if (atpInt < 25) {
        ar = 0.99; ag = 0.48; ab = 0.54;
      } else if (battleActive) {
        if (faction === 'player') { ar = 0.54; ag = 0.94; ab = 1.0; }
        else if (faction === 'ai') { ar = 1.0; ag = 0.52; ab = 0.58; aa = Math.max(0.32, aa * 0.88); }
      }

      this.ensureAtpCapacity(atpFloats + dCount * 9);
      const ad = this.atpInstData;
      const pushGlyph = (slotIdx: number, glyphId: number) => {
        ad[atpFloats++] = startX + slotIdx * ATP_GLYPH_ADV;
        ad[atpFloats++] = startY;
        ad[atpFloats++] = ATP_GLYPH_W;
        ad[atpFloats++] = ATP_GLYPH_H;
        ad[atpFloats++] = glyphId;
        ad[atpFloats++] = ar;
        ad[atpFloats++] = ag;
        ad[atpFloats++] = ab;
        ad[atpFloats++] = aa;
      };

      if (atpInt >= 100) {
        pushGlyph(0, 1);
        pushGlyph(1, 0);
        pushGlyph(2, 0);
        pushGlyph(3, 10);
      } else if (atpInt >= 10) {
        pushGlyph(0, (atpInt / 10) | 0);
        pushGlyph(1, atpInt % 10);
        pushGlyph(2, 10);
      } else {
        pushGlyph(0, atpInt);
        pushGlyph(1, 10);
      }
    }

    for (let i = 0; i < world.hearts.length; i++) {
      const h = world.hearts[i];
      const lifeRatio = 1 - h.age / h.maxAge;
      pushPoint(h.x, h.y, 18 * h.scale, 1.0, 0.45, 0.56, Math.min(1, lifeRatio * 1.6), 2.0);
    }

    // 5. Issue GPU Draw Calls
    if (cellFloats > 0) {
      gl.useProgram(this.cellProg);
      gl.uniform2f(this.uCellWorldSize, world.width, world.height);
      gl.bindVertexArray(this.cellVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cellInstVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cellInstData.subarray(0, cellFloats));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cellFloats / 13);
    }

    if (lineFloats > 0) {
      gl.useProgram(this.lineProg);
      gl.uniform2f(this.uLineWorldSize, world.width, world.height);
      gl.bindVertexArray(this.lineVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineData.subarray(0, lineFloats));
      gl.drawArrays(gl.LINES, 0, lineFloats / 6);
    }

    if (flagFloats > 0) {
      gl.useProgram(this.flagellaProg);
      gl.uniform2f(this.uFlagWorldSize, world.width, world.height);
      gl.bindVertexArray(this.flagellaVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flagInstVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.flagInstData.subarray(0, flagFloats));
      gl.drawArraysInstanced(gl.LINES, 0, 14, flagFloats / 9);
    }

    if (pointFloats > 0) {
      gl.useProgram(this.pointProg);
      gl.uniform2f(this.uPointWorldSize, world.width, world.height);
      gl.uniform1f(this.uPointDpr, options.dpr);
      gl.bindVertexArray(this.pointVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pointData.subarray(0, pointFloats));
      gl.drawArrays(gl.POINTS, 0, pointFloats / 8);
    }

    if (atpFloats > 0) {
      gl.useProgram(this.atpProg);
      gl.uniform2f(this.uAtpWorldSize, world.width, world.height);
      gl.bindVertexArray(this.atpVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.atpInstVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.atpInstData.subarray(0, atpFloats));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, atpFloats / 9);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    this.particleTF.dispose();
    gl.deleteProgram(this.diffuseProg);
    gl.deleteProgram(this.bgProg);
    gl.deleteProgram(this.cellProg);
    gl.deleteProgram(this.lineProg);
    gl.deleteProgram(this.flagellaProg);
    gl.deleteProgram(this.pointProg);
    gl.deleteProgram(this.atpProg);
    gl.deleteTexture(this.chemRawTex);
    gl.deleteTexture(this.chemFboA.tex);
    gl.deleteTexture(this.chemFboB.tex);
    gl.deleteFramebuffer(this.chemFboA.fbo);
    gl.deleteFramebuffer(this.chemFboB.fbo);
    gl.deleteBuffer(this.quadVBO);
    gl.deleteVertexArray(this.quadVAO);
    gl.deleteBuffer(this.unitQuadVBO);
    gl.deleteBuffer(this.cellInstVBO);
    gl.deleteVertexArray(this.cellVAO);
    gl.deleteBuffer(this.lineVBO);
    gl.deleteVertexArray(this.lineVAO);
    gl.deleteBuffer(this.flagInstVBO);
    gl.deleteVertexArray(this.flagellaVAO);
    gl.deleteBuffer(this.pointVBO);
    gl.deleteVertexArray(this.pointVAO);
    gl.deleteBuffer(this.atpInstVBO);
    gl.deleteVertexArray(this.atpVAO);
  }
}
