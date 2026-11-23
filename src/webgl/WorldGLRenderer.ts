import { TissueType, WorldState } from '../types/morphogenesis';
import {
  RenderTargetFBO,
  TISSUE_RGB_TABLE,
  createFullscreenQuadVAO,
  createProgram,
  createRGBA8Texture,
  createRenderTarget,
} from './glUtils';

const QUAD_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// GPU ping-pong chemical diffusion + temporal smoothing shader (runs on 128x80 FBO)
const CHEM_DIFFUSE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uRawChem;
uniform sampler2D uPrevChem;
uniform vec2 uTexel;
out vec4 outColor;

void main() {
  vec4 raw = texture(uRawChem, vUv);
  vec4 prev = texture(uPrevChem, vUv);
  vec4 lap =
    texture(uPrevChem, vUv + vec2(uTexel.x, 0.0)) +
    texture(uPrevChem, vUv - vec2(uTexel.x, 0.0)) +
    texture(uPrevChem, vUv + vec2(0.0, uTexel.y)) +
    texture(uPrevChem, vUv - vec2(0.0, uTexel.y));
  vec4 diffused = mix(prev, lap * 0.25, 0.28);
  // Couple GPU visual glow tightly to authoritative CPU chemistry so drops appear instantaneously
  vec3 coupled = mix(diffused.rgb, raw.rgb, 0.62);
  outColor = vec4(coupled, 1.0);
}
`;

// Fullscreen fluid backdrop + coordinate grid + chemical field isolines
const WORLD_BG_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uChemTex;
uniform vec2 uWorldSize;
uniform float uShowChem;
uniform float uTime;
out vec4 outColor;

void main() {
  vec2 worldPos = vec2(vUv.x * uWorldSize.x, (1.0 - vUv.y) * uWorldSize.y);

  // Abyssal fluid gradient
  vec2 centerDelta = vUv - vec2(0.5);
  float radial = dot(centerDelta, centerDelta);
  vec3 base = mix(vec3(0.039, 0.059, 0.098), vec3(0.022, 0.031, 0.051), radial * 1.8);

  // Subtle scientific 80px grid lines
  vec2 g = mod(worldPos, 80.0);
  float gx = step(g.x, 0.95);
  float gy = step(g.y, 0.95);
  float grid = max(gx, gy) * (1.0 - step(worldPos.x, 1.0)) * (1.0 - step(worldPos.y, 1.0));
  base += vec3(0.028, 0.042, 0.068) * grid;

  if (uShowChem > 0.5) {
    vec2 chemUv = vec2(vUv.x, 1.0 - vUv.y);
    vec3 chem = texture(uChemTex, chemUv).rgb;
    float food = clamp(chem.r * 1.45, 0.0, 1.0);
    float scent = clamp(chem.g * 1.35, 0.0, 1.0);
    float toxin = clamp(chem.b * 1.5, 0.0, 1.0);

    // Subtle organic wave shimmer inside chemical plumes
    float shimmer = 0.92 + 0.08 * sin(worldPos.x * 0.035 + uTime * 1.4) * cos(worldPos.y * 0.035 - uTime * 1.1);
    base += vec3(0.06, 0.65, 0.44) * food * 0.52 * shimmer;
    base += vec3(0.75, 0.50, 0.12) * scent * 0.28;
    base += vec3(0.86, 0.18, 0.34) * toxin * 0.55;

    // Subtle chemotactic contour ring on food boundary
    float foodContour = smoothstep(0.02, 0.0, abs(fract(food * 5.0) - 0.5)) * smoothstep(0.12, 0.25, food);
    base += vec3(0.12, 0.85, 0.55) * foodContour * 0.09;
  }

  outColor = vec4(base, 1.0);
}
`;

// Batched deformable organism cell quads (with GPU SDF border & damage highlight)
const CELL_QUAD_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aCellUv;
layout(location = 2) in vec4 aColorAlpha;
layout(location = 3) in vec2 aFx; // x: damageFlash, y: musclePulse

uniform vec2 uWorldSize;
out vec2 vCellUv;
out vec4 vColorAlpha;
out vec2 vFx;

void main() {
  vec2 ndc = vec2(
    (aPos.x / uWorldSize.x) * 2.0 - 1.0,
    1.0 - (aPos.y / uWorldSize.y) * 2.0
  );
  vCellUv = aCellUv;
  vColorAlpha = aColorAlpha;
  vFx = aFx;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const CELL_QUAD_FRAG = `#version 300 es
precision highp float;
in vec2 vCellUv;
in vec4 vColorAlpha;
in vec2 vFx;
out vec4 outColor;

void main() {
  vec2 d = abs(vCellUv - vec2(0.5)) * 2.0;
  float edgeDist = 1.0 - max(d.x, d.y);
  // Subtle organic corner rounding
  float corner = length(max(d - vec2(0.72), 0.0));
  if (corner > 0.28) discard;

  vec3 col = vColorAlpha.rgb;
  // Crisp inner membrane highlight + subtle dark boundary
  float border = smoothstep(0.14, 0.0, edgeDist);
  col = mix(col, col * 0.55 + vec3(0.06, 0.1, 0.14), border * 0.65);

  // Muscle contraction luminance boost
  col += vec3(0.28, 0.08, 0.22) * vFx.y;

  // Damage flash tint
  col = mix(col, vec3(0.98, 0.44, 0.52), clamp(vFx.x * 0.65, 0.0, 0.8));

  // Nucleus center dot for rich cellular depth
  float nuc = 1.0 - smoothstep(0.08, 0.22, length(vCellUv - vec2(0.5)));
  col += col * nuc * 0.22;

  outColor = vec4(col, vColorAlpha.a);
}
`;

// Batched lines (membranes, springs, gradient arrows, chemotactic rays)
const LINE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
uniform vec2 uWorldSize;
out vec4 vColor;

void main() {
  vec2 ndc = vec2(
    (aPos.x / uWorldSize.x) * 2.0 - 1.0,
    1.0 - (aPos.y / uWorldSize.y) * 2.0
  );
  vColor = aColor;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  outColor = vColor;
}
`;

// GPU Flagella sinusoidal whip vertex shader
const FLAGELLA_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aBase;
layout(location = 1) in vec2 aDir;     // normalized tail direction
layout(location = 2) in vec4 aParams;  // x: segT [0..1], y: len, z: phase, w: alpha

uniform vec2 uWorldSize;
out vec4 vColor;

void main() {
  float segT = aParams.x;
  float whipLen = aParams.y;
  float phase = aParams.z;
  float alpha = aParams.w;

  vec2 perp = vec2(-aDir.y, aDir.x);
  float wave = sin(segT * 4.7 - phase) * segT * 4.5;
  vec2 pos = aBase + aDir * (segT * whipLen) + perp * wave;

  vec2 ndc = vec2(
    (pos.x / uWorldSize.x) * 2.0 - 1.0,
    1.0 - (pos.y / uWorldSize.y) * 2.0
  );
  vColor = vec4(0.768, 0.71, 0.992, alpha * (1.0 - segT * 0.22));
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

// Procedural radial glow points (pellets & sensor eyes)
const GLOW_POINT_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aSize;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aKind; // 0 = pellet aura, 1 = crisp eye/core

uniform vec2 uWorldSize;
uniform float uDpr;
out vec4 vColor;
out float vKind;

void main() {
  vec2 ndc = vec2(
    (aPos.x / uWorldSize.x) * 2.0 - 1.0,
    1.0 - (aPos.y / uWorldSize.y) * 2.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = aSize * uDpr;
  vColor = aColor;
  vKind = aKind;
}
`;

const GLOW_POINT_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
in float vKind;
out vec4 outColor;

void main() {
  vec2 p = (gl_PointCoord - vec2(0.5)) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;

  if (vKind < 0.5) {
    // Food pellet: soft nutrient aura + crisp dense core
    float halo = exp(-r * r * 3.8) * 0.42;
    float core = 1.0 - smoothstep(0.24, 0.34, r);
    float ring = smoothstep(0.06, 0.0, abs(r - 0.36)) * 0.55;
    vec3 col = mix(vColor.rgb, vec3(0.43, 0.91, 0.72), core * 0.7 + ring * 0.4);
    float a = clamp(halo + core * 0.95 + ring, 0.0, 1.0) * vColor.a;
    outColor = vec4(col, a);
  } else {
    // Sensor eye / highlight core
    float dotA = 1.0 - smoothstep(0.65, 1.0, r);
    outColor = vec4(vColor.rgb, vColor.a * dotA);
  }
}
`;

export class WorldGLRenderer {
  private gl: WebGL2RenderingContext;
  private diffuseProg: WebGLProgram;
  private bgProg: WebGLProgram;
  private cellProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private flagellaProg: WebGLProgram;
  private pointProg: WebGLProgram;

  private quadVAO: WebGLVertexArrayObject;
  private quadVBO: WebGLBuffer;

  private chemRawTex: WebGLTexture;
  private chemBytes: Uint8Array;
  private chemFboA: RenderTargetFBO;
  private chemFboB: RenderTargetFBO;
  private chemPing = false;
  private chemCols = 0;
  private chemRows = 0;

  // Dynamic geometry buffers (grown cleanly when needed)
  private cellVAO: WebGLVertexArrayObject;
  private cellVBO: WebGLBuffer;
  private cellData = new Float32Array(6000 * 10);

  private lineVAO: WebGLVertexArrayObject;
  private lineVBO: WebGLBuffer;
  private lineData = new Float32Array(12000 * 6);

  private flagellaVAO: WebGLVertexArrayObject;
  private flagellaVBO: WebGLBuffer;
  private flagellaData = new Float32Array(4000 * 8);

  private pointVAO: WebGLVertexArrayObject;
  private pointVBO: WebGLBuffer;
  private pointData = new Float32Array(1024 * 8);

  constructor(gl: WebGL2RenderingContext, chemCols: number, chemRows: number) {
    this.gl = gl;
    this.chemCols = chemCols;
    this.chemRows = chemRows;

    this.diffuseProg = createProgram(gl, QUAD_VERT, CHEM_DIFFUSE_FRAG);
    this.bgProg = createProgram(gl, QUAD_VERT, WORLD_BG_FRAG);
    this.cellProg = createProgram(gl, CELL_QUAD_VERT, CELL_QUAD_FRAG);
    this.lineProg = createProgram(gl, LINE_VERT, LINE_FRAG);
    this.flagellaProg = createProgram(gl, FLAGELLA_VERT, LINE_FRAG);
    this.pointProg = createProgram(gl, GLOW_POINT_VERT, GLOW_POINT_FRAG);

    const quad = createFullscreenQuadVAO(gl);
    this.quadVAO = quad.vao;
    this.quadVBO = quad.vbo;

    this.chemBytes = new Uint8Array(chemCols * chemRows * 4);
    this.chemRawTex = createRGBA8Texture(gl, chemCols, chemRows, gl.LINEAR, null);
    this.chemFboA = createRenderTarget(gl, chemCols, chemRows, gl.LINEAR);
    this.chemFboB = createRenderTarget(gl, chemCols, chemRows, gl.LINEAR);

    // Cell quad VAO: [x, y, uvX, uvY, r, g, b, a, dmg, musclePulse] -> 10 floats = 40 bytes
    this.cellVAO = gl.createVertexArray()!;
    this.cellVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.cellVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.cellData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 40, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 40, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 40, 32);

    // Line VAO: [x, y, r, g, b, a] -> 6 floats = 24 bytes
    this.lineVAO = gl.createVertexArray()!;
    this.lineVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);

    // Flagella VAO: [baseX, baseY, dirX, dirY, segT, whipLen, phase, alpha] -> 8 floats = 32 bytes
    this.flagellaVAO = gl.createVertexArray()!;
    this.flagellaVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.flagellaVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flagellaVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.flagellaData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);

    // Point VAO: [x, y, size, r, g, b, a, kind] -> 8 floats = 32 bytes
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

    gl.bindVertexArray(null);
  }

  private ensureCellCapacity(floatsNeeded: number): void {
    if (floatsNeeded <= this.cellData.length) return;
    const next = new Float32Array(Math.ceil(floatsNeeded * 1.5));
    next.set(this.cellData);
    this.cellData = next;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.cellVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.cellData.byteLength, this.gl.DYNAMIC_DRAW);
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
    if (floatsNeeded <= this.flagellaData.length) return;
    const next = new Float32Array(Math.ceil(floatsNeeded * 1.5));
    next.set(this.flagellaData);
    this.flagellaData = next;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.flagellaVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.flagellaData.byteLength, this.gl.DYNAMIC_DRAW);
  }

  private ensurePointCapacity(floatsNeeded: number): void {
    if (floatsNeeded <= this.pointData.length) return;
    const next = new Float32Array(Math.ceil(floatsNeeded * 1.5));
    next.set(this.pointData);
    this.pointData = next;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.pointVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.pointData.byteLength, this.gl.DYNAMIC_DRAW);
  }

  render(
    world: WorldState,
    options: {
      selectedOrgId: number | null;
      showChemFields: boolean;
      showGradientArrows: boolean;
      showPhysicsMesh: boolean;
      dpr: number;
      timeSec: number;
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

    // 1. Pack chemistry buffers & run GPU ping-pong diffusion shader
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
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.chemCols,
        this.chemRows,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bytes,
      );

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
      gl.uniform1i(gl.getUniformLocation(this.diffuseProg, 'uRawChem'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex);
      gl.uniform1i(gl.getUniformLocation(this.diffuseProg, 'uPrevChem'), 1);
      gl.uniform2f(
        gl.getUniformLocation(this.diffuseProg, 'uTexel'),
        1 / this.chemCols,
        1 / this.chemRows,
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    const activeChemTex = (this.chemPing ? this.chemFboA : this.chemFboB).tex;

    // 2. Render Main Viewport Backdrop + Chemical Plumes Shader
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.bgProg);
    gl.bindVertexArray(this.quadVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, activeChemTex);
    gl.uniform1i(gl.getUniformLocation(this.bgProg, 'uChemTex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.bgProg, 'uWorldSize'), world.width, world.height);
    gl.uniform1f(
      gl.getUniformLocation(this.bgProg, 'uShowChem'),
      options.showChemFields ? 1.0 : 0.0,
    );
    gl.uniform1f(gl.getUniformLocation(this.bgProg, 'uTime'), options.timeSec);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Enable alpha blending for chemical arrows, cells, membranes, flagella, pellets
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // 3. Build geometry batches cleanly
    let cellFloats = 0;
    let lineFloats = 0;
    let flagFloats = 0;
    let pointFloats = 0;

    const pushLine = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      r: number,
      g: number,
      b: number,
      a: number,
    ) => {
      this.ensureLineCapacity(lineFloats + 12);
      const d = this.lineData;
      d[lineFloats++] = x0;
      d[lineFloats++] = y0;
      d[lineFloats++] = r;
      d[lineFloats++] = g;
      d[lineFloats++] = b;
      d[lineFloats++] = a;

      d[lineFloats++] = x1;
      d[lineFloats++] = y1;
      d[lineFloats++] = r;
      d[lineFloats++] = g;
      d[lineFloats++] = b;
      d[lineFloats++] = a;
    };

    const pushPoint = (
      x: number,
      y: number,
      size: number,
      r: number,
      g: number,
      b: number,
      a: number,
      kind: number,
    ) => {
      this.ensurePointCapacity(pointFloats + 8);
      const d = this.pointData;
      d[pointFloats++] = x;
      d[pointFloats++] = y;
      d[pointFloats++] = size;
      d[pointFloats++] = r;
      d[pointFloats++] = g;
      d[pointFloats++] = b;
      d[pointFloats++] = a;
      d[pointFloats++] = kind;
    };

    // Gradient Vector Field arrows
    if (options.showGradientArrows) {
      const cw = world.width / world.chemCols;
      const ch = world.height / world.chemRows;
      for (let gy = 2; gy < world.chemRows - 2; gy += 4) {
        for (let gx = 2; gx < world.chemCols - 2; gx += 4) {
          const idx = gy * world.chemCols + gx;
          const dx = world.foodField[idx + 1] - world.foodField[idx - 1];
          const dy =
            world.foodField[idx + world.chemCols] - world.foodField[idx - world.chemCols];
          const mag = Math.hypot(dx, dy);
          if (mag < 0.008) continue;
          const cx = (gx + 0.5) * cw;
          const cy = (gy + 0.5) * ch;
          const scale = Math.min(18, mag * 140);
          const nx = (dx / mag) * scale;
          const ny = (dy / mag) * scale;
          pushLine(cx, cy, cx + nx, cy + ny, 0.204, 0.827, 0.6, 0.48);
        }
      }
    }

    // Food Pellets
    for (let i = 0; i < world.pellets.length; i++) {
      const p = world.pellets[i];
      pushPoint(
        p.x,
        p.y,
        (p.radius * 3.8) * Math.max(0.4, Math.min(1.1, p.amount)),
        0.063,
        0.725,
        0.506,
        0.92,
        0.0,
      );
    }

    // Soft-Body Organisms
    for (let oi = 0; oi < world.organisms.length; oi++) {
      const org = world.organisms[oi];
      const verts = org.mesh.vertices;
      const cells = org.mesh.cells;
      const isSelected = org.id === options.selectedOrgId;
      const dmg = org.damageFlash;
      const baseAlpha = Math.max(0.48, 0.72 + org.energyReserve * 0.0028);

      // Cells (2 triangles = 6 vertices = 60 floats per cell)
      this.ensureCellCapacity(cellFloats + cells.length * 60);
      const cd = this.cellData;

      for (let ci = 0; ci < cells.length; ci++) {
        const cell = cells[ci];
        const vTL = verts[cell.vTL];
        const vTR = verts[cell.vTR];
        const vBR = verts[cell.vBR];
        const vBL = verts[cell.vBL];

        const [tr, tg, tb] = TISSUE_RGB_TABLE[cell.tissue] ?? TISSUE_RGB_TABLE[TissueType.MESODERM];
        const musclePulse =
          cell.tissue === TissueType.MUSCLE ? Math.max(0, -cell.activation * 0.85) : 0;

        // Tri 1: TL -> TR -> BR
        // TL (0,0)
        cd[cellFloats++] = vTL.x;
        cd[cellFloats++] = vTL.y;
        cd[cellFloats++] = 0;
        cd[cellFloats++] = 0;
        cd[cellFloats++] = tr;
        cd[cellFloats++] = tg;
        cd[cellFloats++] = tb;
        cd[cellFloats++] = baseAlpha;
        cd[cellFloats++] = dmg;
        cd[cellFloats++] = musclePulse;
        // TR (1,0)
        cd[cellFloats++] = vTR.x;
        cd[cellFloats++] = vTR.y;
        cd[cellFloats++] = 1;
        cd[cellFloats++] = 0;
        cd[cellFloats++] = tr;
        cd[cellFloats++] = tg;
        cd[cellFloats++] = tb;
        cd[cellFloats++] = baseAlpha;
        cd[cellFloats++] = dmg;
        cd[cellFloats++] = musclePulse;
        // BR (1,1)
        cd[cellFloats++] = vBR.x;
        cd[cellFloats++] = vBR.y;
        cd[cellFloats++] = 1;
        cd[cellFloats++] = 1;
        cd[cellFloats++] = tr;
        cd[cellFloats++] = tg;
        cd[cellFloats++] = tb;
        cd[cellFloats++] = baseAlpha;
        cd[cellFloats++] = dmg;
        cd[cellFloats++] = musclePulse;

        // Tri 2: TL -> BR -> BL
        // TL (0,0)
        cd[cellFloats++] = vTL.x;
        cd[cellFloats++] = vTL.y;
        cd[cellFloats++] = 0;
        cd[cellFloats++] = 0;
        cd[cellFloats++] = tr;
        cd[cellFloats++] = tg;
        cd[cellFloats++] = tb;
        cd[cellFloats++] = baseAlpha;
        cd[cellFloats++] = dmg;
        cd[cellFloats++] = musclePulse;
        // BR (1,1)
        cd[cellFloats++] = vBR.x;
        cd[cellFloats++] = vBR.y;
        cd[cellFloats++] = 1;
        cd[cellFloats++] = 1;
        cd[cellFloats++] = tr;
        cd[cellFloats++] = tg;
        cd[cellFloats++] = tb;
        cd[cellFloats++] = baseAlpha;
        cd[cellFloats++] = dmg;
        cd[cellFloats++] = musclePulse;
        // BL (0,1)
        cd[cellFloats++] = vBL.x;
        cd[cellFloats++] = vBL.y;
        cd[cellFloats++] = 0;
        cd[cellFloats++] = 1;
        cd[cellFloats++] = tr;
        cd[cellFloats++] = tg;
        cd[cellFloats++] = tb;
        cd[cellFloats++] = baseAlpha;
        cd[cellFloats++] = dmg;
        cd[cellFloats++] = musclePulse;

        // Gradient sensor rays & eye points
        if (cell.sensorWeight > 0.2) {
          const sx = (vTL.x + vTR.x + vBR.x + vBL.x) * 0.25;
          const sy = (vTL.y + vTR.y + vBR.y + vBL.y) * 0.25;
          pushPoint(sx, sy, 5.2, 0.745, 0.949, 0.392, 0.95, 1.0);
          if (Math.hypot(cell.gradientX, cell.gradientY) > 0.03) {
            pushLine(
              sx,
              sy,
              sx + cell.gradientX * 24,
              sy + cell.gradientY * 24,
              0.639,
              0.902,
              0.208,
              0.55,
            );
          }
        }

        // Flagella GPU shader lines (5 segments = 8 vertices as LINE_STRIP pairs -> 4 segments = 8 vertices)
        if (cell.flagellaWeight > 0.15) {
          const cx = (vTL.x + vTR.x + vBR.x + vBL.x) * 0.25;
          const cy = (vTL.y + vTR.y + vBR.y + vBL.y) * 0.25;
          const isBraking = cell.thrustDotForward < -0.15;
          const throttle = isBraking ? org.neuralNet.brakeOut : org.neuralNet.cruiseOut;
          if (throttle > 0.03 || isSelected) {
            const whipLen = 10 + cell.flagellaWeight * (6 + throttle * 11);
            const phase = org.musclePhaseTime * (1.2 + throttle * 3.1) + cell.gx * 0.8;
            const alpha = Math.min(0.95, 0.26 + throttle * 0.7);
            const segs = 4;
            this.ensureFlagellaCapacity(flagFloats + segs * 2 * 8);
            const fd = this.flagellaData;
            for (let s = 0; s < segs; s++) {
              const t0 = s / segs;
              const t1 = (s + 1) / segs;
              // vertex 0
              fd[flagFloats++] = cx;
              fd[flagFloats++] = cy;
              fd[flagFloats++] = cell.thrustDirX;
              fd[flagFloats++] = cell.thrustDirY;
              fd[flagFloats++] = t0;
              fd[flagFloats++] = whipLen;
              fd[flagFloats++] = phase;
              fd[flagFloats++] = alpha;
              // vertex 1
              fd[flagFloats++] = cx;
              fd[flagFloats++] = cy;
              fd[flagFloats++] = cell.thrustDirX;
              fd[flagFloats++] = cell.thrustDirY;
              fd[flagFloats++] = t1;
              fd[flagFloats++] = whipLen;
              fd[flagFloats++] = phase;
              fd[flagFloats++] = alpha;
            }
          }
        }
      }

      // Optional BoxEye structural springs & contractile muscle springs
      if (options.showPhysicsMesh) {
        const springs = org.mesh.springs;
        for (let si = 0; si < springs.length; si++) {
          const sp = springs[si];
          const a = verts[sp.v0];
          const b = verts[sp.v1];
          if (sp.isMuscle) {
            pushLine(a.x, a.y, b.x, b.y, 0.957, 0.447, 0.714, 0.9);
          } else {
            pushLine(a.x, a.y, b.x, b.y, 0.58, 0.639, 0.722, 0.28);
          }
        }
      }

      // Outer pressure boundary perimeter
      const bEdges = org.mesh.boundaryEdges;
      const mr = isSelected ? 0.133 : 0.886;
      const mg = isSelected ? 0.827 : 0.91;
      const mb = isSelected ? 0.933 : 0.941;
      const ma = isSelected ? 0.95 : 0.35;
      for (let ei = 0; ei < bEdges.length; ei++) {
        const [va, vb] = bEdges[ei];
        const a = verts[va];
        const b = verts[vb];
        pushLine(a.x, a.y, b.x, b.y, mr, mg, mb, ma);
      }

      // Selected organism tactical ring (28-segment circle)
      if (isSelected) {
        const rad = org.mesh.boundRadius + 10;
        const steps = 28;
        for (let k = 0; k < steps; k++) {
          const a0 = (k / steps) * Math.PI * 2;
          const a1 = ((k + 1) / steps) * Math.PI * 2;
          pushLine(
            org.mesh.comX + Math.cos(a0) * rad,
            org.mesh.comY + Math.sin(a0) * rad,
            org.mesh.comX + Math.cos(a1) * rad,
            org.mesh.comY + Math.sin(a1) * rad,
            0.133,
            0.827,
            0.933,
            0.78,
          );
        }
      }
    }

    // 4. Issue GPU Draw Calls
    if (cellFloats > 0) {
      gl.useProgram(this.cellProg);
      gl.uniform2f(gl.getUniformLocation(this.cellProg, 'uWorldSize'), world.width, world.height);
      gl.bindVertexArray(this.cellVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cellVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cellData.subarray(0, cellFloats));
      gl.drawArrays(gl.TRIANGLES, 0, cellFloats / 10);
    }

    if (lineFloats > 0) {
      gl.useProgram(this.lineProg);
      gl.uniform2f(gl.getUniformLocation(this.lineProg, 'uWorldSize'), world.width, world.height);
      gl.bindVertexArray(this.lineVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineData.subarray(0, lineFloats));
      gl.drawArrays(gl.LINES, 0, lineFloats / 6);
    }

    if (flagFloats > 0) {
      gl.useProgram(this.flagellaProg);
      gl.uniform2f(
        gl.getUniformLocation(this.flagellaProg, 'uWorldSize'),
        world.width,
        world.height,
      );
      gl.bindVertexArray(this.flagellaVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flagellaVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.flagellaData.subarray(0, flagFloats));
      gl.drawArrays(gl.LINES, 0, flagFloats / 8);
    }

    if (pointFloats > 0) {
      gl.useProgram(this.pointProg);
      gl.uniform2f(gl.getUniformLocation(this.pointProg, 'uWorldSize'), world.width, world.height);
      gl.uniform1f(gl.getUniformLocation(this.pointProg, 'uDpr'), options.dpr);
      gl.bindVertexArray(this.pointVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pointData.subarray(0, pointFloats));
      gl.drawArrays(gl.POINTS, 0, pointFloats / 8);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.diffuseProg);
    gl.deleteProgram(this.bgProg);
    gl.deleteProgram(this.cellProg);
    gl.deleteProgram(this.lineProg);
    gl.deleteProgram(this.flagellaProg);
    gl.deleteProgram(this.pointProg);
    gl.deleteTexture(this.chemRawTex);
    gl.deleteTexture(this.chemFboA.tex);
    gl.deleteTexture(this.chemFboB.tex);
    gl.deleteFramebuffer(this.chemFboA.fbo);
    gl.deleteFramebuffer(this.chemFboB.fbo);
    gl.deleteBuffer(this.quadVBO);
    gl.deleteVertexArray(this.quadVAO);
    gl.deleteBuffer(this.cellVBO);
    gl.deleteVertexArray(this.cellVAO);
    gl.deleteBuffer(this.lineVBO);
    gl.deleteVertexArray(this.lineVAO);
    gl.deleteBuffer(this.flagellaVBO);
    gl.deleteVertexArray(this.flagellaVAO);
    gl.deleteBuffer(this.pointVBO);
    gl.deleteVertexArray(this.pointVAO);
  }
}
