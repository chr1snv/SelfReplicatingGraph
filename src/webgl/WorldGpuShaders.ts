import { TissueType } from '../types/morphogenesis';
import { TISSUE_RGB_TABLE } from './glUtils';

/** Fullscreen pass vertex shader */
export const QUAD_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/** GPU 160x100 ping-pong chemical diffusion + temporal decay shader */
export const CHEM_DIFFUSE_FRAG = `#version 300 es
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
  vec3 coupled = mix(diffused.rgb, raw.rgb, 0.68);
  outColor = vec4(coupled, 1.0);
}
`;

/** Fullscreen biome fluid backdrop, volumetric sunlight rays, chemical plumes & Battle barrier shader */
export const WORLD_BG_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uChemTex;
uniform vec2 uWorldSize;
uniform float uShowChem;
uniform float uTime;

uniform float uShaderStyle;
uniform vec3 uBgInner;
uniform vec3 uBgOuter;
uniform vec3 uSunTint;
uniform float uSunLevel;
uniform vec4 uSunZones[3];

uniform float uBattleEnabled;
uniform float uBarrierActive;
uniform float uBarrierX;
uniform float uBarrierHp;

out vec4 outColor;

float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 worldPos = vec2(vUv.x * uWorldSize.x, (1.0 - vUv.y) * uWorldSize.y);
  vec2 centerDelta = vUv - vec2(0.5);
  float radial = dot(centerDelta, centerDelta);
  vec3 base = mix(uBgInner, uBgOuter, clamp(radial * 1.9, 0.0, 1.0));

  if (uShaderStyle > 1.5 && uShaderStyle < 2.5) {
    float veinCoord = (worldPos.y - uWorldSize.y * 0.5) - 0.35 * (worldPos.x - uWorldSize.x * 0.5);
    float subVein = abs(sin((worldPos.x * 0.015 + abs(veinCoord) * 0.028)));
    float leafRim = smoothstep(0.46, 0.50, length(centerDelta * vec2(1.0, 1.08)));
    base += vec3(0.03, 0.09, 0.04) * (1.0 - subVein) * 0.32;
    base = mix(base, vec3(0.015, 0.042, 0.024), leafRim * 0.65);
  } else if (uShaderStyle > 2.5 && uShaderStyle < 3.5) {
    float f1 = abs(fract((worldPos.x * 0.008 + worldPos.y * 0.005) + 0.2 * sin(worldPos.y * 0.01)) - 0.5);
    float f2 = abs(fract((worldPos.x * -0.006 + worldPos.y * 0.009)) - 0.5);
    float facet = smoothstep(0.035, 0.0, min(f1, f2));
    base += vec3(0.14, 0.28, 0.42) * facet * 0.35;
  } else if (uShaderStyle > 3.5) {
    vec2 cell = floor(worldPos * 0.025);
    float sp = step(0.96, hash2(cell));
    float tw = 0.5 + 0.5 * sin(uTime * 1.8 + hash2(cell + 3.1) * 6.28);
    base += vec3(0.24, 0.16, 0.55) * sp * tw * 0.25;
  } else if (uShaderStyle > 0.5 && uShaderStyle < 1.5) {
    float wave = sin(worldPos.x * 0.025 + uTime * 0.9) * cos(worldPos.y * 0.028 - uTime * 0.7);
    base += vec3(0.02, 0.07, 0.09) * max(0.0, wave) * 0.35;
  }

  vec2 g = mod(worldPos, 80.0);
  float grid = max(step(g.x, 0.95), step(g.y, 0.95)) * (1.0 - step(worldPos.x, 1.0)) * (1.0 - step(worldPos.y, 1.0));
  base += vec3(0.024, 0.036, 0.056) * grid;

  if (uSunLevel > 0.05) {
    float sunGlow = 0.0;
    for (int i = 0; i < 3; i++) {
      vec4 sz = uSunZones[i];
      if (sz.z > 1.0) {
        float d = length(worldPos - sz.xy);
        float k = clamp(1.0 - d / sz.z, 0.0, 1.0);
        sunGlow += k * k * sz.w;
      }
    }
    float rayWave = 0.85 + 0.15 * sin((worldPos.x * 0.012 - worldPos.y * 0.018) + uTime * 0.45);
    base += uSunTint * sunGlow * uSunLevel * 0.16 * rayWave;
  }

  if (uShowChem > 0.5) {
    vec2 chemUv = vec2(vUv.x, 1.0 - vUv.y);
    vec3 chem = texture(uChemTex, chemUv).rgb;
    float food = clamp(chem.r * 1.45, 0.0, 1.0);
    float scent = clamp(chem.g * 1.35, 0.0, 1.0);
    float toxin = clamp(chem.b * 1.5, 0.0, 1.0);

    float shimmer = 0.92 + 0.08 * sin(worldPos.x * 0.032 + uTime * 1.4) * cos(worldPos.y * 0.032 - uTime * 1.1);
    base += vec3(0.06, 0.65, 0.44) * food * 0.5 * shimmer;
    base += vec3(0.82, 0.48, 0.34) * scent * 0.28;
    base += vec3(0.86, 0.18, 0.34) * toxin * 0.55;

    float foodContour = smoothstep(0.022, 0.0, abs(fract(food * 4.5) - 0.5)) * smoothstep(0.12, 0.25, food);
    base += vec3(0.14, 0.85, 0.58) * foodContour * 0.085;
  }

  if (uBattleEnabled > 0.5) {
    float dxWall = abs(worldPos.x - uBarrierX);
    if (uBarrierActive > 0.5) {
      float core = exp(-dxWall * dxWall * 0.08);
      float aura = exp(-dxWall * dxWall * 0.0025);
      float pulse = 0.72 + 0.28 * sin(worldPos.y * 0.06 - uTime * 5.0);
      vec3 wallCol = mix(vec3(0.95, 0.32, 0.45), vec3(0.22, 0.86, 0.98), uBarrierHp);
      base += wallCol * (core * 0.85 + aura * 0.22) * pulse;
    } else {
      float scar = exp(-dxWall * dxWall * 0.05) * 0.12;
      base += vec3(0.25, 0.55, 0.75) * scar;
    }
  }

  outColor = vec4(base, 1.0);
}
`;

const rgbLit = (t: TissueType) => TISSUE_RGB_TABLE[t].map((v) => v.toFixed(4)).join(', ');

/**
 * GPU-Instanced Soft-Body Cell Vertex Shader:
 * Offloads bilinear corner positioning, tissue color lookup, and Battle faction
 * palette shifting from CPU loops directly into WebGL2 hardware.
 */
export const CELL_INSTANCED_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCornerUv; // Unit quad TRIANGLE_STRIP: (0,0), (1,0), (0,1), (1,1)
layout(location = 1) in vec4 aP01;      // (TL.x, TL.y, TR.x, TR.y)
layout(location = 2) in vec4 aP23;      // (BR.x, BR.y, BL.x, BL.y)
layout(location = 3) in vec4 aMeta;     // (tissueId, factionMode, alpha, dmgFlash)
layout(location = 4) in float aMusclePulse;

uniform vec2 uWorldSize;
out vec2 vCellUv;
out vec4 vColorAlpha;
out vec2 vFx;

vec3 lookupTissueColor(int t) {
  if (t == 1) return vec3(${rgbLit(TissueType.EPIDERMIS)});
  if (t == 2) return vec3(${rgbLit(TissueType.MESODERM)});
  if (t == 3) return vec3(${rgbLit(TissueType.VASCULAR)});
  if (t == 4) return vec3(${rgbLit(TissueType.NEURAL)});
  if (t == 5) return vec3(${rgbLit(TissueType.SENSOR)});
  if (t == 6) return vec3(${rgbLit(TissueType.MUSCLE)});
  if (t == 7) return vec3(${rgbLit(TissueType.FLAGELLA)});
  if (t == 8) return vec3(${rgbLit(TissueType.DIGESTIVE)});
  if (t == 9) return vec3(${rgbLit(TissueType.EXCRETORY)});
  if (t == 10) return vec3(${rgbLit(TissueType.SPIKE)});
  return vec3(${rgbLit(TissueType.MESODERM)});
}

void main() {
  vec2 topPos = mix(aP01.xy, aP01.zw, aCornerUv.x);
  vec2 botPos = mix(aP23.zw, aP23.xy, aCornerUv.x);
  vec2 pos = mix(topPos, botPos, aCornerUv.y);

  vec3 col = lookupTissueColor(int(aMeta.x + 0.5));
  int fMode = int(aMeta.y + 0.5);
  if (fMode == 1) {
    // Player faction cool cyan tint shift
    col = vec3(col.r * 0.56 + 0.06, min(1.0, col.g * 0.72 + 0.26), min(1.0, col.b * 0.70 + 0.38));
  } else if (fMode == 2) {
    // AI swarm warm crimson tint shift
    col = vec3(min(1.0, col.r * 0.62 + 0.44), col.g * 0.52 + 0.05, col.b * 0.44 + 0.06);
  } else if (fMode == 3) {
    // Uncontrolled wild hybrid neutral shift
    col = vec3(col.r * 0.52 + 0.32, col.g * 0.52 + 0.29, col.b * 0.52 + 0.14);
  }

  vec2 ndc = vec2(
    (pos.x / uWorldSize.x) * 2.0 - 1.0,
    1.0 - (pos.y / uWorldSize.y) * 2.0
  );
  vCellUv = aCornerUv;
  vColorAlpha = vec4(col, aMeta.z);
  vFx = vec2(aMeta.w, aMusclePulse);
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const CELL_INSTANCED_FRAG = `#version 300 es
precision highp float;
in vec2 vCellUv;
in vec4 vColorAlpha;
in vec2 vFx;
out vec4 outColor;

void main() {
  vec2 d = abs(vCellUv - vec2(0.5)) * 2.0;
  float edgeDist = 1.0 - max(d.x, d.y);
  float corner = length(max(d - vec2(0.72), 0.0));
  if (corner > 0.28) discard;

  vec3 col = vColorAlpha.rgb;
  float border = smoothstep(0.14, 0.0, edgeDist);
  col = mix(col, col * 0.55 + vec3(0.06, 0.10, 0.14), border * 0.65);
  col += vec3(0.28, 0.08, 0.22) * vFx.y;
  col = mix(col, vec3(0.98, 0.44, 0.52), clamp(vFx.x * 0.65, 0.0, 0.8));

  float nuc = 1.0 - smoothstep(0.08, 0.22, length(vCellUv - vec2(0.5)));
  col += col * nuc * 0.22;

  outColor = vec4(col, vColorAlpha.a);
}
`;

export const LINE_VERT = `#version 300 es
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

export const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  outColor = vColor;
}
`;

/**
 * GPU-Instanced Flagella Whip & Rear-Anchored Thrust Vector Shader:
 * Generates both the 4-segment sinusoidal traveling whip wave and the rear thrust
 * direction arrow directly from `gl_VertexID` (0..13) on the GPU.
 */
export const FLAGELLA_INSTANCED_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aBaseThrust; // (cx, cy, thrustDirX, thrustDirY)
layout(location = 1) in vec4 aParams;     // (whipLen, phase, alpha, isBraking)
layout(location = 2) in float aShowArrow;

uniform vec2 uWorldSize;
out vec4 vColor;

vec2 computeWhipPoint(vec2 base, vec2 whipDir, vec2 perp, float segT, float whipLen, float phase) {
  float wave = sin(segT * 4.7 - phase) * segT * 4.5;
  return base + whipDir * (segT * whipLen) + perp * wave;
}

void main() {
  vec2 base = aBaseThrust.xy;
  vec2 thrustDir = aBaseThrust.zw;
  vec2 whipDir = -thrustDir;
  vec2 perp = vec2(-whipDir.y, whipDir.x);

  float whipLen = aParams.x;
  float phase = aParams.y;
  float alpha = aParams.z;
  bool isBraking = aParams.w > 0.5;

  int vid = gl_VertexID;
  vec2 pos = base;
  vec4 col = vec4(0.768, 0.71, 0.992, alpha);

  if (vid < 8) {
    // 4 line segments [0..3]: (0,1), (2,3), (4,5), (6,7)
    int segIdx = vid / 2;
    int endFlag = vid - segIdx * 2;
    float segT = (float(segIdx) + float(endFlag)) * 0.25;
    pos = computeWhipPoint(base, whipDir, perp, segT, whipLen, phase);
    col.a *= (1.0 - segT * 0.22);
  } else {
    // Thrust arrow anchored strictly behind (cx, cy) pushing toward thrustDir
    float throttleGuess = clamp((alpha - 0.26) / 0.70, 0.0, 1.0);
    float arrowLen = 6.5 + throttleGuess * 10.5;
    vec2 sx = base - thrustDir * arrowLen;
    vec2 tx = base - thrustDir * 1.5;
    vec2 back = -thrustDir;
    vec2 side = vec2(-thrustDir.y, thrustDir.x);
    float headLen = 2.8;
    float headHalf = 1.7;

    if (vid == 8) pos = sx;
    else if (vid == 9 || vid == 10 || vid == 12) pos = tx;
    else if (vid == 11) pos = tx + back * headLen + side * headHalf;
    else pos = tx + back * headLen - side * headHalf;

    vec3 arrowRgb = isBraking ? vec3(0.98, 0.65, 0.24) : vec3(0.22, 0.92, 0.98);
    float aa = aShowArrow * clamp(0.28 + throttleGuess * 0.55, 0.0, 0.92);
    col = vec4(arrowRgb, aa);
  }

  vec2 ndc = vec2(
    (pos.x / uWorldSize.x) * 2.0 - 1.0,
    1.0 - (pos.y / uWorldSize.y) * 2.0
  );
  vColor = col;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const GLOW_POINT_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aSize;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aKind; // 0 = detritus pellet, 0.5 = photosynthetic flora, 1 = eye, 2 = pixel heart, 3 = GPU mote

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

export const GLOW_POINT_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
in float vKind;
out vec4 outColor;

int heartPixelMask(int ix, int iy) {
  if (iy == 0) return (ix == 1 || ix == 2 || ix == 6 || ix == 7) ? 1 : 0;
  if (iy == 1) return ((ix >= 0 && ix <= 3) || (ix >= 5 && ix <= 8)) ? 1 : 0;
  if (iy == 2) return (ix >= 0 && ix <= 8) ? 1 : 0;
  if (iy == 3) return (ix >= 0 && ix <= 8) ? 1 : 0;
  if (iy == 4) return (ix >= 1 && ix <= 7) ? 1 : 0;
  if (iy == 5) return (ix >= 2 && ix <= 6) ? 1 : 0;
  if (iy == 6) return (ix >= 3 && ix <= 5) ? 1 : 0;
  if (iy == 7) return (ix == 4) ? 1 : 0;
  return 0;
}

void main() {
  if (vKind > 2.5) {
    // GPU Transform-Feedback suspended biome mote / bubble
    vec2 p = (gl_PointCoord - vec2(0.5)) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a = (1.0 - smoothstep(0.2, 1.0, r)) * vColor.a;
    outColor = vec4(vColor.rgb, a);
    return;
  }

  if (vKind > 1.5) {
    ivec2 gp = ivec2(floor(gl_PointCoord * vec2(9.0, 9.0)));
    if (gp.x < 0 || gp.x >= 9 || gp.y < 0 || gp.y >= 8) discard;
    if (heartPixelMask(gp.x, gp.y) == 0) discard;
    bool isGlint = (gp.x == 1 && gp.y == 1) || (gp.x == 2 && gp.y == 1) || (gp.x == 1 && gp.y == 2);
    bool isShade = (gp.x >= 6 && gp.y >= 3) || gp.y >= 6;
    vec3 heartCol = isGlint ? vec3(1.0, 0.94, 0.96) : isShade ? vec3(0.86, 0.18, 0.38) : vec3(0.99, 0.44, 0.56);
    outColor = vec4(heartCol, vColor.a);
    return;
  }

  vec2 p = (gl_PointCoord - vec2(0.5)) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;

  if (vKind < 0.25) {
    float halo = exp(-r * r * 3.8) * 0.42;
    float core = 1.0 - smoothstep(0.24, 0.34, r);
    float ring = smoothstep(0.06, 0.0, abs(r - 0.36)) * 0.55;
    vec3 col = mix(vColor.rgb, vec3(0.43, 0.91, 0.72), core * 0.7 + ring * 0.4);
    outColor = vec4(col, clamp(halo + core * 0.95 + ring, 0.0, 1.0) * vColor.a);
  } else if (vKind < 0.75) {
    float ang = atan(p.y, p.x);
    float petal = 0.28 + 0.06 * cos(ang * 5.0);
    float halo = exp(-r * r * 3.0) * 0.5;
    float core = 1.0 - smoothstep(petal - 0.05, petal + 0.05, r);
    float sunRing = smoothstep(0.07, 0.0, abs(r - 0.46)) * 0.55;
    vec3 col = mix(vec3(0.24, 0.88, 0.44), vec3(0.86, 0.98, 0.42), core * 0.65 + sunRing * 0.5);
    outColor = vec4(col, clamp(halo + core * 0.95 + sunRing, 0.0, 1.0) * vColor.a);
  } else {
    float dotA = 1.0 - smoothstep(0.65, 1.0, r);
    outColor = vec4(vColor.rgb, vColor.a * dotA);
  }
}
`;

/**
 * WebGL2 Transform Feedback Particle Step Shader:
 * Simulates ambient biome plankton motes & floating fluid buoyancy particles on GPU
 * via ping-pong VBOs without CPU loops.
 */
export const PARTICLE_TF_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aState; // (x, y, vx, vy)
layout(location = 1) in vec4 aMeta;  // (age, maxAge, size, seed)

uniform vec2 uWorldSize;
uniform vec2 uCurrent;
uniform float uDt;

out vec4 vNextState;
out vec4 vNextMeta;

void main() {
  vec2 pos = aState.xy;
  vec2 vel = aState.zw;
  float age = aMeta.x + uDt;
  float maxAge = aMeta.y;
  float size = aMeta.z;
  float seed = aMeta.w;

  // Hydrodynamic swirl + biome fluid current
  float sway = sin(age * 1.3 + seed * 6.2831) * 0.14;
  vel.x = vel.x * 0.985 + uCurrent.x * 0.35 + sway * 0.04;
  vel.y = vel.y * 0.985 + uCurrent.y * 0.35 - 0.018;
  pos += vel * (uDt * 18.0);

  // Seamless toroidal boundary wrap for continuous fluid ambiance
  if (pos.x < 0.0) pos.x += uWorldSize.x;
  if (pos.x >= uWorldSize.x) pos.x -= uWorldSize.x;
  if (pos.y < 0.0) pos.y += uWorldSize.y;
  if (pos.y >= uWorldSize.y) pos.y -= uWorldSize.y;

  if (age >= maxAge) {
    age = 0.0;
  }

  vNextState = vec4(pos, vel);
  vNextMeta = vec4(age, maxAge, size, seed);
}
`;

export const PARTICLE_TF_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.0); }
`;

export const PARTICLE_RENDER_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aState;
layout(location = 1) in vec4 aMeta;

uniform vec2 uWorldSize;
uniform float uDpr;
uniform vec3 uMoteColor;
out vec4 vColor;
out float vKind;

void main() {
  float lifeNorm = aMeta.x / max(1.0, aMeta.y);
  float envAlpha = sin(lifeNorm * 3.1415926) * 0.24;
  vec2 ndc = vec2(
    (aState.x / uWorldSize.x) * 2.0 - 1.0,
    1.0 - (aState.y / uWorldSize.y) * 2.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = aMeta.z * uDpr;
  vColor = vec4(uMoteColor, envAlpha);
  vKind = 3.0;
}
`;

/**
 * GPU-Instanced Faint Alpha-Blended ATP % Overlay Shader:
 * Renders procedural 4x5 pixel bitmap numerals ('0'..'9' + '%') directly over each
 * organism in WebGL2 with zero HTML DOM updates.
 */
export const ATP_GLYPH_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCornerUv; // TRIANGLE_STRIP (0,0), (1,0), (0,1), (1,1)
layout(location = 1) in vec4 aRect;     // (topLeftX, topLeftY, width, height)
layout(location = 2) in float aGlyphId; // 0..9 digits, 10 = '%'
layout(location = 3) in vec4 aColorAlpha;

uniform vec2 uWorldSize;
out vec2 vUv;
out float vGlyphId;
out vec4 vColorAlpha;

void main() {
  vec2 pos = aRect.xy + aCornerUv * aRect.zw;
  vec2 ndc = vec2(
    (pos.x / uWorldSize.x) * 2.0 - 1.0,
    1.0 - (pos.y / uWorldSize.y) * 2.0
  );
  vUv = aCornerUv;
  vGlyphId = aGlyphId;
  vColorAlpha = aColorAlpha;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const ATP_GLYPH_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in float vGlyphId;
in vec4 vColorAlpha;
out vec4 outColor;

// 4x5 monochrome bitmap font encoded as 4-bit row nibbles (bit 3 = left, bit 0 = right)
int glyphRowBits(int g, int row) {
  if (g == 0) {
    if (row == 0 || row == 4) return 6;  // 0110
    return 9;                            // 1001
  }
  if (g == 1) {
    if (row == 0) return 2;              // 0010
    if (row == 1) return 6;              // 0110
    if (row == 4) return 7;              // 0111
    return 2;                            // 0010
  }
  if (g == 2) {
    if (row == 0) return 14;             // 1110
    if (row == 1) return 1;              // 0001
    if (row == 2) return 6;              // 0110
    if (row == 3) return 8;              // 1000
    return 15;                           // 1111
  }
  if (g == 3) {
    if (row == 0 || row == 4) return 14; // 1110
    if (row == 2) return 6;              // 0110
    return 1;                            // 0001
  }
  if (g == 4) {
    if (row == 0 || row == 1) return 9;  // 1001
    if (row == 2) return 15;             // 1111
    return 1;                            // 0001
  }
  if (g == 5) {
    if (row == 0 || row == 2) return 15; // 1111
    if (row == 1) return 8;              // 1000
    if (row == 3) return 1;              // 0001
    return 14;                           // 1110
  }
  if (g == 6) {
    if (row == 0) return 6;              // 0110
    if (row == 1) return 8;              // 1000
    if (row == 2) return 14;             // 1110
    if (row == 3) return 9;              // 1001
    return 6;                            // 0110
  }
  if (g == 7) {
    if (row == 0) return 15;             // 1111
    if (row == 1) return 1;              // 0001
    if (row == 2) return 2;              // 0010
    return 4;                            // 0100
  }
  if (g == 8) {
    if (row == 0 || row == 2 || row == 4) return 6; // 0110
    return 9;                                       // 1001
  }
  if (g == 9) {
    if (row == 0) return 6;              // 0110
    if (row == 1) return 9;              // 1001
    if (row == 2) return 7;              // 0111
    if (row == 3) return 1;              // 0001
    return 6;                            // 0110
  }
  // g == 10: '%'
  if (row == 0) return 9;  // 1001
  if (row == 1) return 2;  // 0010
  if (row == 2) return 4;  // 0100
  if (row == 3) return 2;  // 0010
  return 9;                // 1001
}

void main() {
  ivec2 px = ivec2(floor(vUv * vec2(4.0, 5.0)));
  if (px.x < 0 || px.x >= 4 || px.y < 0 || px.y >= 5) discard;
  int bits = glyphRowBits(int(vGlyphId + 0.5), px.y);
  int on = (bits >> (3 - px.x)) & 1;
  if (on == 0) discard;
  outColor = vColorAlpha;
}
`;
