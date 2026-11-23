import { createTransformFeedbackProgram, createProgram } from './glUtils';
import {
  GLOW_POINT_FRAG,
  PARTICLE_RENDER_VERT,
  PARTICLE_TF_FRAG,
  PARTICLE_TF_VERT,
} from './WorldGpuShaders';

const MOTE_COUNT = 160;
const FLOATS_PER_MOTE = 8; // aState (x, y, vx, vy), aMeta (age, maxAge, size, seed)

/**
 * Self-contained WebGL2 Transform Feedback particle engine animating ambient
 * suspended plankton/bubbles/ice crystals purely on the GPU using ping-pong VBOs.
 */
export class ParticleTFPass {
  private gl: WebGL2RenderingContext;
  private tfProg: WebGLProgram;
  private renderProg: WebGLProgram;

  private vboA: WebGLBuffer;
  private vboB: WebGLBuffer;
  private vaoA: WebGLVertexArrayObject;
  private vaoB: WebGLVertexArrayObject;
  private tfObj: WebGLTransformFeedback;
  private ping = false;

  private uTfWorldSize: WebGLUniformLocation | null;
  private uTfCurrent: WebGLUniformLocation | null;
  private uTfDt: WebGLUniformLocation | null;

  private uRndWorldSize: WebGLUniformLocation | null;
  private uRndDpr: WebGLUniformLocation | null;
  private uRndColor: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext, worldWidth: number, worldHeight: number) {
    this.gl = gl;
    this.tfProg = createTransformFeedbackProgram(
      gl,
      PARTICLE_TF_VERT,
      PARTICLE_TF_FRAG,
      ['vNextState', 'vNextMeta'],
    );
    this.renderProg = createProgram(gl, PARTICLE_RENDER_VERT, GLOW_POINT_FRAG);

    this.uTfWorldSize = gl.getUniformLocation(this.tfProg, 'uWorldSize');
    this.uTfCurrent = gl.getUniformLocation(this.tfProg, 'uCurrent');
    this.uTfDt = gl.getUniformLocation(this.tfProg, 'uDt');

    this.uRndWorldSize = gl.getUniformLocation(this.renderProg, 'uWorldSize');
    this.uRndDpr = gl.getUniformLocation(this.renderProg, 'uDpr');
    this.uRndColor = gl.getUniformLocation(this.renderProg, 'uMoteColor');

    const initData = new Float32Array(MOTE_COUNT * FLOATS_PER_MOTE);
    for (let i = 0; i < MOTE_COUNT; i++) {
      const o = i * FLOATS_PER_MOTE;
      initData[o] = Math.random() * worldWidth;
      initData[o + 1] = Math.random() * worldHeight;
      initData[o + 2] = (Math.random() - 0.5) * 0.25;
      initData[o + 3] = (Math.random() - 0.5) * 0.25;
      initData[o + 4] = Math.random() * 8.0;
      initData[o + 5] = 5.0 + Math.random() * 5.0;
      initData[o + 6] = 2.0 + Math.random() * 2.8;
      initData[o + 7] = Math.random();
    }

    const setupPair = (): { vbo: WebGLBuffer; vao: WebGLVertexArrayObject } => {
      const vao = gl.createVertexArray()!;
      const vbo = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, initData, gl.DYNAMIC_COPY);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
      gl.bindVertexArray(null);
      return { vbo, vao };
    };

    const pA = setupPair();
    const pB = setupPair();
    this.vboA = pA.vbo;
    this.vaoA = pA.vao;
    this.vboB = pB.vbo;
    this.vaoB = pB.vao;

    this.tfObj = gl.createTransformFeedback()!;
  }

  /**
   * Advances Transform Feedback buffer physics and renders subtle biome water motes.
   */
  stepAndRender(
    worldWidth: number,
    worldHeight: number,
    currentX: number,
    currentY: number,
    dt: number,
    dpr: number,
    colorRgb: [number, number, number],
  ): void {
    const gl = this.gl;
    const srcVao = this.ping ? this.vaoB : this.vaoA;
    const dstVao = this.ping ? this.vaoA : this.vaoB;
    const dstVbo = this.ping ? this.vboA : this.vboB;
    this.ping = !this.ping;

    // 1. Transform Feedback GPU simulation step (zero CPU readback)
    gl.useProgram(this.tfProg);
    gl.uniform2f(this.uTfWorldSize, worldWidth, worldHeight);
    gl.uniform2f(this.uTfCurrent, currentX, currentY);
    gl.uniform1f(this.uTfDt, dt);

    gl.bindVertexArray(srcVao);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tfObj);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, dstVbo);

    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, MOTE_COUNT);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);

    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

    // 2. Render updated GPU buffer directly as soft biome motes
    gl.useProgram(this.renderProg);
    gl.uniform2f(this.uRndWorldSize, worldWidth, worldHeight);
    gl.uniform1f(this.uRndDpr, dpr);
    gl.uniform3f(this.uRndColor, colorRgb[0], colorRgb[1], colorRgb[2]);
    gl.bindVertexArray(dstVao);
    gl.drawArrays(gl.POINTS, 0, MOTE_COUNT);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.tfProg);
    gl.deleteProgram(this.renderProg);
    gl.deleteTransformFeedback(this.tfObj);
    gl.deleteBuffer(this.vboA);
    gl.deleteBuffer(this.vboB);
    gl.deleteVertexArray(this.vaoA);
    gl.deleteVertexArray(this.vaoB);
  }
}
