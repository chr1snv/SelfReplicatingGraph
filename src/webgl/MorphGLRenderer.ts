import {
  BASE_DIM,
  CompiledGenome,
  MIP_LEVELS,
  MipLevel,
  SimState,
  TissueType,
  mipDim,
} from '../types/morphogenesis';
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

// GPU Nutrient Medium Diffusion & Shimmer Ping-Pong Pass (128x128 FBO)
const NUTRIENT_PASS_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uRawNutrients;
uniform sampler2D uPrevNutrients;
uniform vec2 uTexel;
out vec4 outColor;

void main() {
  float raw = texture(uRawNutrients, vUv).r;
  float prev = texture(uPrevNutrients, vUv).r;
  float lap =
    texture(uPrevNutrients, vUv + vec2(uTexel.x, 0.0)).r +
    texture(uPrevNutrients, vUv - vec2(uTexel.x, 0.0)).r +
    texture(uPrevNutrients, vUv + vec2(0.0, uTexel.y)).r +
    texture(uPrevNutrients, vUv - vec2(0.0, uTexel.y)).r;
  float diffused = mix(prev, lap * 0.25, 0.24);
  float coupled = mix(diffused, raw, 0.65);
  outColor = vec4(coupled, raw, 0.0, 1.0);
}
`;

// Single-Pass L3 -> L2 -> L1 -> L0 Mipmap Hierarchy + Cellular Morphogenesis Fragment Shader
const MORPH_COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;

uniform sampler2D uNutrientTex;
uniform sampler2D uBlueprintTex;
uniform sampler2D uLayer3Tex; // 16x16
uniform sampler2D uLayer2Tex; // 32x32
uniform sampler2D uLayer1Tex; // 64x64
uniform sampler2D uLayer0Tex; // 128x128

uniform float uShowNutrients;
uniform float uShowTargetGhost;
uniform float uHasCursor;
uniform vec2 uCursorCell;
uniform float uScalpelRadius;
uniform float uTime;

out vec4 outColor;

vec3 tissueColor(int t) {
  if (t == 1) return vec3(${TISSUE_RGB_TABLE[TissueType.EPIDERMIS].map((v) => v.toFixed(4)).join(', ')});
  if (t == 2) return vec3(${TISSUE_RGB_TABLE[TissueType.MESODERM].map((v) => v.toFixed(4)).join(', ')});
  if (t == 3) return vec3(${TISSUE_RGB_TABLE[TissueType.VASCULAR].map((v) => v.toFixed(4)).join(', ')});
  if (t == 4) return vec3(${TISSUE_RGB_TABLE[TissueType.NEURAL].map((v) => v.toFixed(4)).join(', ')});
  if (t == 5) return vec3(${TISSUE_RGB_TABLE[TissueType.SENSOR].map((v) => v.toFixed(4)).join(', ')});
  if (t == 6) return vec3(${TISSUE_RGB_TABLE[TissueType.MUSCLE].map((v) => v.toFixed(4)).join(', ')});
  if (t == 7) return vec3(${TISSUE_RGB_TABLE[TissueType.FLAGELLA].map((v) => v.toFixed(4)).join(', ')});
  if (t == 8) return vec3(${TISSUE_RGB_TABLE[TissueType.DIGESTIVE].map((v) => v.toFixed(4)).join(', ')});
  if (t == 9) return vec3(${TISSUE_RGB_TABLE[TissueType.EXCRETORY].map((v) => v.toFixed(4)).join(', ')});
  if (t == 10) return vec3(${TISSUE_RGB_TABLE[TissueType.SPIKE].map((v) => v.toFixed(4)).join(', ')});
  return vec3(0.035, 0.047, 0.071);
}

void main() {
  // Top-down coordinates matching grid [0..128)
  vec2 simPos = vec2(vUv.x * 128.0, (1.0 - vUv.y) * 128.0);
  ivec2 p0 = clamp(ivec2(floor(simPos)), ivec2(0), ivec2(127));

  // Base extracellular dish color
  vec3 col = vec3(0.029, 0.039, 0.059);

  // Subtle 16px L3 macro reference grid
  vec2 mod16 = mod(simPos, 8.0);
  if (mod16.x < 0.14 || mod16.y < 0.14) {
    col += vec3(0.015, 0.022, 0.036);
  }

  // GPU smoothed nutrient field backdrop
  if (uShowNutrients > 0.5) {
    float nut = texelFetch(uNutrientTex, p0, 0).r;
    float smoothNut = texture(uNutrientTex, vec2(vUv.x, 1.0 - vUv.y)).r;
    float n = mix(nut, smoothNut, 0.55);
    col += vec3(0.055, 0.31, 0.24) * clamp(n, 0.0, 1.0) * 0.55;
  }

  // Target blueprint ghost overlay
  if (uShowTargetGhost > 0.5) {
    int targetT = int(floor(texelFetch(uBlueprintTex, p0, 0).r * 255.0 + 0.5));
    if (targetT > 0) {
      vec3 tc = tissueColor(targetT);
      col = mix(col, tc, 0.22);
    }
  }

  // Evaluate hierarchy top-down (L3 -> L2 -> L1 -> L0)
  // Pack format per texel: R = alive (0/1), G = tissue/255, B = energy, A = flash/signal
  vec4 d3 = texelFetch(uLayer3Tex, p0 >> 3, 0);
  vec4 d2 = texelFetch(uLayer2Tex, p0 >> 2, 0);
  vec4 d1 = texelFetch(uLayer1Tex, p0 >> 1, 0);
  vec4 d0 = texelFetch(uLayer0Tex, p0, 0);

  // Coarse progenitor somas (L3 and L2) rendered underneath fine differentiated layers
  if (d3.r > 0.5) {
    vec2 localUv = fract(simPos / 8.0);
    float dist = length(localUv - vec2(0.5));
    int t3 = int(floor(d3.g * 255.0 + 0.5));
    vec3 tc = tissueColor(t3);
    if (dist < 0.44) {
      float body = smoothstep(0.44, 0.36, dist);
      float ring = smoothstep(0.04, 0.0, abs(dist - 0.38));
      float nuc = 1.0 - smoothstep(0.09, 0.14, dist);
      vec3 cellCol = tc * 0.45 + vec3(0.05) * ring + tc * nuc * 0.65;
      col = mix(col, cellCol, body * 0.55);
    }
  }

  if (d2.r > 0.5) {
    vec2 localUv = fract(simPos / 4.0);
    float dist = length(localUv - vec2(0.5));
    int t2 = int(floor(d2.g * 255.0 + 0.5));
    vec3 tc = tissueColor(t2);
    if (dist < 0.45) {
      float body = smoothstep(0.45, 0.34, dist);
      float nuc = 1.0 - smoothstep(0.08, 0.14, dist);
      vec3 cellCol = tc * 0.65 + tc * nuc * 0.45;
      col = mix(col, cellCol, body * 0.68);
    }
  }

  if (d1.r > 0.5) {
    vec2 localUv = fract(simPos / 2.0);
    vec2 edge = abs(localUv - vec2(0.5)) * 2.0;
    int t1 = int(floor(d1.g * 255.0 + 0.5));
    vec3 tc = tissueColor(t1);
    float boxMask = 1.0 - smoothstep(0.84, 0.98, max(edge.x, edge.y));
    float energyBright = 0.55 + d1.b * 0.45;
    vec3 cellCol = tc * energyBright + vec3(d1.a * 0.42);
    col = mix(col, cellCol, boxMask * 0.84);
  }

  if (d0.r > 0.5) {
    vec2 localUv = fract(simPos);
    vec2 edge = abs(localUv - vec2(0.5)) * 2.0;
    int t0 = int(floor(d0.g * 255.0 + 0.5));
    vec3 tc = tissueColor(t0);
    float border = smoothstep(0.82, 1.0, max(edge.x, edge.y));
    float energyBright = 0.60 + d0.b * 0.40;
    vec3 cellCol = tc * energyBright;
    // Division flash / neural spike
    cellCol = mix(cellCol, vec3(0.95, 0.98, 1.0), clamp(d0.a * 0.72, 0.0, 0.85));
    // Crisp cell wall darkening
    cellCol *= (1.0 - border * 0.25);
    col = cellCol;
  }

  // Interactive scalpel reticle
  if (uHasCursor > 0.5 && uScalpelRadius > 0.0) {
    float curDist = length(simPos - uCursorCell);
    float ring = smoothstep(0.55, 0.1, abs(curDist - uScalpelRadius));
    col = mix(col, vec3(0.957, 0.247, 0.369), ring * 0.9);
  }

  outColor = vec4(col, 1.0);
}
`;

const LINE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos; // in [0..128] grid space
layout(location = 1) in vec4 aColor;
out vec4 vColor;
void main() {
  vec2 ndc = vec2((aPos.x / 128.0) * 2.0 - 1.0, 1.0 - (aPos.y / 128.0) * 2.0);
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

export class MorphGLRenderer {
  private gl: WebGL2RenderingContext;
  private nutProg: WebGLProgram;
  private compProg: WebGLProgram;
  private lineProg: WebGLProgram;

  private quadVAO: WebGLVertexArrayObject;
  private quadVBO: WebGLBuffer;

  private nutRawTex: WebGLTexture;
  private nutFboA: RenderTargetFBO;
  private nutFboB: RenderTargetFBO;
  private nutPing = false;

  private blueprintTex: WebGLTexture;
  private layerTex: Record<MipLevel, WebGLTexture>;

  private nutBytes = new Uint8Array(BASE_DIM * BASE_DIM * 4);
  private bpBytes = new Uint8Array(BASE_DIM * BASE_DIM * 4);
  private layerBytes: Record<MipLevel, Uint8Array> = {
    0: new Uint8Array(128 * 128 * 4),
    1: new Uint8Array(64 * 64 * 4),
    2: new Uint8Array(32 * 32 * 4),
    3: new Uint8Array(16 * 16 * 4),
  };

  private lineVAO: WebGLVertexArrayObject;
  private lineVBO: WebGLBuffer;
  private lineData = new Float32Array(20000 * 6);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.nutProg = createProgram(gl, QUAD_VERT, NUTRIENT_PASS_FRAG);
    this.compProg = createProgram(gl, QUAD_VERT, MORPH_COMPOSITE_FRAG);
    this.lineProg = createProgram(gl, LINE_VERT, LINE_FRAG);

    const q = createFullscreenQuadVAO(gl);
    this.quadVAO = q.vao;
    this.quadVBO = q.vbo;

    this.nutRawTex = createRGBA8Texture(gl, BASE_DIM, BASE_DIM, gl.LINEAR);
    this.nutFboA = createRenderTarget(gl, BASE_DIM, BASE_DIM, gl.LINEAR);
    this.nutFboB = createRenderTarget(gl, BASE_DIM, BASE_DIM, gl.LINEAR);
    this.blueprintTex = createRGBA8Texture(gl, BASE_DIM, BASE_DIM, gl.NEAREST);

    this.layerTex = {
      0: createRGBA8Texture(gl, 128, 128, gl.NEAREST),
      1: createRGBA8Texture(gl, 64, 64, gl.NEAREST),
      2: createRGBA8Texture(gl, 32, 32, gl.NEAREST),
      3: createRGBA8Texture(gl, 16, 16, gl.NEAREST),
    };

    this.lineVAO = gl.createVertexArray()!;
    this.lineVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);
  }

  private ensureLineCapacity(floats: number): void {
    if (floats <= this.lineData.length) return;
    const next = new Float32Array(Math.ceil(floats * 1.5));
    next.set(this.lineData);
    this.lineData = next;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.lineVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.lineData.byteLength, this.gl.DYNAMIC_DRAW);
  }

  render(
    simState: SimState,
    genome: CompiledGenome,
    options: {
      sizePx: number;
      dpr: number;
      showNutrients: boolean;
      showDirectives: boolean;
      showTargetGhost: boolean;
      cursorCell: { x: number; y: number } | null;
      scalpelRadius: number;
      timeSec: number;
    },
  ): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const target = Math.round(options.sizePx * options.dpr);
    if (canvas.width !== target || canvas.height !== target) {
      canvas.width = target;
      canvas.height = target;
    }

    // 1. Upload nutrient grid + run GPU diffusion pass
    const nLen = BASE_DIM * BASE_DIM;
    const nutrients = simState.nutrients;
    for (let i = 0; i < nLen; i++) {
      const o = i * 4;
      const v = Math.min(255, Math.max(0, (nutrients[i] * 255) | 0));
      this.nutBytes[o] = v;
      this.nutBytes[o + 1] = v;
      this.nutBytes[o + 2] = 0;
      this.nutBytes[o + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.nutRawTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      BASE_DIM,
      BASE_DIM,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.nutBytes,
    );

    const srcFbo = this.nutPing ? this.nutFboA : this.nutFboB;
    const dstFbo = this.nutPing ? this.nutFboB : this.nutFboA;
    this.nutPing = !this.nutPing;

    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo.fbo);
    gl.viewport(0, 0, BASE_DIM, BASE_DIM);
    gl.disable(gl.BLEND);
    gl.useProgram(this.nutProg);
    gl.bindVertexArray(this.quadVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.nutRawTex);
    gl.uniform1i(gl.getUniformLocation(this.nutProg, 'uRawNutrients'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex);
    gl.uniform1i(gl.getUniformLocation(this.nutProg, 'uPrevNutrients'), 1);
    gl.uniform2f(gl.getUniformLocation(this.nutProg, 'uTexel'), 1 / BASE_DIM, 1 / BASE_DIM);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // 2. Upload Blueprint ghost if requested
    if (options.showTargetGhost) {
      for (let i = 0; i < nLen; i++) {
        const o = i * 4;
        this.bpBytes[o] = genome.blueprint[i];
        this.bpBytes[o + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.blueprintTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        BASE_DIM,
        BASE_DIM,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.bpBytes,
      );
    }

    // 3. Upload L3 -> L0 SimLayerState packed textures
    for (const lvl of MIP_LEVELS) {
      const layer = simState.layers[lvl];
      const dim = mipDim(lvl);
      const total = dim * dim;
      const bytes = this.layerBytes[lvl];
      for (let i = 0; i < total; i++) {
        const o = i * 4;
        const alive = layer.alive[i];
        bytes[o] = alive ? 255 : 0;
        bytes[o + 1] = layer.tissue[i];
        bytes[o + 2] = Math.min(255, Math.max(0, (layer.energy[i] * 255) | 0));
        const pulse = Math.min(1, layer.flash[i] * 0.9 + layer.signal[i] * 0.75);
        bytes[o + 3] = Math.min(255, Math.max(0, (pulse * 255) | 0));
      }
      gl.bindTexture(gl.TEXTURE_2D, this.layerTex[lvl]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, dim, dim, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }

    // 4. Render Fullscreen Mipmap Composite Fragment Shader
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.compProg);
    gl.bindVertexArray(this.quadVAO);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dstFbo.tex);
    gl.uniform1i(gl.getUniformLocation(this.compProg, 'uNutrientTex'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blueprintTex);
    gl.uniform1i(gl.getUniformLocation(this.compProg, 'uBlueprintTex'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTex[3]);
    gl.uniform1i(gl.getUniformLocation(this.compProg, 'uLayer3Tex'), 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTex[2]);
    gl.uniform1i(gl.getUniformLocation(this.compProg, 'uLayer2Tex'), 3);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTex[1]);
    gl.uniform1i(gl.getUniformLocation(this.compProg, 'uLayer1Tex'), 4);

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTex[0]);
    gl.uniform1i(gl.getUniformLocation(this.compProg, 'uLayer0Tex'), 5);

    gl.uniform1f(
      gl.getUniformLocation(this.compProg, 'uShowNutrients'),
      options.showNutrients ? 1.0 : 0.0,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.compProg, 'uShowTargetGhost'),
      options.showTargetGhost ? 1.0 : 0.0,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.compProg, 'uHasCursor'),
      options.cursorCell ? 1.0 : 0.0,
    );
    if (options.cursorCell) {
      gl.uniform2f(
        gl.getUniformLocation(this.compProg, 'uCursorCell'),
        options.cursorCell.x,
        options.cursorCell.y,
      );
    }
    gl.uniform1f(gl.getUniformLocation(this.compProg, 'uScalpelRadius'), options.scalpelRadius);
    gl.uniform1f(gl.getUniformLocation(this.compProg, 'uTime'), options.timeSec);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 5. Optional Directive Connectivity Graph Overlay (gl.LINES)
    if (options.showDirectives) {
      let floats = 0;
      const pushEdge = (
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        r: number,
        g: number,
        b: number,
        a: number,
      ) => {
        this.ensureLineCapacity(floats + 12);
        const d = this.lineData;
        d[floats++] = x0;
        d[floats++] = y0;
        d[floats++] = r;
        d[floats++] = g;
        d[floats++] = b;
        d[floats++] = a;

        d[floats++] = x1;
        d[floats++] = y1;
        d[floats++] = r;
        d[floats++] = g;
        d[floats++] = b;
        d[floats++] = a;
      };

      // Subdivisions + Bridges
      for (const lvl of [3, 2, 1] as MipLevel[]) {
        const layer = simState.layers[lvl];
        const dim = layer.dim;
        for (let i = 0; i < dim * dim; i++) {
          if (!layer.alive[i]) continue;
          const nid = layer.nodeId[i];
          const node = genome.nodeById.get(nid);
          if (!node) continue;
          for (const cid of node.subdivisionChildren) {
            if (cid === -1) continue;
            const child = genome.nodeById.get(cid);
            if (!child) continue;
            const cl = simState.layers[child.level];
            if (!cl.alive[child.gy * cl.dim + child.gx]) continue;
            pushEdge(
              node.physX,
              node.physY,
              child.physX,
              child.physY,
              0.22,
              0.74,
              0.97,
              0.42,
            );
          }
          for (const bid of node.bridgeTargetIds) {
            const targetNode = genome.nodeById.get(bid);
            if (!targetNode) continue;
            const tl = simState.layers[targetNode.level];
            if (!tl.alive[targetNode.gy * tl.dim + targetNode.gx]) continue;
            pushEdge(
              node.physX,
              node.physY,
              targetNode.physX,
              targetNode.physY,
              0.98,
              0.75,
              0.14,
              0.65,
            );
          }
        }
      }

      // Lateral L1/L2 edges
      for (const lvl of [2, 1] as MipLevel[]) {
        const layer = simState.layers[lvl];
        const dim = layer.dim;
        for (let i = 0; i < dim * dim; i++) {
          if (!layer.alive[i]) continue;
          const node = genome.nodeById.get(layer.nodeId[i]);
          if (!node) continue;
          for (const lid of node.lateralNeighbors) {
            if (lid === -1 || lid < node.id) continue;
            const nb = genome.nodeById.get(lid);
            if (!nb) continue;
            if (!layer.alive[nb.gy * dim + nb.gx]) continue;
            pushEdge(node.physX, node.physY, nb.physX, nb.physY, 0.94, 0.96, 0.99, 0.2);
          }
        }
      }

      if (floats > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.lineProg);
        gl.bindVertexArray(this.lineVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineData.subarray(0, floats));
        gl.drawArrays(gl.LINES, 0, floats / 6);
      }
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.nutProg);
    gl.deleteProgram(this.compProg);
    gl.deleteProgram(this.lineProg);
    gl.deleteTexture(this.nutRawTex);
    gl.deleteTexture(this.nutFboA.tex);
    gl.deleteTexture(this.nutFboB.tex);
    gl.deleteFramebuffer(this.nutFboA.fbo);
    gl.deleteFramebuffer(this.nutFboB.fbo);
    gl.deleteTexture(this.blueprintTex);
    for (const lvl of MIP_LEVELS) {
      gl.deleteTexture(this.layerTex[lvl]);
    }
    gl.deleteBuffer(this.quadVBO);
    gl.deleteVertexArray(this.quadVAO);
    gl.deleteBuffer(this.lineVBO);
    gl.deleteVertexArray(this.lineVAO);
  }
}
