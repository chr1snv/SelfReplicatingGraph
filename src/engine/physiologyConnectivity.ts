import {
  BASE_DIM,
  CompiledGenome,
  MipLevel,
  SimState,
  SoftBodyMesh,
  SoftCell,
  TissueType,
} from '../types/morphogenesis';

const COMP_COUNTS = new Float32Array(16);
const ADJ_OX = [-1, 1, 0, 0];
const ADJ_OY = [0, 0, -1, 1];
const MAX_LATTICE_CELLS = 1024; // 32x32 max at L2
const BFS_QUEUE = new Int32Array(MAX_LATTICE_CELLS);
const BFS_VASC_DIST = new Int16Array(MAX_LATTICE_CELLS);
const BFS_NEUR_DIST = new Int16Array(MAX_LATTICE_CELLS);

export const CELL_COMP_SCRATCH = {
  epidermisWeight: 0,
  mesodermWeight: 0,
  vascularWeight: 0,
  neuralWeight: 0,
  sensorWeight: 0,
  muscleWeight: 0,
  flagellaWeight: 0,
  digestiveWeight: 0,
  excretoryWeight: 0,
  spikeWeight: 0,
};

/**
 * Samples fine L0 tissue proportions inside a single coarse L2 or L3 mesh cell
 * without heap allocations using `CELL_COMP_SCRATCH`.
 */
export function sampleFineComposition(
  simState: SimState,
  genome: CompiledGenome,
  meshLevel: MipLevel,
  gx: number,
  gy: number,
): typeof CELL_COMP_SCRATCH {
  COMP_COUNTS.fill(0);
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
        COMP_COUNTS[t]++;
        total++;
      }
    }
  }

  if (total === 0) {
    const layer = simState.layers[meshLevel];
    const t = layer.tissue[gy * layer.dim + gx];
    COMP_COUNTS[t] = 1;
    total = 1;

    const bp = genome.blueprint;
    for (let dy = 0; dy < stride; dy++) {
      for (let dx = 0; dx < stride; dx++) {
        const bt = bp[(sy + dy) * BASE_DIM + (sx + dx)];
        if (bt !== TissueType.EMPTY) {
          COMP_COUNTS[bt] += 0.25;
          total += 0.25;
        }
      }
    }
  }

  const invTotal = 1 / total;
  CELL_COMP_SCRATCH.epidermisWeight = COMP_COUNTS[TissueType.EPIDERMIS] * invTotal;
  CELL_COMP_SCRATCH.mesodermWeight = COMP_COUNTS[TissueType.MESODERM] * invTotal;
  CELL_COMP_SCRATCH.vascularWeight = COMP_COUNTS[TissueType.VASCULAR] * invTotal;
  CELL_COMP_SCRATCH.neuralWeight = COMP_COUNTS[TissueType.NEURAL] * invTotal;
  CELL_COMP_SCRATCH.sensorWeight = COMP_COUNTS[TissueType.SENSOR] * invTotal;
  CELL_COMP_SCRATCH.muscleWeight = COMP_COUNTS[TissueType.MUSCLE] * invTotal;
  CELL_COMP_SCRATCH.flagellaWeight = COMP_COUNTS[TissueType.FLAGELLA] * invTotal;
  CELL_COMP_SCRATCH.digestiveWeight = COMP_COUNTS[TissueType.DIGESTIVE] * invTotal;
  CELL_COMP_SCRATCH.excretoryWeight = COMP_COUNTS[TissueType.EXCRETORY] * invTotal;
  CELL_COMP_SCRATCH.spikeWeight = COMP_COUNTS[TissueType.SPIKE] * invTotal;
  return CELL_COMP_SCRATCH;
}

/**
 * Multi-source BFS helper across connected lattice cells to compute topological
 * hop distances from source tissues (Vascular trunks or Neural ganglia).
 */
function runLatticeDistanceBfs(
  mesh: SoftBodyMesh,
  dim: number,
  distOut: Int16Array,
  seedCount: number,
): void {
  let head = 0;
  let tail = seedCount;
  while (head < tail) {
    const k = BFS_QUEUE[head++];
    const dist = distOut[k];
    const gx = k % dim;
    const gy = (k - gx) / dim;
    for (let d = 0; d < 4; d++) {
      const nx = gx + ADJ_OX[d];
      const ny = gy + ADJ_OY[d];
      if (nx < 0 || nx >= dim || ny < 0 || ny >= dim) continue;
      const nk = ny * dim + nx;
      if (distOut[nk] === -1 && mesh.cellMap.has(nk)) {
        distOut[nk] = dist + 1;
        BFS_QUEUE[tail++] = nk;
      }
    }
  }
}

/**
 * Computes Vascular ATP-delivery and Neural relay-connectivity factors across mesh cells
 * via multi-source BFS on the connected lattice combined with healthy tissue-ratio AoE floors.
 */
export function computePhysiologyConnectivity(mesh: SoftBodyMesh, dim: number): void {
  const n = mesh.cells.length;
  if (n === 0) {
    mesh.vascularEfficiency = 0.4;
    mesh.neuralEfficiency = 0.4;
    mesh.digestiveEfficiency = 0.4;
    mesh.excretoryEfficiency = 0.25;
    mesh.spikeCount = 0;
    return;
  }

  BFS_VASC_DIST.fill(-1);
  BFS_NEUR_DIST.fill(-1);

  let vTail = 0;
  let totalVasc = 0;
  let totalDigestive = 0;
  let totalExcretory = 0;
  let spikeCount = 0;

  for (let i = 0; i < n; i++) {
    const c: SoftCell = mesh.cells[i];
    if (c.vascularWeight > 0.08 || c.tissue === TissueType.VASCULAR) {
      totalVasc += Math.max(0.25, c.vascularWeight);
      BFS_VASC_DIST[c.key] = 0;
      BFS_QUEUE[vTail++] = c.key;
    }
    if (c.digestiveWeight > 0.1 || c.tissue === TissueType.DIGESTIVE) {
      totalDigestive += Math.max(0.25, c.digestiveWeight);
    }
    if (c.excretoryWeight > 0.1 || c.tissue === TissueType.EXCRETORY) {
      totalExcretory += Math.max(0.25, c.excretoryWeight);
    }
    if (c.spikeWeight > 0.12 || c.tissue === TissueType.SPIKE) {
      spikeCount++;
    }
  }
  runLatticeDistanceBfs(mesh, dim, BFS_VASC_DIST, vTail);

  let nTail = 0;
  let totalNeur = 0;
  for (let i = 0; i < n; i++) {
    const c = mesh.cells[i];
    if (c.neuralWeight > 0.08 || c.tissue === TissueType.NEURAL) {
      totalNeur += Math.max(0.25, c.neuralWeight);
      BFS_NEUR_DIST[c.key] = 0;
      BFS_QUEUE[nTail++] = c.key;
    }
  }
  runLatticeDistanceBfs(mesh, dim, BFS_NEUR_DIST, nTail);

  const vascRatio = totalVasc / n;
  const neurRatio = totalNeur / n;
  const vascAoeFloor = totalVasc > 0 ? Math.min(0.84, 0.42 + vascRatio * 3.8) : 0.36;
  const neurAoeFloor = totalNeur > 0 ? Math.min(0.84, 0.4 + neurRatio * 4.0) : 0.35;

  let vascSum = 0;
  let effectorVascCount = 0;
  let neurSum = 0;
  let sensorEffectorNeurCount = 0;
  let digVascSum = 0;
  let digCount = 0;
  let excVascSum = 0;
  let excCount = 0;

  for (let i = 0; i < n; i++) {
    const c = mesh.cells[i];
    const vd = BFS_VASC_DIST[c.key];
    const nd = BFS_NEUR_DIST[c.key];

    const topoVasc = vd >= 0 ? Math.max(0.45, 1.0 - Math.max(0, vd - 2) * 0.085) : 0.34;
    const topoNeur = nd >= 0 ? Math.max(0.42, 1.0 - Math.max(0, nd - 2) * 0.095) : 0.34;

    c.vascularSupply = Math.max(vascAoeFloor, topoVasc);
    c.neuralCoupling = Math.max(neurAoeFloor, topoNeur);

    if (
      c.muscleWeight > 0.1 ||
      c.flagellaWeight > 0.1 ||
      c.digestiveWeight > 0.1 ||
      c.excretoryWeight > 0.1
    ) {
      vascSum += c.vascularSupply;
      effectorVascCount++;
    }
    if (c.sensorWeight > 0.1 || c.muscleWeight > 0.1 || c.flagellaWeight > 0.1) {
      neurSum += c.neuralCoupling;
      sensorEffectorNeurCount++;
    }
    if (c.digestiveWeight > 0.1) {
      digVascSum += c.vascularSupply;
      digCount++;
    }
    if (c.excretoryWeight > 0.1) {
      excVascSum += c.vascularSupply;
      excCount++;
    }
  }

  const vascEff = effectorVascCount > 0 ? vascSum / effectorVascCount : Math.max(0.45, vascAoeFloor);
  const neurEff =
    sensorEffectorNeurCount > 0 ? neurSum / sensorEffectorNeurCount : Math.max(0.45, neurAoeFloor);

  const digRatio = totalDigestive / n;
  const digCoupling = digCount > 0 ? digVascSum / digCount : 0.5;
  const digEff =
    totalDigestive > 0 ? Math.min(1.45, (0.68 + digRatio * 4.5) * (0.5 + 0.5 * digCoupling)) : 0.45;

  const excRatio = totalExcretory / n;
  const excCoupling = excCount > 0 ? excVascSum / excCount : 0.5;
  const excEff =
    totalExcretory > 0 ? Math.min(1.4, (0.58 + excRatio * 6.0) * (0.5 + 0.5 * excCoupling)) : 0.22;

  mesh.vascularEfficiency = vascEff;
  mesh.neuralEfficiency = neurEff;
  mesh.digestiveEfficiency = digEff;
  mesh.excretoryEfficiency = excEff;
  mesh.spikeCount = spikeCount;
}
