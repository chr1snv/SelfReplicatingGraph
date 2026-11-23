import {
  BASE_DIM,
  CompiledGenome,
  MipLevel,
  TissueType,
  mipDim,
  mipStride,
} from '../types/morphogenesis';
import {
  TISSUE_RGB_TABLE,
  createFullscreenQuadVAO,
  createProgram,
  createRGBA8Texture,
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

// GPU Blueprint + Level-Set Isolines + Sub-cell Grid + Brush Reticle Fragment Shader
const BLUEPRINT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;

uniform sampler2D uBlueprintTex; // 128x128: R = tissue/255
uniform sampler2D uPhiTex;       // dim x dim: R = normalized phi
uniform float uStride;
uniform float uShowPhi;
uniform vec2 uSeedPos;           // 0..128
uniform float uHasSeed;
uniform vec2 uCursorCell;
uniform float uHasCursor;
uniform float uBrushRadius;
uniform vec3 uBrushColor;

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
  vec2 simPos = vec2(vUv.x * 128.0, (1.0 - vUv.y) * 128.0);
  ivec2 p0 = clamp(ivec2(floor(simPos)), ivec2(0), ivec2(127));
  int tissue = int(floor(texelFetch(uBlueprintTex, p0, 0).r * 255.0 + 0.5));

  vec3 col = vec3(0.035, 0.047, 0.071);

  if (uShowPhi > 0.5) {
    vec2 mipUv = vec2(vUv.x, 1.0 - vUv.y);
    float phiNorm = texture(uPhiTex, mipUv).r; // 0.5 = zero-isoline
    float phi = (phiNorm - 0.5) * 24.0;
    if (phi > 0.0) {
      float intensity = clamp(phi / 10.0, 0.0, 1.0);
      col = mix(col, vec3(0.086, 0.45, 0.48), intensity * 0.42);
    } else {
      float band = abs(phi);
      if (band < 4.5) {
        col += vec3(0.024, 0.25, 0.35) * (1.0 - band / 4.5) * 0.3;
      }
    }
    // Crisp topographic isoline rings
    float iso = smoothstep(0.09, 0.0, abs(fract(phi * 0.45) - 0.5)) * 0.14;
    col += vec3(0.14, 0.72, 0.85) * iso;
  }

  if (tissue > 0) {
    col = tissueColor(tissue);
  }

  // Inspected mipmap grid lines
  float s = max(1.0, uStride);
  vec2 gm = mod(simPos, s);
  if (s >= 2.0 && (gm.x < 0.18 || gm.y < 0.18)) {
    col = mix(col, vec3(0.32, 0.41, 0.55), 0.34);
  }

  // Origin seed marker halo
  if (uHasSeed > 0.5) {
    float sd = length(simPos - uSeedPos);
    float ring = smoothstep(0.55, 0.15, abs(sd - 4.2));
    float dotC = 1.0 - smoothstep(1.2, 1.8, sd);
    col = mix(col, vec3(1.0), ring * 0.85 + dotC * 0.9);
  }

  // Hover brush reticle
  if (uHasCursor > 0.5) {
    float cd = length(simPos - uCursorCell);
    float ring = smoothstep(0.55, 0.1, abs(cd - max(0.8, uBrushRadius)));
    col = mix(col, uBrushColor, ring * 0.9);
  }

  outColor = vec4(col, 1.0);
}
`;

export class BlueprintGLRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private quadVAO: WebGLVertexArrayObject;
  private quadVBO: WebGLBuffer;

  private bpTex: WebGLTexture;
  private phiTex: WebGLTexture;
  private bpBytes = new Uint8Array(BASE_DIM * BASE_DIM * 4);
  private phiBytes = new Uint8Array(BASE_DIM * BASE_DIM * 4);
  private phiDim = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = createProgram(gl, QUAD_VERT, BLUEPRINT_FRAG);
    const q = createFullscreenQuadVAO(gl);
    this.quadVAO = q.vao;
    this.quadVBO = q.vbo;

    this.bpTex = createRGBA8Texture(gl, BASE_DIM, BASE_DIM, gl.NEAREST);
    this.phiTex = createRGBA8Texture(gl, BASE_DIM, BASE_DIM, gl.LINEAR);
  }

  render(
    blueprint: Uint8Array,
    genome: CompiledGenome,
    options: {
      sizePx: number;
      dpr: number;
      inspectLevel: MipLevel;
      showLevelSet: boolean;
      cursorCell: { x: number; y: number } | null;
      brushRadius: number;
      brushColor: [number, number, number];
    },
  ): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const target = Math.round(options.sizePx * options.dpr);
    if (canvas.width !== target || canvas.height !== target) {
      canvas.width = target;
      canvas.height = target;
    }

    // Upload blueprint texture
    for (let i = 0; i < BASE_DIM * BASE_DIM; i++) {
      const o = i * 4;
      this.bpBytes[o] = blueprint[i];
      this.bpBytes[o + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bpTex);
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

    // Upload inspected level-set phiGrid using pre-allocated phiBytes buffer
    const dim = mipDim(options.inspectLevel);
    const layer = genome.layers[options.inspectLevel];
    const len = dim * dim;
    for (let i = 0; i < len; i++) {
      const norm = Math.min(1, Math.max(0, layer.phiGrid[i] / 24 + 0.5));
      const b = (norm * 255) | 0;
      const o = i * 4;
      this.phiBytes[o] = b;
      this.phiBytes[o + 3] = 255;
    }
    const view = this.phiBytes.subarray(0, len * 4);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.phiTex);
    if (this.phiDim !== dim) {
      this.phiDim = dim;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, dim, dim, 0, gl.RGBA, gl.UNSIGNED_BYTE, view);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, dim, dim, gl.RGBA, gl.UNSIGNED_BYTE, view);
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.quadVAO);

    gl.uniform1i(gl.getUniformLocation(this.prog, 'uBlueprintTex'), 0);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uPhiTex'), 1);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uStride'), mipStride(options.inspectLevel));
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uShowPhi'), options.showLevelSet ? 1.0 : 0.0);

    const seed = genome.nodeById.get(genome.seedNodeId);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uHasSeed'), seed ? 1.0 : 0.0);
    if (seed) {
      gl.uniform2f(gl.getUniformLocation(this.prog, 'uSeedPos'), seed.physX, seed.physY);
    }

    gl.uniform1f(gl.getUniformLocation(this.prog, 'uHasCursor'), options.cursorCell ? 1.0 : 0.0);
    if (options.cursorCell) {
      gl.uniform2f(
        gl.getUniformLocation(this.prog, 'uCursorCell'),
        options.cursorCell.x,
        options.cursorCell.y,
      );
    }
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uBrushRadius'), options.brushRadius);
    gl.uniform3f(
      gl.getUniformLocation(this.prog, 'uBrushColor'),
      options.brushColor[0],
      options.brushColor[1],
      options.brushColor[2],
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.prog);
    gl.deleteTexture(this.bpTex);
    gl.deleteTexture(this.phiTex);
    gl.deleteBuffer(this.quadVBO);
    gl.deleteVertexArray(this.quadVAO);
  }
}
