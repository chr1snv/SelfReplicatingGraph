import { TISSUE_SPECS, TissueType } from '../types/morphogenesis';

export function hexToRgbNorm(hex: string): [number, number, number] {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  if (clean.length !== 6) return [0, 0, 0];
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

export const TISSUE_RGB_TABLE: Record<TissueType, [number, number, number]> = {
  [TissueType.EMPTY]: hexToRgbNorm(TISSUE_SPECS[TissueType.EMPTY].color),
  [TissueType.EPIDERMIS]: hexToRgbNorm(TISSUE_SPECS[TissueType.EPIDERMIS].color),
  [TissueType.MESODERM]: hexToRgbNorm(TISSUE_SPECS[TissueType.MESODERM].color),
  [TissueType.VASCULAR]: hexToRgbNorm(TISSUE_SPECS[TissueType.VASCULAR].color),
  [TissueType.NEURAL]: hexToRgbNorm(TISSUE_SPECS[TissueType.NEURAL].color),
  [TissueType.SENSOR]: hexToRgbNorm(TISSUE_SPECS[TissueType.SENSOR].color),
  [TissueType.MUSCLE]: hexToRgbNorm(TISSUE_SPECS[TissueType.MUSCLE].color),
  [TissueType.FLAGELLA]: hexToRgbNorm(TISSUE_SPECS[TissueType.FLAGELLA].color),
  [TissueType.DIGESTIVE]: hexToRgbNorm(TISSUE_SPECS[TissueType.DIGESTIVE].color),
  [TissueType.EXCRETORY]: hexToRgbNorm(TISSUE_SPECS[TissueType.EXCRETORY].color),
  [TissueType.SPIKE]: hexToRgbNorm(TISSUE_SPECS[TissueType.SPIKE].color),
};

export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Failed to allocate WebGL2 shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compile error: ${log}`);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertSource: string,
  fragSource: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error('Failed to allocate WebGL2 program');
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? 'Unknown link error';
    gl.deleteProgram(prog);
    throw new Error(`WebGL2 program link error: ${log}`);
  }
  return prog;
}

/**
 * Links a WebGL2 Transform Feedback shader program declaring captured vertex output varyings.
 */
export function createTransformFeedbackProgram(
  gl: WebGL2RenderingContext,
  vertSource: string,
  fragSource: string,
  varyings: string[],
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error('Failed to allocate WebGL2 TF program');
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.transformFeedbackVaryings(prog, varyings, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? 'Unknown TF link error';
    gl.deleteProgram(prog);
    throw new Error(`WebGL2 TF program link error: ${log}`);
  }
  return prog;
}

export function createRGBA8Texture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  filter: number,
  data: Uint8Array | null = null,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Failed to create WebGL2 texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return tex;
}

export interface RenderTargetFBO {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  filter: number,
): RenderTargetFBO {
  const tex = createRGBA8Texture(gl, width, height, filter, null);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('Failed to create WebGL2 FBO');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, width, height };
}

export function createFullscreenQuadVAO(gl: WebGL2RenderingContext): {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
} {
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) throw new Error('Failed to create fullscreen quad VAO');
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const verts = new Float32Array([
    -1, -1, 0, 0,
     1, -1, 1, 0,
    -1,  1, 0, 1,
     1,  1, 1, 1,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);
  return { vao, vbo };
}
