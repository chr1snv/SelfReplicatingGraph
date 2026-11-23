import {
  BASE_DIM,
  CompiledGenome,
  DirectiveNode,
  MAX_MIP_LEVEL,
  MipLayerCompiled,
  MipLevel,
  NeuralBlueprintConfig,
  TissueType,
  mipDim,
  mipStride,
} from '../types/morphogenesis';
import { computeSignedDistanceField, createEmptyTissueCounts, downsampleMipLayer } from './levelSet';

const CARDINAL_DELTAS: [number, number][] = [
  [0, -1], // N (0)
  [0, 1], // S (1)
  [1, 0], // E (2)
  [-1, 0], // W (3)
];

function createBaseLayer(blueprint: Uint8Array): MipLayerCompiled {
  const dim = BASE_DIM;
  const tissueGrid = new Uint8Array(blueprint);
  const lineageGrid = new Uint16Array(dim * dim);
  const nodeIdGrid = new Int32Array(dim * dim);
  const tissueCounts = createEmptyTissueCounts();

  let activeCount = 0;
  for (let i = 0; i < tissueGrid.length; i++) {
    const t = tissueGrid[i] as TissueType;
    tissueCounts[t] = (tissueCounts[t] || 0) + 1;
    if (t !== TissueType.EMPTY) {
      lineageGrid[i] = 1 << (t - 1);
      activeCount++;
    }
  }

  const phiGrid = computeSignedDistanceField(tissueGrid, dim);

  return {
    level: 0,
    dim,
    stride: 1,
    tissueGrid,
    lineageGrid,
    phiGrid,
    nodeIdGrid,
    activeCount,
    tissueCounts,
  };
}

function countBits(mask: number): number {
  let c = 0;
  let m = mask;
  while (m) {
    c += m & 1;
    m >>= 1;
  }
  return c;
}

/**
 * Compiles a 128x128 multi-tissue design image in REVERSE (L0 -> L1 -> L2 -> L3)
 * into a 4-level level-set mipmap pyramid and unified Directive Connectivity Graph.
 */
export function compileBlueprintToGenome(
  blueprint: Uint8Array,
  neuralConfig?: NeuralBlueprintConfig,
): CompiledGenome {
  const t0 = performance.now();

  // 1. Reverse Mipmap Pyramid Construction: Fine (L0) -> Coarse (L3)
  const l0 = createBaseLayer(blueprint);
  const l1 = downsampleMipLayer(l0);
  const l2 = downsampleMipLayer(l1);
  const l3 = downsampleMipLayer(l2);

  const layers: Record<MipLevel, MipLayerCompiled> = {
    0: l0,
    1: l1,
    2: l2,
    3: l3,
  };

  const nodes: DirectiveNode[] = [];
  const nodeById = new Map<number, DirectiveNode>();

  const registerNode = (
    level: MipLevel,
    gx: number,
    gy: number,
    parentId: number,
    bfsDepth: number,
  ): DirectiveNode => {
    const layer = layers[level];
    const idx = gy * layer.dim + gx;
    const id = nodes.length + 1;
    const stride = layer.stride;
    const tissue = layer.tissueGrid[idx] as TissueType;
    const lineageMask = layer.lineageGrid[idx];
    const node: DirectiveNode = {
      id,
      level,
      gx,
      gy,
      physX: gx * stride + stride * 0.5,
      physY: gy * stride + stride * 0.5,
      tissue,
      lineageMask,
      isProgenitor: level > 0 && countBits(lineageMask) > 1,
      levelSetPhi: layer.phiGrid[idx],
      parentId,
      bfsDepth,
      lateralNeighbors: [0, 0, 0, 0],
      subdivisionChildren: [0, 0, 0, 0],
      bridgeTargetIds: [],
    };
    layer.nodeIdGrid[idx] = id;
    nodes.push(node);
    nodeById.set(id, node);
    return node;
  };

  // 2. Coarsest Level (L3, 16x16) Center-Out BFS Scaffold Compilation
  let seedNodeId = 0;
  const coarseCoords: Array<{ gx: number; gy: number; phi: number }> = [];
  let sumX = 0;
  let sumY = 0;

  for (let gy = 0; gy < l3.dim; gy++) {
    for (let gx = 0; gx < l3.dim; gx++) {
      const idx = gy * l3.dim + gx;
      if (l3.tissueGrid[idx] !== TissueType.EMPTY) {
        coarseCoords.push({ gx, gy, phi: l3.phiGrid[idx] });
        sumX += gx;
        sumY += gy;
      }
    }
  }

  if (coarseCoords.length > 0) {
    const cx = sumX / coarseCoords.length;
    const cy = sumY / coarseCoords.length;

    // Choose deepest interior cell (lowest phi) near centroid as Seed #1
    coarseCoords.sort((a, b) => {
      const scoreA = a.phi * 2.5 + Math.hypot(a.gx - cx, a.gy - cy) * 0.4;
      const scoreB = b.phi * 2.5 + Math.hypot(b.gx - cx, b.gy - cy) * 0.4;
      return scoreA - scoreB;
    });

    const visited = new Uint8Array(l3.dim * l3.dim);
    const queue: DirectiveNode[] = [];

    const seedCoord = coarseCoords[0];
    const seedNode = registerNode(MAX_MIP_LEVEL, seedCoord.gx, seedCoord.gy, 0, 0);
    seedNodeId = seedNode.id;
    visited[seedCoord.gy * l3.dim + seedCoord.gx] = 1;
    queue.push(seedNode);

    const runCoarseBfs = () => {
      let head = 0;
      while (head < queue.length) {
        const curr = queue[head++];
        for (const [dx, dy] of CARDINAL_DELTAS) {
          const nx = curr.gx + dx;
          const ny = curr.gy + dy;
          if (nx < 0 || nx >= l3.dim || ny < 0 || ny >= l3.dim) continue;
          const nIdx = ny * l3.dim + nx;
          if (l3.tissueGrid[nIdx] !== TissueType.EMPTY && !visited[nIdx]) {
            visited[nIdx] = 1;
            const child = registerNode(MAX_MIP_LEVEL, nx, ny, curr.id, curr.bfsDepth + 1);
            queue.push(child);
          }
        }
      }
    };

    runCoarseBfs();

    // Bridge any disconnected coarse islands so 100% of blueprint is reachable from Seed #1
    while (queue.length < coarseCoords.length) {
      let bestSource: DirectiveNode | null = null;
      let bestTarget: { gx: number; gy: number } | null = null;
      let bestDist2 = Infinity;

      for (const cand of coarseCoords) {
        if (visited[cand.gy * l3.dim + cand.gx]) continue;
        for (const src of nodes) {
          if (src.level !== MAX_MIP_LEVEL) continue;
          const d2 = (cand.gx - src.gx) ** 2 + (cand.gy - src.gy) ** 2;
          if (d2 < bestDist2) {
            bestDist2 = d2;
            bestSource = src;
            bestTarget = cand;
          }
        }
      }

      if (!bestSource || !bestTarget) break;

      visited[bestTarget.gy * l3.dim + bestTarget.gx] = 1;
      const bridgeNode = registerNode(
        MAX_MIP_LEVEL,
        bestTarget.gx,
        bestTarget.gy,
        bestSource.id,
        bestSource.bfsDepth + 1,
      );
      bestSource.bridgeTargetIds.push(bridgeNode.id);
      queue.push(bridgeNode);
      runCoarseBfs();
    }
  }

  // 3. Emit Cross-Scale Subdivision Directives (L3 -> L2 -> L1 -> L0)
  for (let parentLevel = MAX_MIP_LEVEL; parentLevel >= 1; parentLevel--) {
    const childLevel = (parentLevel - 1) as MipLevel;
    const childLayer = layers[childLevel];

    // Iterate parent nodes in their discovery order
    const parentSnapshot = nodes.filter((n) => n.level === parentLevel);
    for (const parent of parentSnapshot) {
      const subIds: [number, number, number, number] = [0, 0, 0, 0];
      let qIdx = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cgx = parent.gx * 2 + dx;
          const cgy = parent.gy * 2 + dy;
          const cIdx = cgy * childLayer.dim + cgx;
          if (childLayer.tissueGrid[cIdx] !== TissueType.EMPTY) {
            const childNode = registerNode(
              childLevel,
              cgx,
              cgy,
              parent.id,
              parent.bfsDepth + 1,
            );
            subIds[qIdx] = childNode.id;
          }
          qIdx++;
        }
      }
      parent.subdivisionChildren = subIds;
    }
  }

  // 4. Populate Intra-Level Lateral Connectivity [N, S, E, W] across ALL levels
  for (const node of nodes) {
    const layer = layers[node.level];
    const nbrs: [number, number, number, number] = [0, 0, 0, 0];
    for (let d = 0; d < 4; d++) {
      const nx = node.gx + CARDINAL_DELTAS[d][0];
      const ny = node.gy + CARDINAL_DELTAS[d][1];
      if (nx >= 0 && nx < layer.dim && ny >= 0 && ny < layer.dim) {
        nbrs[d] = layer.nodeIdGrid[ny * layer.dim + nx];
      }
    }
    node.lateralNeighbors = nbrs;
  }

  // 5. Compile Legacy Single-Grid Graph (L0 only) for direct comparison
  const legacyNodes: DirectiveNode[] = [];
  const legacyNodeById = new Map<number, DirectiveNode>();
  const legacyGrid = new Int32Array(BASE_DIM * BASE_DIM);
  let legacySeedNodeId = 0;

  const l0Active: Array<{ gx: number; gy: number; phi: number }> = [];
  let l0SumX = 0;
  let l0SumY = 0;
  for (let y = 0; y < BASE_DIM; y++) {
    for (let x = 0; x < BASE_DIM; x++) {
      const idx = y * BASE_DIM + x;
      if (l0.tissueGrid[idx] !== TissueType.EMPTY) {
        l0Active.push({ gx: x, gy: y, phi: l0.phiGrid[idx] });
        l0SumX += x;
        l0SumY += y;
      }
    }
  }

  if (l0Active.length > 0) {
    const cx = l0SumX / l0Active.length;
    const cy = l0SumY / l0Active.length;
    l0Active.sort((a, b) => {
      const scoreA = a.phi * 2.0 + Math.hypot(a.gx - cx, a.gy - cy) * 0.4;
      const scoreB = b.phi * 2.0 + Math.hypot(b.gx - cx, b.gy - cy) * 0.4;
      return scoreA - scoreB;
    });

    const visited0 = new Uint8Array(BASE_DIM * BASE_DIM);
    const q0: DirectiveNode[] = [];

    const addLegacyNode = (gx: number, gy: number, parentId: number, depth: number): DirectiveNode => {
      const idx = gy * BASE_DIM + gx;
      const id = legacyNodes.length + 1;
      const tissue = l0.tissueGrid[idx] as TissueType;
      const node: DirectiveNode = {
        id,
        level: 0,
        gx,
        gy,
        physX: gx + 0.5,
        physY: gy + 0.5,
        tissue,
        lineageMask: 1 << (tissue - 1),
        isProgenitor: false,
        levelSetPhi: l0.phiGrid[idx],
        parentId,
        bfsDepth: depth,
        lateralNeighbors: [0, 0, 0, 0],
        subdivisionChildren: [0, 0, 0, 0],
        bridgeTargetIds: [],
      };
      legacyGrid[idx] = id;
      legacyNodes.push(node);
      legacyNodeById.set(id, node);
      return node;
    };

    const s0 = addLegacyNode(l0Active[0].gx, l0Active[0].gy, 0, 0);
    legacySeedNodeId = s0.id;
    visited0[l0Active[0].gy * BASE_DIM + l0Active[0].gx] = 1;
    q0.push(s0);

    let head = 0;
    while (head < q0.length) {
      const curr = q0[head++];
      for (const [dx, dy] of CARDINAL_DELTAS) {
        const nx = curr.gx + dx;
        const ny = curr.gy + dy;
        if (nx < 0 || nx >= BASE_DIM || ny < 0 || ny >= BASE_DIM) continue;
        const nIdx = ny * BASE_DIM + nx;
        if (l0.tissueGrid[nIdx] !== TissueType.EMPTY && !visited0[nIdx]) {
          visited0[nIdx] = 1;
          const next = addLegacyNode(nx, ny, curr.id, curr.bfsDepth + 1);
          q0.push(next);
        }
      }
    }

    for (const node of legacyNodes) {
      const nbrs: [number, number, number, number] = [0, 0, 0, 0];
      for (let d = 0; d < 4; d++) {
        const nx = node.gx + CARDINAL_DELTAS[d][0];
        const ny = node.gy + CARDINAL_DELTAS[d][1];
        if (nx >= 0 && nx < BASE_DIM && ny >= 0 && ny < BASE_DIM) {
          nbrs[d] = legacyGrid[ny * BASE_DIM + nx];
        }
      }
      node.lateralNeighbors = nbrs;
    }
  }

  return {
    blueprint: new Uint8Array(blueprint),
    layers,
    nodes,
    nodeById,
    seedNodeId,
    legacyNodes,
    legacyNodeById,
    legacySeedNodeId,
    legacyGrid,
    compileTimeMs: performance.now() - t0,
    neuralConfig: neuralConfig
      ? {
          arDecay: [...neuralConfig.arDecay],
          resGain: [...neuralConfig.resGain],
          bias: [...neuralConfig.bias],
          weights: [...neuralConfig.weights],
        }
      : undefined,
  };
}
