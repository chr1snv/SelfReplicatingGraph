import {
  BASE_DIM,
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
import { createNeuralNetState, stepNeuralNet } from './neuralNet';

const CELL_SIZE_L2 = 3.2; // World pixels per L2 cell (32x32 lattice -> max ~102px organism)
const CELL_SIZE_L3 = 6.4; // World pixels per L3 cell (16x16 lattice -> matches L2 scale)

function springNumKey(a: number, b: number): number {
  return a < b ? a * 65536 + b : b * 65536 + a;
}

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
    lastSyncedTick: -1,
    lastSyncedCount: 0,
  };
}

function sampleFineComposition(
  simState: SimState,
  genome: CompiledGenome,
  meshLevel: MipLevel,
  gx: number,
  gy: number,
) {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  let total = 0;

  const stride = 1 << meshLevel;
  const sx = gx * stride;
  const sy = gy * stride;
  const l0 = simState.layers[0];

  for (let dy = 0; dy < stride; dy++) {
    for (let dx = 0; dx < stride; dx++) {
      const px = sx + dx;
      const py = sy + dy;
      if (px >= BASE_DIM || py >= BASE_DIM) continue;
      const idx0 = py * BASE_DIM + px;
      if (l0.alive[idx0]) {
        const t = l0.tissue[idx0];
        counts[t]++;
        total++;
      }
    }
  }

  if (total === 0) {
    const layer = simState.layers[meshLevel];
    const t = layer.tissue[gy * layer.dim + gx];
    counts[t] = 1;
    total = 1;

    const bp = genome.blueprint;
    for (let dy = 0; dy < stride; dy++) {
      for (let dx = 0; dx < stride; dx++) {
        const bt = bp[(sy + dy) * BASE_DIM + (sx + dx)];
        if (bt !== TissueType.EMPTY) {
          counts[bt] += 0.25;
          total += 0.25;
        }
      }
    }
  }

  return {
    epidermisWeight: counts[TissueType.EPIDERMIS] / total,
    mesodermWeight: counts[TissueType.MESODERM] / total,
    vascularWeight: counts[TissueType.VASCULAR] / total,
    neuralWeight: counts[TissueType.NEURAL] / total,
    sensorWeight: counts[TissueType.SENSOR] / total,
    muscleWeight: counts[TissueType.MUSCLE] / total,
    flagellaWeight: counts[TissueType.FLAGELLA] / total,
  };
}

/**
 * Rebuilds springs, boundary edges, thrust orientation (forward vs opposing brake flagella),
 * and prunes orphaned vertices no longer attached to any living cell.
 */
export function rebuildSpringsAndBounds(mesh: SoftBodyMesh): void {
  const dim = mipDim(mesh.meshLevel);
  const cornerStride = dim + 1;
  const targetCellSize = mesh.cellSize;

  // Compact out orphaned vertices left behind by cell rupture
  const remap = new Int32Array(mesh.vertices.length);
  remap.fill(-1);
  for (let i = 0; i < mesh.cells.length; i++) {
    const c = mesh.cells[i];
    remap[c.vTL] = 1;
    remap[c.vTR] = 1;
    remap[c.vBR] = 1;
    remap[c.vBL] = 1;
  }

  let writeIdx = 0;
  let droppedAny = false;
  for (let i = 0; i < mesh.vertices.length; i++) {
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

  mesh.springs = [];
  mesh.springKeySet.clear();
  mesh.springIndexByKey.clear();
  mesh.boundaryEdges = [];

  if (mesh.cells.length === 0) {
    mesh.targetTotalArea = 0;
    mesh.boundRadius = 10;
    return;
  }

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
    if (existingIdx !== undefined) {
      if (isMuscle) mesh.springs[existingIdx].isMuscle = true;
      return;
    }
    const sIdx = mesh.springs.length;
    mesh.springIndexByKey.set(sk, sIdx);
    mesh.springs.push({
      v0: a,
      v1: b,
      baseLength,
      currentRestLength: baseLength,
      stiffness: isDiag ? 0.72 : isMuscle ? 1.02 : 0.96,
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

    // Exposed-membrane thrust vector: pushes inward away from empty medium so
    // posterior flagella drive forward (-Y) while anterior/shoulder flagella push backward (+Y) to brake!
    if (cell.flagellaWeight > 0.08 || cell.tissue === TissueType.FLAGELLA) {
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
        // Gentle inward bias toward body center
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
      // Blueprint anterior is -Y, so alignment with forward propulsion is -thrustDirY
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
 * Synchronizes an organism's deformable SoftBodyMesh with its live morphogenesis SimState.
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
    mesh.vertices = [];
    mesh.vertexIndexByCorner.clear();
    mesh.springs = [];
    mesh.springKeySet.clear();
    mesh.springIndexByKey.clear();
    mesh.cells = [];
    mesh.cellMap.clear();
    mesh.boundaryEdges = [];
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

    const adjOffsets: [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    let adjSumX = 0;
    let adjSumY = 0;
    let adjN = 0;
    for (let a = 0; a < 4; a++) {
      const ox = adjOffsets[a][0];
      const oy = adjOffsets[a][1];
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
          ...comp,
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
 * Flood-fills 4-connected cell components on `mesh.cellMap`.
 * Returns arrays of cell keys sorted largest-component-first.
 */
export function extractMeshComponents(mesh: SoftBodyMesh): number[][] {
  if (mesh.cells.length === 0) return [];
  const dim = mipDim(mesh.meshLevel);
  const visited = new Set<number>();
  const components: number[][] = [];
  const queue: number[] = [];

  for (let i = 0; i < mesh.cells.length; i++) {
    const startKey = mesh.cells[i].key;
    if (visited.has(startKey)) continue;

    const comp: number[] = [];
    visited.add(startKey);
    queue.length = 0;
    queue.push(startKey);

    let head = 0;
    while (head < queue.length) {
      const k = queue[head++];
      comp.push(k);
      const gx = k % dim;
      const gy = (k - gx) / dim;

      if (gx > 0) {
        const nk = k - 1;
        if (!visited.has(nk) && mesh.cellMap.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
      if (gx < dim - 1) {
        const nk = k + 1;
        if (!visited.has(nk) && mesh.cellMap.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
      if (gy > 0) {
        const nk = k - dim;
        if (!visited.has(nk) && mesh.cellMap.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
      if (gy < dim - 1) {
        const nk = k + dim;
        if (!visited.has(nk) && mesh.cellMap.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }

    components.push(comp);
  }

  components.sort((a, b) => b.length - a.length);
  return components;
}

/**
 * Clones only the cells in `keepKeys` (with exact deformed vertex coordinates & velocities)
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
    const vTL = copyVert(c.vTL);
    const vTR = copyVert(c.vTR);
    const vBR = copyVert(c.vBR);
    const vBL = copyVert(c.vBL);
    const clonedCell: SoftCell = {
      ...c,
      vTL,
      vTR,
      vBR,
      vBL,
      crushStress: 0,
    };
    sub.cells.push(clonedCell);
    sub.cellMap.set(clonedCell.key, clonedCell);
  }

  rebuildSpringsAndBounds(sub);
  return sub;
}

/**
 * Keeps only cells in `keepKeys` inside `mesh` in-place (pruning orphaned vertices & broken springs).
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
 * Merges a disconnected fragment's deformed SoftBodyMesh back into the host SoftBodyMesh,
 * welding shared seam vertices and rebuilding springs across the healed interface.
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
      // Blend shared seam corner gently so the reconnected edge closes without snapping
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
    const vTL = importVert(fc.vTL);
    const vTR = importVert(fc.vTR);
    const vBR = importVert(fc.vBR);
    const vBL = importVert(fc.vBL);
    const mergedCell: SoftCell = {
      ...fc,
      vTL,
      vTR,
      vBR,
      vBL,
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

export function computeCellWorldThrustDir(
  c: SoftCell,
  verts: SoftVertex[],
  bodyHeadingAngle: number,
  steerBias: number,
  musclePhaseTime: number,
): { fxDir: number; fyDir: number; oscAngle: number } {
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
        const localX = c.thrustDirX * exX + c.thrustDirY * eyX;
        const localY = c.thrustDirX * exY + c.thrustDirY * eyY;
        wx = wx * 0.78 + localX * 0.22;
        wy = wy * 0.78 + localY * 0.22;
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

  // Only oscillate proportionally to current duty activation; idle/stopped flagella sit aligned
  const oscScale = Math.min(1, Math.max(0.12, c.activation));
  const oscAngle =
    (Math.max(-0.32, Math.min(0.32, steerBias * 0.32)) +
      0.26 * Math.sin(musclePhaseTime * 1.4 + c.gx * 0.45)) *
    oscScale;
  const oc = Math.cos(oscAngle);
  const os = Math.sin(oscAngle);

  return {
    fxDir: wx * oc - wy * os,
    fyDir: wx * os + wy * oc,
    oscAngle,
  };
}

// Reusable scratch array for ruptured cell keys (avoids per-tick garbage collection)
const RUPTURE_SCRATCH: number[] = [];

/**
 * Steps Soft-Body Physics:
 * - Hooke Springs + Muscle Contraction
 * - BoxEye Internal Gas Pressure (zero-allocation unrolled edges + anti-inversion guard)
 * - Gradient Sensor Steering + Forward Flagella Stopping + Opposing Brake Flagella
 * - Rotational Fluid Drag Damping (prevents rapid spinning)
 * - Squish Damage Detection (cell rupture keys)
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
): {
  steerBias: number;
  sensorMagnitude: number;
  speed: number;
  metabolicBurn: number;
  rupturedKeys: number[];
} {
  RUPTURE_SCRATCH.length = 0;
  const verts = mesh.vertices;
  const cells = mesh.cells;
  if (verts.length === 0 || cells.length === 0) {
    return {
      steerBias: 0,
      sensorMagnitude: 0,
      speed: 0,
      metabolicBurn: 0,
      rupturedKeys: RUPTURE_SCRATCH,
    };
  }

  // 1. Update Center of Mass, Tight Bounding Radius & Least-Squares Procrustes Heading
  let sumX = 0;
  let sumY = 0;
  let sumVx = 0;
  let sumVy = 0;
  for (let i = 0; i < verts.length; i++) {
    sumX += verts[i].x;
    sumY += verts[i].y;
    sumVx += verts[i].vx;
    sumVy += verts[i].vy;
  }
  const invN = 1 / verts.length;
  mesh.comX = sumX * invN;
  mesh.comY = sumY * invN;
  const avgVx = sumVx * invN;
  const avgVy = sumVy * invN;

  let maxR2 = 64;
  for (let i = 0; i < verts.length; i++) {
    const dx = verts[i].x - mesh.comX;
    const dy = verts[i].y - mesh.comY;
    const r2 = dx * dx + dy * dy;
    if (r2 > maxR2) maxR2 = r2;
  }
  mesh.boundRadius = Math.sqrt(maxR2) + 4;

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
    const wx =
      (verts[c.vTL].x + verts[c.vTR].x + verts[c.vBR].x + verts[c.vBL].x) * 0.25 - mesh.comX;
    const wy =
      (verts[c.vTL].y + verts[c.vTR].y + verts[c.vBR].y + verts[c.vBL].y) * 0.25 - mesh.comY;
    fitA += lx * wx + ly * wy;
    fitB += lx * wy - ly * wx;
  }
  if (Math.hypot(fitA, fitB) > 1e-3) {
    const rot = Math.atan2(fitB, fitA);
    const targetHeading = rot - Math.PI / 2;
    let delta = targetHeading - mesh.headingAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    mesh.headingAngle += Math.max(-0.15, Math.min(0.15, delta));
  }

  const headX = Math.cos(mesh.headingAngle);
  const headY = Math.sin(mesh.headingAngle);

  // 2. Gradient Sensor sampling -> AR-ResNet Neural Network (Steering, Seek vs Brake, Gait)
  let gradSumCross = 0;
  let gradSumDot = 0;
  let gradSumMag = 0;
  let sensorWeightTotal = 0;
  let neuralWeightTotal = 0;
  const sampleDelta = 14;

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    neuralWeightTotal += c.neuralWeight;
    const sw = c.sensorWeight;
    if (sw < 0.05) {
      c.gradientX = 0;
      c.gradientY = 0;
      continue;
    }

    const cx = (verts[c.vTL].x + verts[c.vTR].x + verts[c.vBR].x + verts[c.vBL].x) * 0.25;
    const cy = (verts[c.vTL].y + verts[c.vTR].y + verts[c.vBR].y + verts[c.vBL].y) * 0.25;

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
    if (mag > 1e-6) {
      const cross = (headX * gy - headY * gx) / mag;
      const dot = (headX * gx + headY * gy) / mag;
      gradSumCross += cross * sw * mag;
      gradSumDot += dot * sw * mag;
      gradSumMag += mag * sw;
      sensorWeightTotal += sw;
    }
  }

  const gradCross = gradSumMag > 1e-6 ? gradSumCross / gradSumMag : 0;
  const gradDot = gradSumMag > 1e-6 ? gradSumDot / gradSumMag : 1.0;
  const avgGradMag = sensorWeightTotal > 0 ? gradSumMag / sensorWeightTotal : 0;
  const sensorMagnitude =
    sensorWeightTotal > 0 ? Math.min(1, avgGradMag * 32) : 0;

  const localFood =
    localFoodSample !== undefined
      ? localFoodSample
      : sampler.sampleAttractant(mesh.comX, mesh.comY);
  const localToxin = localToxinSample ?? 0;
  const forwardSpeed = avgVx * headX + avgVy * headY;
  const totalSpeed = Math.hypot(avgVx, avgVy);
  const neuralDensity = cells.length > 0 ? neuralWeightTotal / cells.length : 0;

  const activeNet = neuralNet ?? createNeuralNetState();
  // Seed initial AR turn state smoothly when stateless fallback is used
  if (!neuralNet) {
    activeNet.neurons[0].state = prevSteerBias;
  }
  stepNeuralNet(activeNet, {
    gradCross,
    gradDot,
    avgGradMag,
    localFood,
    localToxin,
    forwardSpeed,
    speed: totalSpeed,
    energyFactor,
    neuralDensity,
    gradientSensitivity: params.gradientSensitivity,
  });

  const steerBias = activeNet.steerOut;
  const cruiseThrottle = activeNet.cruiseOut;
  const brakeThrottle = activeNet.brakeOut;
  const gaitScale = activeNet.gaitOut;

  // 3. Modulate Muscle Spring Rest Lengths & track muscle metabolic work
  const activeScale = energyFactor > 0.02 ? 0.35 + 0.65 * energyFactor : 0;
  const amp = Math.min(0.26, params.muscleStrength * 0.75) * activeScale * gaitScale;
  let muscleWorkSum = 0;
  let muscleSpringCount = 0;

  for (let i = 0; i < mesh.springs.length; i++) {
    const s = mesh.springs[i];
    if (s.isMuscle) {
      const wave = Math.sin(musclePhaseTime - s.musclePhase);
      const turn = steerBias * s.sideBias * 0.55;
      const act = Math.max(-1, Math.min(1, wave * 0.65 + turn));
      s.activation = act;
      s.currentRestLength = s.baseLength * (1 - amp * act);
      muscleWorkSum += Math.abs(act) * params.muscleStrength;
      muscleSpringCount++;
    } else {
      s.activation = 0;
      s.currentRestLength = s.baseLength;
    }
  }

  // 4. Sub-stepped Semi-Implicit Euler Integration
  const SUBSTEPS = 4;
  const dt = 0.64 / SUBSTEPS;
  const dragFactor = Math.pow(1 - Math.min(0.4, params.fluidDrag), 1 / SUBSTEPS);
  const rotDragPerSubstep = Math.min(0.32, (params.fluidDrag * 3.6 + 0.12) / SUBSTEPS);

  let flagellaWorkSum = 0;
  let flagellaCellCount = 0;

  for (let step = 0; step < SUBSTEPS; step++) {
    for (let i = 0; i < verts.length; i++) {
      verts[i].fx = 0;
      verts[i].fy = 0;
    }

    // A. Hooke's Law Springs + Damping
    for (let i = 0; i < mesh.springs.length; i++) {
      const s = mesh.springs[i];
      const v0 = verts[s.v0];
      const v1 = verts[s.v1];
      const dx = v1.x - v0.x;
      const dy = v1.y - v0.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-5) continue;

      const nx = dx / dist;
      const ny = dy / dist;
      const stretch = dist - s.currentRestLength;
      const relVx = v1.vx - v0.vx;
      const relVy = v1.vy - v0.vy;
      const damp = (relVx * nx + relVy * ny) * s.damping;
      const force = s.stiffness * stretch + damp;

      const fx = force * nx;
      const fy = force * ny;
      v0.fx += fx;
      v0.fy += fy;
      v1.fx -= fx;
      v1.fy -= fy;
    }

    // B. BoxEye / Matyka Internal Gas Pressure (unrolled edges, zero allocation) + Propulsion
    let totalSignedArea = 0;
    const kCellPressure = 0.88 * params.internalPressure;
    let bodyThrustX = 0;
    let bodyThrustY = 0;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const v0 = verts[c.vTL];
      const v1 = verts[c.vTR];
      const v2 = verts[c.vBR];
      const v3 = verts[c.vBL];

      const area =
        0.5 *
        (v0.x * v1.y -
          v1.x * v0.y +
          (v1.x * v2.y - v2.x * v1.y) +
          (v2.x * v3.y - v3.x * v2.y) +
          (v3.x * v0.y - v0.x * v3.y));
      c.currentArea = area;
      totalSignedArea += area;

      const safeArea = Math.max(c.targetArea * 0.35, area);
      const pressure = Math.max(
        -1.8,
        Math.min(3.2, (kCellPressure * (c.targetArea - area)) / safeArea),
      );

      if (area > c.targetArea * 0.25) {
        const halfP = 0.5 * pressure;
        // Edge v0 -> v1
        let pfX = halfP * (v1.y - v0.y);
        let pfY = halfP * -(v1.x - v0.x);
        v0.fx += pfX;
        v0.fy += pfY;
        v1.fx += pfX;
        v1.fy += pfY;
        // Edge v1 -> v2
        pfX = halfP * (v2.y - v1.y);
        pfY = halfP * -(v2.x - v1.x);
        v1.fx += pfX;
        v1.fy += pfY;
        v2.fx += pfX;
        v2.fy += pfY;
        // Edge v2 -> v3
        pfX = halfP * (v3.y - v2.y);
        pfY = halfP * -(v3.x - v2.x);
        v2.fx += pfX;
        v2.fy += pfY;
        v3.fx += pfX;
        v3.fy += pfY;
        // Edge v3 -> v0
        pfX = halfP * (v0.y - v3.y);
        pfY = halfP * -(v0.x - v3.x);
        v3.fx += pfX;
        v3.fy += pfY;
        v0.fx += pfX;
        v0.fy += pfY;
      } else {
        // Anti-inversion safeguard: gently unfold compressed cell toward CCW rest square
        const cx = (v0.x + v1.x + v2.x + v3.x) * 0.25;
        const cy = (v0.y + v1.y + v2.y + v3.y) * 0.25;
        const h = mesh.cellSize * 0.52;
        const rot = mesh.headingAngle + Math.PI / 2;
        const rc = Math.cos(rot);
        const rs = Math.sin(rot);
        const kUnfold = 2.4;
        v0.fx += (cx + (-h * rc + h * rs) - v0.x) * kUnfold;
        v0.fy += (cy + (-h * rs - h * rc) - v0.y) * kUnfold;
        v1.fx += (cx + (h * rc + h * rs) - v1.x) * kUnfold;
        v1.fy += (cy + (h * rs - h * rc) - v1.y) * kUnfold;
        v2.fx += (cx + (h * rc - h * rs) - v2.x) * kUnfold;
        v2.fy += (cy + (h * rs + h * rc) - v2.y) * kUnfold;
        v3.fx += (cx + (-h * rc - h * rs) - v3.x) * kUnfold;
        v3.fy += (cy + (-h * rs + h * rc) - v3.y) * kUnfold;
      }

      // Accumulate squish stress on final substep
      if (step === SUBSTEPS - 1) {
        c.crushStress *= 0.86;
        if (area < c.targetArea * 0.34) {
          c.crushStress += ((c.targetArea * 0.34 - area) / c.targetArea) * 1.4;
        }
        if (c.crushStress > 1.15 || area < c.targetArea * 0.16) {
          RUPTURE_SCRATCH.push(c.key);
        }
      }

      // C. Flagella Propulsion (supports stopping on food + opposite-side braking flagella)
      if (c.flagellaWeight > 0.05) {
        const isBrakeFlagellum = c.thrustDotForward < -0.15;
        const throttle = isBrakeFlagellum ? brakeThrottle : cruiseThrottle;

        if (throttle > 0.03) {
          const { fxDir, fyDir } = computeCellWorldThrustDir(
            c,
            verts,
            mesh.headingAngle,
            steerBias,
            musclePhaseTime,
          );
          const beat = (0.78 + 0.22 * Math.sin(musclePhaseTime * 1.4 + c.gx * 0.5)) * throttle;
          const totalCellThrust =
            params.flagellaThrust * c.flagellaWeight * beat * activeScale * 1.85;
          c.activation = beat;

          if (step === 0) {
            flagellaWorkSum += c.flagellaWeight * beat * params.flagellaThrust;
            flagellaCellCount++;
          }

          bodyThrustX += fxDir * totalCellThrust;
          bodyThrustY += fyDir * totalCellThrust;
        } else {
          c.activation = 0;
        }
      } else if (c.muscleWeight > 0.12) {
        const act = Math.sin(musclePhaseTime - (c.gy - midGy) * 0.45);
        c.activation = act * (0.25 + 0.75 * cruiseThrottle);
        const fwdThrust =
          Math.abs(act) * c.muscleWeight * params.muscleStrength * 1.15 * activeScale * cruiseThrottle;
        bodyThrustX += headX * fwdThrust;
        bodyThrustY += headY * fwdThrust;
      }
    }

    // Apply cytoskeletal thrust + scale-consistent chemotactic steering torque
    if (
      Math.abs(bodyThrustX) > 1e-6 ||
      Math.abs(bodyThrustY) > 1e-6 ||
      Math.abs(steerBias) > 1e-4
    ) {
      const distX = bodyThrustX * invN;
      const distY = bodyThrustY * invN;
      let r2Sum = 0;
      for (let i = 0; i < verts.length; i++) {
        const dx = verts[i].x - mesh.comX;
        const dy = verts[i].y - mesh.comY;
        r2Sum += dx * dx + dy * dy;
      }
      const avgR = Math.max(6, Math.sqrt(r2Sum * invN));
      const effectorGain = 0.55 + 0.45 * Math.min(2.0, params.flagellaThrust + params.muscleStrength);
      const torqueNorm = steerBias * activeScale * effectorGain * (0.48 / avgR);
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const rx = v.x - mesh.comX;
        const ry = v.y - mesh.comY;
        v.fx += distX - ry * torqueNorm;
        v.fy += distY + rx * torqueNorm;
      }
    }

    mesh.totalArea = totalSignedArea;

    // D. Global BoxEye Body-Loop Ideal Gas Pressure
    if (mesh.boundaryEdges.length > 0 && mesh.targetTotalArea > 0) {
      const safeBodyArea = Math.max(mesh.targetTotalArea * 0.35, totalSignedArea);
      const bodyPressure = Math.max(
        -0.8,
        Math.min(
          1.8,
          (0.42 * params.internalPressure * (mesh.targetTotalArea - totalSignedArea)) / safeBodyArea,
        ),
      );
      for (let i = 0; i < mesh.boundaryEdges.length; i++) {
        const pair = mesh.boundaryEdges[i];
        const a = verts[pair[0]];
        const b = verts[pair[1]];
        const pfX = 0.5 * bodyPressure * (b.y - a.y);
        const pfY = 0.5 * bodyPressure * -(b.x - a.x);
        a.fx += pfX;
        a.fy += pfY;
        b.fx += pfX;
        b.fy += pfY;
      }
    }

    // E. Integrate Velocities + Linear & Rotational Fluid Drag Damping
    let curVxSum = 0;
    let curVySum = 0;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (v.pinned) continue;
      v.vx = (v.vx + (v.fx / v.mass) * dt) * dragFactor;
      v.vy = (v.vy + (v.fy / v.mass) * dt) * dragFactor;
      curVxSum += v.vx;
      curVySum += v.vy;
    }

    // Measure angular momentum L / I and damp spin strongly via fluid rotational drag
    const linVx = curVxSum * invN;
    const linVy = curVySum * invN;
    let angL = 0;
    let inertia = 0;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const rx = v.x - mesh.comX;
      const ry = v.y - mesh.comY;
      const dvx = v.vx - linVx;
      const dvy = v.vy - linVy;
      angL += rx * dvy - ry * dvx;
      inertia += rx * rx + ry * ry;
    }
    const omega = inertia > 1.0 ? angL / inertia : 0;
    // Clamp excessive spin rate and subtract rotational drag torque
    const maxOmega = 0.055;
    const clampedExcess =
      Math.abs(omega) > maxOmega ? omega - Math.sign(omega) * maxOmega : 0;
    const spinCancel = omega * rotDragPerSubstep + clampedExcess * 0.65;
    mesh.angularVelocity = omega - spinCancel;

    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (v.pinned) continue;

      if (spinCancel !== 0) {
        const rx = v.x - mesh.comX;
        const ry = v.y - mesh.comY;
        v.vx -= -ry * spinCancel;
        v.vy -= rx * spinCancel;
      }

      const spd = Math.hypot(v.vx, v.vy);
      if (spd > 14) {
        v.vx = (v.vx / spd) * 14;
        v.vy = (v.vy / spd) * 14;
      }

      v.x += v.vx * dt;
      v.y += v.vy * dt;
    }
  }

  const avgMuscleWork = muscleSpringCount > 0 ? muscleWorkSum / muscleSpringCount : 0;
  const avgFlagellaWork = flagellaCellCount > 0 ? flagellaWorkSum / flagellaCellCount : 0;
  const metabolicBurn = (avgMuscleWork * 0.45 + avgFlagellaWork * 0.16) * params.metabolismRate;

  return {
    steerBias,
    sensorMagnitude,
    speed: Math.hypot(avgVx, avgVy),
    metabolicBurn,
    rupturedKeys: RUPTURE_SCRATCH,
  };
}
