import {
  CompiledGenome,
  MipLevel,
  NeuralNetState,
  SimState,
  SoftBodyMesh,
  SoftCell,
  SoftVertex,
  TissueType,
  WorldParams,
  mipDim,
} from '../types/morphogenesis';
import { NeuralObservation, createNeuralNetState, stepNeuralNet } from './neuralNet';
import { computePhysiologyConnectivity, sampleFineComposition } from './physiologyConnectivity';

const CELL_SIZE_L2 = 3.2; // World pixels per L2 cell (32x32 lattice -> max ~102px organism)
const CELL_SIZE_L3 = 6.4; // World pixels per L3 cell (16x16 lattice -> matches L2 scale)

// Pre-allocated fixed-size scratch buffers (zero per-frame allocations & GC)
const ADJ_OX = [-1, 1, 0, 0];
const ADJ_OY = [0, 0, -1, 1];
const MAX_LATTICE_CELLS = 1024;
const MAX_FLAT_VERTS = 1024;
const VERT_REMAP = new Int32Array(2048);
const COMP_VISITED = new Uint8Array(MAX_LATTICE_CELLS);
const COMP_Q = new Int32Array(MAX_LATTICE_CELLS);
const RUPTURE_SCRATCH: number[] = [];

// Contiguous L1-cached typed vertex arrays for hot 4-substep Verlet/Euler spring integration
const SV_X = new Float32Array(MAX_FLAT_VERTS);
const SV_Y = new Float32Array(MAX_FLAT_VERTS);
const SV_VX = new Float32Array(MAX_FLAT_VERTS);
const SV_VY = new Float32Array(MAX_FLAT_VERTS);
const SV_FX = new Float32Array(MAX_FLAT_VERTS);
const SV_FY = new Float32Array(MAX_FLAT_VERTS);
const SV_INV_MASS = new Float32Array(MAX_FLAT_VERTS);
const SV_PINNED = new Uint8Array(MAX_FLAT_VERTS);

const THRUST_DIR_OUT = { fxDir: 0, fyDir: 0, oscAngle: 0 };

const OBS_SCRATCH: NeuralObservation = {
  gradCross: 0,
  gradDot: 1,
  avgGradMag: 0,
  localFood: 0,
  localToxin: 0,
  forwardSpeed: 0,
  speed: 0,
  energyFactor: 1,
  neuralDensity: 0,
  neuralEfficiency: 1,
  gradientSensitivity: 1,
};

const PHYS_STEP_OUT = {
  steerBias: 0,
  sensorMagnitude: 0,
  speed: 0,
  metabolicBurn: 0,
  rupturedKeys: RUPTURE_SCRATCH,
};

function springNumKey(a: number, b: number): number {
  return a < b ? a * 65536 + b : b * 65536 + a;
}

/**
 * Allocates an empty deformable SoftBodyMesh seeded at `(centerX, centerY)`.
 */
export function createEmptySoftMesh(centerX: number, centerY: number, headingAngle: number): SoftBodyMesh {
  return {
    meshLevel: 3,
    cellSize: CELL_SIZE_L3,
    vertices: [],
    vertexIndexByCorner: new Map(),
    springs: [],
    springKeySet: new Set(),
    springIndexByKey: new Map(),
    cells: [],
    cellMap: new Map(),
    boundaryEdges: [],
    comX: centerX,
    comY: centerY,
    boundRadius: 24,
    headingAngle,
    angularVelocity: 0,
    totalArea: 0,
    targetTotalArea: 0,
    vascularEfficiency: 0.75,
    neuralEfficiency: 0.75,
    digestiveEfficiency: 0.65,
    excretoryEfficiency: 0.65,
    spikeCount: 0,
    lastSyncedTick: -1,
    lastSyncedCount: 0,
  };
}

/**
 * Rebuilds springs, perimeter boundary edges, flagella thrust orientation,
 * Vascular/Neural physiological connectivity, and compacts out orphaned vertices.
 */
export function rebuildSpringsAndBounds(mesh: SoftBodyMesh): void {
  const dim = mipDim(mesh.meshLevel);
  const cornerStride = dim + 1;
  const targetCellSize = mesh.cellSize;

  const vLen = mesh.vertices.length;
  const remap = vLen <= VERT_REMAP.length ? VERT_REMAP : new Int32Array(vLen);
  remap.fill(-1, 0, vLen);
  for (let i = 0; i < mesh.cells.length; i++) {
    const c = mesh.cells[i];
    remap[c.vTL] = 1;
    remap[c.vTR] = 1;
    remap[c.vBR] = 1;
    remap[c.vBL] = 1;
  }

  let writeIdx = 0;
  let droppedAny = false;
  for (let i = 0; i < vLen; i++) {
    if (remap[i] > 0) {
      remap[i] = writeIdx;
      if (writeIdx !== i) {
        mesh.vertices[writeIdx] = mesh.vertices[i];
      }
      writeIdx++;
    } else {
      droppedAny = true;
    }
  }

  if (droppedAny) {
    mesh.vertices.length = writeIdx;
    mesh.vertexIndexByCorner.clear();
    for (let i = 0; i < mesh.vertices.length; i++) {
      const v = mesh.vertices[i];
      mesh.vertexIndexByCorner.set(v.gy * cornerStride + v.gx, i);
    }
    for (let i = 0; i < mesh.cells.length; i++) {
      const c = mesh.cells[i];
      c.vTL = remap[c.vTL];
      c.vTR = remap[c.vTR];
      c.vBR = remap[c.vBR];
      c.vBL = remap[c.vBL];
    }
  }

  mesh.springs.length = 0;
  mesh.springKeySet.clear();
  mesh.springIndexByKey.clear();
  mesh.boundaryEdges.length = 0;

  if (mesh.cells.length === 0) {
    mesh.targetTotalArea = 0;
    mesh.boundRadius = 10;
    computePhysiologyConnectivity(mesh, dim);
    return;
  }

  computePhysiologyConnectivity(mesh, dim);

  let sumGx = 0;
  let sumGy = 0;
  for (let i = 0; i < mesh.cells.length; i++) {
    sumGx += mesh.cells[i].gx + 0.5;
    sumGy += mesh.cells[i].gy + 0.5;
  }
  const refCx = sumGx / mesh.cells.length;
  const refCy = sumGy / mesh.cells.length;

  const addSpring = (
    a: number,
    b: number,
    baseLength: number,
    isDiag: boolean,
    cell: SoftCell,
    sideBias: number,
  ) => {
    const sk = springNumKey(a, b);
    const existingIdx = mesh.springIndexByKey.get(sk);
    const isMuscle = cell.muscleWeight > 0.15 || cell.tissue === TissueType.MUSCLE;
    const couplingGain = (0.48 + 0.52 * cell.vascularSupply) * (0.52 + 0.48 * cell.neuralCoupling);
    if (existingIdx !== undefined) {
      if (isMuscle) mesh.springs[existingIdx].isMuscle = true;
      return;
    }
    const isSpike = cell.spikeWeight > 0.15 || cell.tissue === TissueType.SPIKE;
    const sIdx = mesh.springs.length;
    mesh.springIndexByKey.set(sk, sIdx);
    mesh.springs.push({
      v0: a,
      v1: b,
      baseLength,
      currentRestLength: baseLength,
      stiffness: isDiag ? 0.72 : isSpike ? 1.18 : isMuscle ? 1.02 * (0.75 + 0.25 * couplingGain) : 0.96,
      damping: 0.22,
      isDiagonal: isDiag,
      isMuscle,
      musclePhase: ((cell.gy - refCy) / Math.max(4, dim * 0.25)) * Math.PI * 1.4,
      sideBias,
      activation: 0,
    });
  };

  const diagLen = targetCellSize * Math.SQRT2;
  for (let i = 0; i < mesh.cells.length; i++) {
    const cell = mesh.cells[i];
    const sideBias = Math.max(-1, Math.min(1, (cell.gx + 0.5 - refCx) / 4));
    addSpring(cell.vTL, cell.vTR, targetCellSize, false, cell, sideBias);
    addSpring(cell.vTR, cell.vBR, targetCellSize, false, cell, sideBias);
    addSpring(cell.vBR, cell.vBL, targetCellSize, false, cell, sideBias);
    addSpring(cell.vBL, cell.vTL, targetCellSize, false, cell, sideBias);
    addSpring(cell.vTL, cell.vBR, diagLen, true, cell, sideBias);
    addSpring(cell.vTR, cell.vBL, diagLen, true, cell, sideBias);

    const hasN = cell.gy > 0 && mesh.cellMap.has((cell.gy - 1) * dim + cell.gx);
    const hasS = cell.gy < dim - 1 && mesh.cellMap.has((cell.gy + 1) * dim + cell.gx);
    const hasE = cell.gx < dim - 1 && mesh.cellMap.has(cell.gy * dim + (cell.gx + 1));
    const hasW = cell.gx > 0 && mesh.cellMap.has(cell.gy * dim + (cell.gx - 1));

    if (!hasN) mesh.boundaryEdges.push([cell.vTL, cell.vTR]);
    if (!hasE) mesh.boundaryEdges.push([cell.vTR, cell.vBR]);
    if (!hasS) mesh.boundaryEdges.push([cell.vBR, cell.vBL]);
    if (!hasW) mesh.boundaryEdges.push([cell.vBL, cell.vTL]);

    if (
      cell.flagellaWeight > 0.08 ||
      cell.tissue === TissueType.FLAGELLA ||
      cell.spikeWeight > 0.1 ||
      cell.tissue === TissueType.SPIKE
    ) {
      let tx = 0;
      let ty = 0;
      if (!hasN) ty += 1;
      if (!hasS) ty -= 1;
      if (!hasE) tx -= 1;
      if (!hasW) tx += 1;

      if (tx === 0 && ty === 0) {
        tx = (refCx - (cell.gx + 0.5)) * 0.25;
        ty = refCy - (cell.gy + 0.5);
      } else {
        tx += (refCx - (cell.gx + 0.5)) * 0.14;
        ty += (refCy - (cell.gy + 0.5)) * 0.22;
      }

      const len = Math.hypot(tx, ty);
      if (len > 1e-4) {
        cell.thrustDirX = tx / len;
        cell.thrustDirY = ty / len;
      } else {
        cell.thrustDirX = 0;
        cell.thrustDirY = -1;
      }
      cell.thrustDotForward = -cell.thrustDirY;
    } else {
      cell.thrustDotForward = 0;
    }
  }

  mesh.targetTotalArea = mesh.cells.length * targetCellSize * targetCellSize;
  updateMeshComAndRadius(mesh);
}

function updateMeshComAndRadius(mesh: SoftBodyMesh): void {
  const verts = mesh.vertices;
  if (verts.length === 0) {
    mesh.boundRadius = 10;
    return;
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < verts.length; i++) {
    sx += verts[i].x;
    sy += verts[i].y;
  }
  mesh.comX = sx / verts.length;
  mesh.comY = sy / verts.length;

  let maxR2 = 64;
  for (let i = 0; i < verts.length; i++) {
    const dx = verts[i].x - mesh.comX;
    const dy = verts[i].y - mesh.comY;
    const r2 = dx * dx + dy * dy;
    if (r2 > maxR2) maxR2 = r2;
  }
  mesh.boundRadius = Math.sqrt(maxR2) + 4;
}

/**
 * Synchronizes an organism's deformable SoftBodyMesh with its live morphogenesis SimState
 * across L3->L2 subdivision transitions and tissue additions/excisions.
 */
export function syncOrganismMeshFromSimState(
  mesh: SoftBodyMesh,
  simState: SimState,
  genome: CompiledGenome,
): void {
  const useL2 = simState.layers[2].activeCount > 0;
  const targetLevel: MipLevel = useL2 ? 2 : 3;
  const targetCellSize = useL2 ? CELL_SIZE_L2 : CELL_SIZE_L3;
  const layer = simState.layers[targetLevel];
  const dim = layer.dim;

  if (mesh.meshLevel !== targetLevel) {
    const preservedComX = mesh.comX;
    const preservedComY = mesh.comY;
    const preservedHeading = mesh.headingAngle;
    mesh.meshLevel = targetLevel;
    mesh.cellSize = targetCellSize;
    mesh.vertices.length = 0;
    mesh.vertexIndexByCorner.clear();
    mesh.springs.length = 0;
    mesh.springKeySet.clear();
    mesh.springIndexByKey.clear();
    mesh.cells.length = 0;
    mesh.cellMap.clear();
    mesh.boundaryEdges.length = 0;
    mesh.comX = preservedComX;
    mesh.comY = preservedComY;
    mesh.headingAngle = preservedHeading;
    mesh.angularVelocity = 0;
  }

  const compiled = genome.layers[targetLevel];
  let sumGx = 0;
  let sumGy = 0;
  let cCount = 0;
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      if (compiled.tissueGrid[y * dim + x] !== TissueType.EMPTY) {
        sumGx += x + 0.5;
        sumGy += y + 0.5;
        cCount++;
      }
    }
  }
  const refCx = cCount > 0 ? sumGx / cCount : dim / 2;
  const refCy = cCount > 0 ? sumGy / cCount : dim / 2;

  const rotAngle = mesh.headingAngle + Math.PI / 2;
  const rCos = Math.cos(rotAngle);
  const rSin = Math.sin(rotAngle);
  const cornerStride = dim + 1;

  const getOrCreateVertex = (cgx: number, cgy: number): number => {
    const cKey = cgy * cornerStride + cgx;
    const existing = mesh.vertexIndexByCorner.get(cKey);
    if (existing !== undefined) return existing;

    const lx = (cgx - refCx) * targetCellSize;
    const ly = (cgy - refCy) * targetCellSize;
    let wx = mesh.comX + (lx * rCos - ly * rSin);
    let wy = mesh.comY + (lx * rSin + ly * rCos);

    let adjSumX = 0;
    let adjSumY = 0;
    let adjN = 0;
    for (let a = 0; a < 4; a++) {
      const ox = ADJ_OX[a];
      const oy = ADJ_OY[a];
      const ncgx = cgx + ox;
      const ncgy = cgy + oy;
      if (ncgx < 0 || ncgx > dim || ncgy < 0 || ncgy > dim) continue;
      const nIdx = mesh.vertexIndexByCorner.get(ncgy * cornerStride + ncgx);
      if (nIdx !== undefined) {
        const nv = mesh.vertices[nIdx];
        const dlx = -ox * targetCellSize;
        const dly = -oy * targetCellSize;
        adjSumX += nv.x + (dlx * rCos - dly * rSin);
        adjSumY += nv.y + (dlx * rSin + dly * rCos);
        adjN++;
      }
    }
    if (adjN > 0) {
      wx = adjSumX / adjN;
      wy = adjSumY / adjN;
    }

    const vIdx = mesh.vertices.length;
    mesh.vertices.push({
      x: wx,
      y: wy,
      vx: 0,
      vy: 0,
      fx: 0,
      fy: 0,
      mass: 1.0,
      gx: cgx,
      gy: cgy,
    });
    mesh.vertexIndexByCorner.set(cKey, vIdx);
    return vIdx;
  };

  let topologyChanged = false;

  for (let i = mesh.cells.length - 1; i >= 0; i--) {
    const cell = mesh.cells[i];
    if (!layer.alive[cell.key]) {
      mesh.cellMap.delete(cell.key);
      mesh.cells.splice(i, 1);
      topologyChanged = true;
    }
  }

  for (let gy = 0; gy < dim; gy++) {
    for (let gx = 0; gx < dim; gx++) {
      const key = gy * dim + gx;
      if (!layer.alive[key]) continue;

      const comp = sampleFineComposition(simState, genome, targetLevel, gx, gy);
      let cell = mesh.cellMap.get(key);

      if (!cell) {
        const vTL = getOrCreateVertex(gx, gy);
        const vTR = getOrCreateVertex(gx + 1, gy);
        const vBR = getOrCreateVertex(gx + 1, gy + 1);
        const vBL = getOrCreateVertex(gx, gy + 1);

        const tdX = (refCx - (gx + 0.5)) * 0.3;
        const tdY = refCy - (gy + 0.5);
        const tLen = Math.hypot(tdX, tdY);

        cell = {
          key,
          gx,
          gy,
          meshLevel: targetLevel,
          vTL,
          vTR,
          vBR,
          vBL,
          tissue: layer.tissue[key] as TissueType,
          targetArea: targetCellSize * targetCellSize,
          currentArea: targetCellSize * targetCellSize,
          epidermisWeight: comp.epidermisWeight,
          mesodermWeight: comp.mesodermWeight,
          vascularWeight: comp.vascularWeight,
          neuralWeight: comp.neuralWeight,
          sensorWeight: comp.sensorWeight,
          muscleWeight: comp.muscleWeight,
          flagellaWeight: comp.flagellaWeight,
          digestiveWeight: comp.digestiveWeight,
          excretoryWeight: comp.excretoryWeight,
          spikeWeight: comp.spikeWeight,
          vascularSupply: 0.75,
          neuralCoupling: 0.75,
          activation: 0,
          thrustDirX: tLen > 1e-4 ? tdX / tLen : 0,
          thrustDirY: tLen > 1e-4 ? tdY / tLen : -1,
          thrustDotForward: tLen > 1e-4 ? -(tdY / tLen) : 1,
          gradientX: 0,
          gradientY: 0,
          crushStress: 0,
        };

        mesh.cells.push(cell);
        mesh.cellMap.set(key, cell);
        topologyChanged = true;
      } else {
        cell.tissue = layer.tissue[key] as TissueType;
        cell.epidermisWeight = comp.epidermisWeight;
        cell.mesodermWeight = comp.mesodermWeight;
        cell.vascularWeight = comp.vascularWeight;
        cell.neuralWeight = comp.neuralWeight;
        cell.sensorWeight = comp.sensorWeight;
        cell.muscleWeight = comp.muscleWeight;
        cell.flagellaWeight = comp.flagellaWeight;
        cell.digestiveWeight = comp.digestiveWeight;
        cell.excretoryWeight = comp.excretoryWeight;
        cell.spikeWeight = comp.spikeWeight;
      }
    }
  }

  if (topologyChanged) {
    rebuildSpringsAndBounds(mesh);
  }

  mesh.lastSyncedTick = simState.tick;
  mesh.lastSyncedCount = layer.activeCount;
}

/**
 * Flood-fills 4-connected cell components on `mesh.cellMap` using pre-allocated typed buffers.
 */
export function extractMeshComponents(mesh: SoftBodyMesh): number[][] {
  if (mesh.cells.length === 0) return [];
  const dim = mipDim(mesh.meshLevel);
  COMP_VISITED.fill(0, 0, dim * dim);
  const components: number[][] = [];

  for (let i = 0; i < mesh.cells.length; i++) {
    const startKey = mesh.cells[i].key;
    if (COMP_VISITED[startKey]) continue;

    const comp: number[] = [];
    COMP_VISITED[startKey] = 1;
    let qHead = 0;
    let qTail = 0;
    COMP_Q[qTail++] = startKey;

    while (qHead < qTail) {
      const k = COMP_Q[qHead++];
      comp.push(k);
      const gx = k % dim;
      const gy = (k - gx) / dim;

      if (gx > 0 && !COMP_VISITED[k - 1] && mesh.cellMap.has(k - 1)) {
        COMP_VISITED[k - 1] = 1;
        COMP_Q[qTail++] = k - 1;
      }
      if (gx < dim - 1 && !COMP_VISITED[k + 1] && mesh.cellMap.has(k + 1)) {
        COMP_VISITED[k + 1] = 1;
        COMP_Q[qTail++] = k + 1;
      }
      if (gy > 0 && !COMP_VISITED[k - dim] && mesh.cellMap.has(k - dim)) {
        COMP_VISITED[k - dim] = 1;
        COMP_Q[qTail++] = k - dim;
      }
      if (gy < dim - 1 && !COMP_VISITED[k + dim] && mesh.cellMap.has(k + dim)) {
        COMP_VISITED[k + dim] = 1;
        COMP_Q[qTail++] = k + dim;
      }
    }

    components.push(comp);
  }

  components.sort((a, b) => b.length - a.length);
  return components;
}

/**
 * Clones only cells in `keepKeys` (preserving deformed vertex positions & velocities)
 * into a fresh independent SoftBodyMesh.
 */
export function extractSubMeshByKeys(source: SoftBodyMesh, keepKeys: Set<number>): SoftBodyMesh {
  const dim = mipDim(source.meshLevel);
  const cornerStride = dim + 1;
  const sub = createEmptySoftMesh(source.comX, source.comY, source.headingAngle);
  sub.meshLevel = source.meshLevel;
  sub.cellSize = source.cellSize;
  sub.angularVelocity = source.angularVelocity;

  const copyVert = (srcIdx: number): number => {
    const sv = source.vertices[srcIdx];
    const cKey = sv.gy * cornerStride + sv.gx;
    const existing = sub.vertexIndexByCorner.get(cKey);
    if (existing !== undefined) return existing;
    const nIdx = sub.vertices.length;
    sub.vertices.push({ ...sv, fx: 0, fy: 0 });
    sub.vertexIndexByCorner.set(cKey, nIdx);
    return nIdx;
  };

  for (let i = 0; i < source.cells.length; i++) {
    const c = source.cells[i];
    if (!keepKeys.has(c.key)) continue;
    const clonedCell: SoftCell = {
      ...c,
      vTL: copyVert(c.vTL),
      vTR: copyVert(c.vTR),
      vBR: copyVert(c.vBR),
      vBL: copyVert(c.vBL),
      crushStress: 0,
    };
    sub.cells.push(clonedCell);
    sub.cellMap.set(clonedCell.key, clonedCell);
  }

  rebuildSpringsAndBounds(sub);
  return sub;
}

/**
 * Retains only mesh cells belonging to `keepKeys` in-place.
 */
export function retainMeshCellsByKeys(mesh: SoftBodyMesh, keepKeys: Set<number>): void {
  for (let i = mesh.cells.length - 1; i >= 0; i--) {
    const c = mesh.cells[i];
    if (!keepKeys.has(c.key)) {
      mesh.cellMap.delete(c.key);
      mesh.cells.splice(i, 1);
    }
  }
  rebuildSpringsAndBounds(mesh);
}

/**
 * Welds a severed fragment's deformed mesh vertices & cells back onto a host organism.
 */
export function mergeFragmentIntoMesh(host: SoftBodyMesh, frag: SoftBodyMesh): void {
  const dim = mipDim(host.meshLevel);
  const cornerStride = dim + 1;

  const importVert = (fragVertIdx: number): number => {
    const fv = frag.vertices[fragVertIdx];
    const cKey = fv.gy * cornerStride + fv.gx;
    const existing = host.vertexIndexByCorner.get(cKey);
    if (existing !== undefined) {
      const hv = host.vertices[existing];
      hv.x = hv.x * 0.55 + fv.x * 0.45;
      hv.y = hv.y * 0.55 + fv.y * 0.45;
      hv.vx = hv.vx * 0.5 + fv.vx * 0.5;
      hv.vy = hv.vy * 0.5 + fv.vy * 0.5;
      return existing;
    }
    const nIdx = host.vertices.length;
    host.vertices.push({ ...fv, fx: 0, fy: 0 });
    host.vertexIndexByCorner.set(cKey, nIdx);
    return nIdx;
  };

  for (let i = 0; i < frag.cells.length; i++) {
    const fc = frag.cells[i];
    if (host.cellMap.has(fc.key)) continue;
    const mergedCell: SoftCell = {
      ...fc,
      vTL: importVert(fc.vTL),
      vTR: importVert(fc.vTR),
      vBR: importVert(fc.vBR),
      vBL: importVert(fc.vBL),
      crushStress: 0,
    };
    host.cells.push(mergedCell);
    host.cellMap.set(mergedCell.key, mergedCell);
  }

  rebuildSpringsAndBounds(host);
}

export interface GradientSampler {
  sampleAttractant: (x: number, y: number) => number;
}

/**
 * Computes instantaneous world-space thrust vector for a Flagella cell, aligned with both
 * organism rigid heading and local deformed quad orientation plus steering/whip sweep.
 */
export function computeCellWorldThrustDir(
  c: SoftCell,
  verts: SoftVertex[],
  bodyHeadingAngle: number,
  steerBias: number,
  musclePhaseTime: number,
): typeof THRUST_DIR_OUT {
  const rotAngle = bodyHeadingAngle + Math.PI / 2;
  const rCos = Math.cos(rotAngle);
  const rSin = Math.sin(rotAngle);

  let wx = c.thrustDirX * rCos - c.thrustDirY * rSin;
  let wy = c.thrustDirX * rSin + c.thrustDirY * rCos;

  const v0 = verts[c.vTL];
  const v1 = verts[c.vTR];
  const v2 = verts[c.vBR];
  const v3 = verts[c.vBL];
  if (c.currentArea > c.targetArea * 0.45) {
    let eyX = (v3.x - v0.x + (v2.x - v1.x)) * 0.5;
    let eyY = (v3.y - v0.y + (v2.y - v1.y)) * 0.5;
    const eyLen = Math.hypot(eyX, eyY);
    if (eyLen > 1e-3) {
      eyX /= eyLen;
      eyY /= eyLen;
      let exX = (v1.x - v0.x + (v2.x - v3.x)) * 0.5;
      let exY = (v1.y - v0.y + (v2.y - v3.y)) * 0.5;
      const exLen = Math.hypot(exX, exY);
      if (exLen > 1e-3) {
        exX /= exLen;
        exY /= exLen;
        wx = wx * 0.78 + (c.thrustDirX * exX + c.thrustDirY * eyX) * 0.22;
        wy = wy * 0.78 + (c.thrustDirX * exY + c.thrustDirY * eyY) * 0.22;
      }
    }
  }

  const wLen = Math.hypot(wx, wy);
  if (wLen > 1e-4) {
    wx /= wLen;
    wy /= wLen;
  } else {
    wx = Math.cos(bodyHeadingAngle);
    wy = Math.sin(bodyHeadingAngle);
  }

  const oscScale = Math.min(1, Math.max(0.12, c.activation));
  const oscAngle =
    (Math.max(-0.32, Math.min(0.32, steerBias * 0.32)) +
      0.26 * Math.sin(musclePhaseTime * 1.4 + c.gx * 0.45)) *
    oscScale;
  const oc = Math.cos(oscAngle);
  const os = Math.sin(oscAngle);

  THRUST_DIR_OUT.fxDir = wx * oc - wy * os;
  THRUST_DIR_OUT.fyDir = wx * os + wy * oc;
  THRUST_DIR_OUT.oscAngle = oscAngle;
  return THRUST_DIR_OUT;
}

/**
 * Steps organism Soft-Body Physics using contiguous typed vertex arrays (`SV_*`) across
 * 4 velocity-Verlet/Euler substeps: Hooke springs, BoxEye internal gas pressure, neural-driven
 * flagella/muscle propulsion, fluid viscosity + spin clamping, and cell crush rupture tests.
 */
export function stepSoftBodyPhysics(
  mesh: SoftBodyMesh,
  sampler: GradientSampler,
  _worldWidth: number,
  _worldHeight: number,
  params: WorldParams,
  musclePhaseTime: number,
  prevSteerBias: number,
  energyFactor: number,
  neuralNet?: NeuralNetState,
  localFoodSample?: number,
  localToxinSample?: number,
  hostileProxSample?: number,
): typeof PHYS_STEP_OUT {
  RUPTURE_SCRATCH.length = 0;
  const verts = mesh.vertices;
  const cells = mesh.cells;
  const vCount = verts.length;
  if (vCount === 0 || cells.length === 0) {
    PHYS_STEP_OUT.steerBias = 0;
    PHYS_STEP_OUT.sensorMagnitude = 0;
    PHYS_STEP_OUT.speed = 0;
    PHYS_STEP_OUT.metabolicBurn = 0;
    return PHYS_STEP_OUT;
  }

  // Pack vertex fields into contiguous L1-friendly typed arrays
  let sumX = 0;
  let sumY = 0;
  let sumVx = 0;
  let sumVy = 0;
  const flatLimit = Math.min(vCount, MAX_FLAT_VERTS);
  for (let i = 0; i < flatLimit; i++) {
    const v = verts[i];
    SV_X[i] = v.x;
    SV_Y[i] = v.y;
    SV_VX[i] = v.vx;
    SV_VY[i] = v.vy;
    SV_INV_MASS[i] = 1 / v.mass;
    SV_PINNED[i] = v.pinned ? 1 : 0;
    sumX += v.x;
    sumY += v.y;
    sumVx += v.vx;
    sumVy += v.vy;
  }

  const invN = 1 / flatLimit;
  mesh.comX = sumX * invN;
  mesh.comY = sumY * invN;
  const avgVx = sumVx * invN;
  const avgVy = sumVy * invN;

  let maxR2 = 64;
  for (let i = 0; i < flatLimit; i++) {
    const dx = SV_X[i] - mesh.comX;
    const dy = SV_Y[i] - mesh.comY;
    const r2 = dx * dx + dy * dy;
    if (r2 > maxR2) maxR2 = r2;
  }
  mesh.boundRadius = Math.sqrt(maxR2) + 4;

  // Estimate body rigid heading from deformed cell lattice orientation (Kabsch 2D fit)
  let avgGx = 0;
  let avgGy = 0;
  let minGy = Infinity;
  let maxGy = -Infinity;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    avgGx += c.gx;
    avgGy += c.gy;
    if (c.gy < minGy) minGy = c.gy;
    if (c.gy > maxGy) maxGy = c.gy;
  }
  avgGx /= cells.length;
  avgGy /= cells.length;
  const midGy = (minGy + maxGy) * 0.5;

  let fitA = 0;
  let fitB = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const lx = c.gx - avgGx;
    const ly = c.gy - avgGy;
    const wx = (SV_X[c.vTL] + SV_X[c.vTR] + SV_X[c.vBR] + SV_X[c.vBL]) * 0.25 - mesh.comX;
    const wy = (SV_Y[c.vTL] + SV_Y[c.vTR] + SV_Y[c.vBR] + SV_Y[c.vBL]) * 0.25 - mesh.comY;
    fitA += lx * wx + ly * wy;
    fitB += lx * wy - ly * wx;
  }
  if (Math.hypot(fitA, fitB) > 1e-3) {
    const targetHeading = Math.atan2(fitB, fitA) - Math.PI / 2;
    let delta = targetHeading - mesh.headingAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    mesh.headingAngle += Math.max(-0.15, Math.min(0.15, delta));
  }

  const headX = Math.cos(mesh.headingAngle);
  const headY = Math.sin(mesh.headingAngle);

  // Sample spatial chemical attractant gradients across Sensor cells
  let gradSumCross = 0;
  let gradSumDot = 0;
  let gradSumMag = 0;
  let sensorWeightTotal = 0;
  let neuralWeightTotal = 0;
  const sampleDelta = 18;

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    neuralWeightTotal += c.neuralWeight;
    const sw = c.sensorWeight * (0.45 + 0.55 * c.neuralCoupling);
    if (sw < 0.05) {
      c.gradientX = 0;
      c.gradientY = 0;
      continue;
    }

    const cx = (SV_X[c.vTL] + SV_X[c.vTR] + SV_X[c.vBR] + SV_X[c.vBL]) * 0.25;
    const cy = (SV_Y[c.vTL] + SV_Y[c.vTR] + SV_Y[c.vBR] + SV_Y[c.vBL]) * 0.25;

    const gx =
      (sampler.sampleAttractant(cx + sampleDelta, cy) -
        sampler.sampleAttractant(cx - sampleDelta, cy)) /
      (2 * sampleDelta);
    const gy =
      (sampler.sampleAttractant(cx, cy + sampleDelta) -
        sampler.sampleAttractant(cx, cy - sampleDelta)) /
      (2 * sampleDelta);

    c.gradientX = gx;
    c.gradientY = gy;

    const mag = Math.hypot(gx, gy);
    if (mag > 1e-7) {
      gradSumCross += ((headX * gy - headY * gx) / mag) * sw * mag;
      gradSumDot += ((headX * gx + headY * gy) / mag) * sw * mag;
      gradSumMag += mag * sw;
      sensorWeightTotal += sw;
    }
  }

  const avgGradMag = sensorWeightTotal > 0 ? gradSumMag / sensorWeightTotal : 0;
  const sensorMagnitude = sensorWeightTotal > 0 ? Math.min(1, avgGradMag * 48) : 0;

  // Step 6-neuron Auto-Regressive Residual Neural Network controller
  const activeNet = neuralNet ?? createNeuralNetState();
  if (!neuralNet) activeNet.neurons[0].state = prevSteerBias;

  OBS_SCRATCH.gradCross = gradSumMag > 1e-7 ? gradSumCross / gradSumMag : 0;
  OBS_SCRATCH.gradDot = gradSumMag > 1e-7 ? gradSumDot / gradSumMag : 1.0;
  OBS_SCRATCH.avgGradMag = avgGradMag;
  OBS_SCRATCH.localFood =
    localFoodSample !== undefined ? localFoodSample : sampler.sampleAttractant(mesh.comX, mesh.comY);
  OBS_SCRATCH.localToxin = localToxinSample ?? 0;
  OBS_SCRATCH.forwardSpeed = avgVx * headX + avgVy * headY;
  OBS_SCRATCH.speed = Math.hypot(avgVx, avgVy);
  OBS_SCRATCH.energyFactor = energyFactor;
  OBS_SCRATCH.neuralDensity = cells.length > 0 ? neuralWeightTotal / cells.length : 0;
  OBS_SCRATCH.neuralEfficiency = mesh.neuralEfficiency;
  OBS_SCRATCH.gradientSensitivity = params.gradientSensitivity;
  OBS_SCRATCH.hostileProx = hostileProxSample ?? 0;
  OBS_SCRATCH.spikeDensity = cells.length > 0 ? mesh.spikeCount / cells.length : 0;

  stepNeuralNet(activeNet, OBS_SCRATCH);

  const steerBias = activeNet.steerOut;
  const cruiseThrottle = activeNet.cruiseOut;
  const brakeThrottle = activeNet.brakeOut;
  const gaitScale = activeNet.gaitOut;

  // Update muscle contractile rest lengths modulated by Vascular & Neural supply
  const activeScale = energyFactor > 0.02 ? 0.35 + 0.65 * energyFactor : 0;
  const orgCouplingScale = (0.45 + 0.55 * mesh.vascularEfficiency) * (0.48 + 0.52 * mesh.neuralEfficiency);
  const amp = Math.min(0.28, params.muscleStrength * 0.78) * activeScale * gaitScale * orgCouplingScale;
  let muscleWorkSum = 0;
  let muscleSpringCount = 0;

  for (let i = 0; i < mesh.springs.length; i++) {
    const s = mesh.springs[i];
    if (s.isMuscle) {
      const wave = Math.sin(musclePhaseTime - s.musclePhase);
      const act = Math.max(-1, Math.min(1, wave * 0.65 + steerBias * s.sideBias * 0.55));
      s.activation = act;
      s.currentRestLength = s.baseLength * (1 - amp * act);
      muscleWorkSum += Math.abs(act) * params.muscleStrength * orgCouplingScale;
      muscleSpringCount++;
    } else {
      s.activation = 0;
      s.currentRestLength = s.baseLength;
    }
  }

  const SUBSTEPS = 4;
  const dt = 0.64 / SUBSTEPS;
  const dragFactor = Math.pow(1 - Math.min(0.4, params.fluidDrag), 1 / SUBSTEPS);
  const rotDragPerSubstep = Math.min(0.32, (params.fluidDrag * 3.6 + 0.12) / SUBSTEPS);

  let flagellaWorkSum = 0;
  let flagellaCellCount = 0;
  const kCellPressure = 0.88 * params.internalPressure;

  for (let step = 0; step < SUBSTEPS; step++) {
    SV_FX.fill(0, 0, flatLimit);
    SV_FY.fill(0, 0, flatLimit);

    // A. Hooke Springs + Relative Velocity Damping
    for (let i = 0; i < mesh.springs.length; i++) {
      const s = mesh.springs[i];
      const i0 = s.v0;
      const i1 = s.v1;
      const dx = SV_X[i1] - SV_X[i0];
      const dy = SV_Y[i1] - SV_Y[i0];
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-5) continue;

      const nx = dx / dist;
      const ny = dy / dist;
      const damp = ((SV_VX[i1] - SV_VX[i0]) * nx + (SV_VY[i1] - SV_VY[i0]) * ny) * s.damping;
      const force = s.stiffness * (dist - s.currentRestLength) + damp;
      const fx = force * nx;
      const fy = force * ny;
      SV_FX[i0] += fx;
      SV_FY[i0] += fy;
      SV_FX[i1] -= fx;
      SV_FY[i1] -= fy;
    }

    // B. BoxEye Cell Gas Pressure + Flagella / Muscle Propulsion
    let totalSignedArea = 0;
    let bodyThrustX = 0;
    let bodyThrustY = 0;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const i0 = c.vTL;
      const i1 = c.vTR;
      const i2 = c.vBR;
      const i3 = c.vBL;
      const x0 = SV_X[i0], y0 = SV_Y[i0];
      const x1 = SV_X[i1], y1 = SV_Y[i1];
      const x2 = SV_X[i2], y2 = SV_Y[i2];
      const x3 = SV_X[i3], y3 = SV_Y[i3];

      const area =
        0.5 *
        (x0 * y1 - x1 * y0 + (x1 * y2 - x2 * y1) + (x2 * y3 - x3 * y2) + (x3 * y0 - x0 * y3));
      c.currentArea = area;
      totalSignedArea += area;

      const safeArea = Math.max(c.targetArea * 0.35, area);
      const pressure = Math.max(-1.8, Math.min(3.2, (kCellPressure * (c.targetArea - area)) / safeArea));

      if (area > c.targetArea * 0.25) {
        const halfP = 0.5 * pressure;
        let pfX = halfP * (y1 - y0), pfY = halfP * -(x1 - x0);
        SV_FX[i0] += pfX; SV_FY[i0] += pfY; SV_FX[i1] += pfX; SV_FY[i1] += pfY;

        pfX = halfP * (y2 - y1); pfY = halfP * -(x2 - x1);
        SV_FX[i1] += pfX; SV_FY[i1] += pfY; SV_FX[i2] += pfX; SV_FY[i2] += pfY;

        pfX = halfP * (y3 - y2); pfY = halfP * -(x3 - x2);
        SV_FX[i2] += pfX; SV_FY[i2] += pfY; SV_FX[i3] += pfX; SV_FY[i3] += pfY;

        pfX = halfP * (y0 - y3); pfY = halfP * -(x0 - x3);
        SV_FX[i3] += pfX; SV_FY[i3] += pfY; SV_FX[i0] += pfX; SV_FY[i0] += pfY;
      } else {
        const cx = (x0 + x1 + x2 + x3) * 0.25;
        const cy = (y0 + y1 + y2 + y3) * 0.25;
        const h = mesh.cellSize * 0.52;
        const rot = mesh.headingAngle + Math.PI / 2;
        const rc = Math.cos(rot), rs = Math.sin(rot);
        const kUnfold = 2.4;
        SV_FX[i0] += (cx + (-h * rc + h * rs) - x0) * kUnfold;
        SV_FY[i0] += (cy + (-h * rs - h * rc) - y0) * kUnfold;
        SV_FX[i1] += (cx + (h * rc + h * rs) - x1) * kUnfold;
        SV_FY[i1] += (cy + (h * rs - h * rc) - y1) * kUnfold;
        SV_FX[i2] += (cx + (h * rc - h * rs) - x2) * kUnfold;
        SV_FY[i2] += (cy + (h * rs + h * rc) - y2) * kUnfold;
        SV_FX[i3] += (cx + (-h * rc - h * rs) - x3) * kUnfold;
        SV_FY[i3] += (cy + (-h * rs + h * rc) - y3) * kUnfold;
      }

      if (step === SUBSTEPS - 1) {
        c.crushStress *= 0.86;
        if (area < c.targetArea * 0.34) {
          c.crushStress += ((c.targetArea * 0.34 - area) / c.targetArea) * 1.4;
        }
        const ruptureThresh = c.spikeWeight > 0.15 ? 1.55 : 1.15;
        if (c.crushStress > ruptureThresh || area < c.targetArea * 0.16) {
          RUPTURE_SCRATCH.push(c.key);
        }
      }

      if (c.flagellaWeight > 0.05) {
        const throttle = c.thrustDotForward < -0.15 ? brakeThrottle : cruiseThrottle;
        if (throttle > 0.03) {
          // Sync latest vertex positions for first corner calc in thrust dir
          verts[i0].x = x0; verts[i0].y = y0;
          verts[i1].x = x1; verts[i1].y = y1;
          verts[i2].x = x2; verts[i2].y = y2;
          verts[i3].x = x3; verts[i3].y = y3;
          const dir = computeCellWorldThrustDir(c, verts, mesh.headingAngle, steerBias, musclePhaseTime);
          const supply = c.vascularSupply * (0.48 + 0.52 * c.neuralCoupling);
          const beat = (0.78 + 0.22 * Math.sin(musclePhaseTime * 1.4 + c.gx * 0.5)) * throttle;
          const totalCellThrust = params.flagellaThrust * c.flagellaWeight * beat * activeScale * supply * 2.35;
          c.activation = beat;

          if (step === 0) {
            flagellaWorkSum += c.flagellaWeight * beat * params.flagellaThrust * supply;
            flagellaCellCount++;
          }
          bodyThrustX += dir.fxDir * totalCellThrust;
          bodyThrustY += dir.fyDir * totalCellThrust;
        } else {
          c.activation = 0;
        }
      } else if (c.muscleWeight > 0.12) {
        const supply = c.vascularSupply * (0.48 + 0.52 * c.neuralCoupling);
        const act = Math.sin(musclePhaseTime - (c.gy - midGy) * 0.45);
        c.activation = act * (0.25 + 0.75 * cruiseThrottle) * supply;
        const fwdThrust =
          Math.abs(act) * c.muscleWeight * params.muscleStrength * 2.05 * activeScale * cruiseThrottle * supply;
        bodyThrustX += headX * fwdThrust;
        bodyThrustY += headY * fwdThrust;
      }
    }

    if (
      Math.abs(bodyThrustX) > 1e-6 ||
      Math.abs(bodyThrustY) > 1e-6 ||
      Math.abs(steerBias) > 1e-4
    ) {
      const distX = bodyThrustX * invN;
      const distY = bodyThrustY * invN;
      let r2Sum = 0;
      for (let i = 0; i < flatLimit; i++) {
        const dx = SV_X[i] - mesh.comX;
        const dy = SV_Y[i] - mesh.comY;
        r2Sum += dx * dx + dy * dy;
      }
      const avgR = Math.max(6, Math.sqrt(r2Sum * invN));
      const effectorGain = 0.55 + 0.45 * Math.min(2.0, params.flagellaThrust + params.muscleStrength);
      const neuralSteerGain = 0.42 + 0.58 * mesh.neuralEfficiency;
      const torqueNorm = steerBias * activeScale * effectorGain * neuralSteerGain * (0.48 / avgR);
      for (let i = 0; i < flatLimit; i++) {
        const rx = SV_X[i] - mesh.comX;
        const ry = SV_Y[i] - mesh.comY;
        SV_FX[i] += distX - ry * torqueNorm;
        SV_FY[i] += distY + rx * torqueNorm;
      }
    }

    mesh.totalArea = totalSignedArea;

    // C. Body Perimeter Ideal Gas Pressure
    if (mesh.boundaryEdges.length > 0 && mesh.targetTotalArea > 0) {
      const safeBodyArea = Math.max(mesh.targetTotalArea * 0.35, totalSignedArea);
      const bodyPressure = Math.max(
        -0.8,
        Math.min(1.8, (0.42 * params.internalPressure * (mesh.targetTotalArea - totalSignedArea)) / safeBodyArea),
      );
      for (let i = 0; i < mesh.boundaryEdges.length; i++) {
        const [ia, ib] = mesh.boundaryEdges[i];
        const pfX = 0.5 * bodyPressure * (SV_Y[ib] - SV_Y[ia]);
        const pfY = 0.5 * bodyPressure * -(SV_X[ib] - SV_X[ia]);
        SV_FX[ia] += pfX; SV_FY[ia] += pfY;
        SV_FX[ib] += pfX; SV_FY[ib] += pfY;
      }
    }

    // D. Integrate Velocities + Linear/Rotational Fluid Drag + Clamp
    let curVxSum = 0;
    let curVySum = 0;
    for (let i = 0; i < flatLimit; i++) {
      if (SV_PINNED[i]) continue;
      SV_VX[i] = (SV_VX[i] + SV_FX[i] * SV_INV_MASS[i] * dt) * dragFactor;
      SV_VY[i] = (SV_VY[i] + SV_FY[i] * SV_INV_MASS[i] * dt) * dragFactor;
      curVxSum += SV_VX[i];
      curVySum += SV_VY[i];
    }

    const linVx = curVxSum * invN;
    const linVy = curVySum * invN;
    let angL = 0;
    let inertia = 0;
    for (let i = 0; i < flatLimit; i++) {
      const rx = SV_X[i] - mesh.comX;
      const ry = SV_Y[i] - mesh.comY;
      angL += rx * (SV_VY[i] - linVy) - ry * (SV_VX[i] - linVx);
      inertia += rx * rx + ry * ry;
    }
    const omega = inertia > 1.0 ? angL / inertia : 0;
    const maxOmega = 0.055;
    const clampedExcess = Math.abs(omega) > maxOmega ? omega - Math.sign(omega) * maxOmega : 0;
    const spinCancel = omega * rotDragPerSubstep + clampedExcess * 0.65;
    mesh.angularVelocity = omega - spinCancel;

    for (let i = 0; i < flatLimit; i++) {
      if (SV_PINNED[i]) continue;
      if (spinCancel !== 0) {
        const rx = SV_X[i] - mesh.comX;
        const ry = SV_Y[i] - mesh.comY;
        SV_VX[i] -= -ry * spinCancel;
        SV_VY[i] -= rx * spinCancel;
      }
      const spd = Math.hypot(SV_VX[i], SV_VY[i]);
      if (spd > 14) {
        SV_VX[i] = (SV_VX[i] / spd) * 14;
        SV_VY[i] = (SV_VY[i] / spd) * 14;
      }
      SV_X[i] += SV_VX[i] * dt;
      SV_Y[i] += SV_VY[i] * dt;
    }
  }

  // Write contiguous typed simulation state back to SoftVertex objects once per frame
  for (let i = 0; i < flatLimit; i++) {
    const v = verts[i];
    v.x = SV_X[i];
    v.y = SV_Y[i];
    v.vx = SV_VX[i];
    v.vy = SV_VY[i];
  }

  const avgMuscleWork = muscleSpringCount > 0 ? muscleWorkSum / muscleSpringCount : 0;
  const avgFlagellaWork = flagellaCellCount > 0 ? flagellaWorkSum / flagellaCellCount : 0;

  PHYS_STEP_OUT.steerBias = steerBias;
  PHYS_STEP_OUT.sensorMagnitude = sensorMagnitude;
  PHYS_STEP_OUT.speed = Math.hypot(avgVx, avgVy);
  PHYS_STEP_OUT.metabolicBurn = (avgMuscleWork * 0.028 + avgFlagellaWork * 0.01) * params.metabolismRate;
  return PHYS_STEP_OUT;
}
