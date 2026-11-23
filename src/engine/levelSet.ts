import { MipLayerCompiled, MipLevel, TissueType, mipDim, mipStride } from '../types/morphogenesis';

const INF = 1e9;

function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) {
      k++;
    }
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

function computeUnsignedEDT(mask: Uint8Array, dim: number, targetVal: number): Float32Array {
  const out = new Float32Array(dim * dim);
  const f = new Float32Array(dim);
  const d = new Float32Array(dim);
  const v = new Int32Array(dim);
  const z = new Float32Array(dim + 1);

  for (let x = 0; x < dim; x++) {
    for (let y = 0; y < dim; y++) {
      f[y] = mask[y * dim + x] === targetVal ? 0 : INF;
    }
    edt1d(f, dim, d, v, z);
    for (let y = 0; y < dim; y++) {
      out[y * dim + x] = d[y];
    }
  }

  for (let y = 0; y < dim; y++) {
    const rowOff = y * dim;
    for (let x = 0; x < dim; x++) {
      f[x] = out[rowOff + x];
    }
    edt1d(f, dim, d, v, z);
    for (let x = 0; x < dim; x++) {
      out[rowOff + x] = Math.sqrt(d[x]);
    }
  }

  return out;
}

export function computeSignedDistanceField(tissueGrid: Uint8Array, dim: number): Float32Array {
  const binary = new Uint8Array(dim * dim);
  let hasOccupied = false;
  let hasEmpty = false;

  for (let i = 0; i < tissueGrid.length; i++) {
    if (tissueGrid[i] !== TissueType.EMPTY) {
      binary[i] = 1;
      hasOccupied = true;
    } else {
      hasEmpty = true;
    }
  }

  const phi = new Float32Array(dim * dim);
  if (!hasOccupied) {
    phi.fill(dim);
    return phi;
  }
  if (!hasEmpty) {
    phi.fill(-dim);
    return phi;
  }

  const distToEmpty = computeUnsignedEDT(binary, dim, 0);
  const distToOccupied = computeUnsignedEDT(binary, dim, 1);

  for (let i = 0; i < phi.length; i++) {
    phi[i] = binary[i] === 1 ? -distToEmpty[i] : distToOccupied[i];
  }

  return phi;
}

export function createEmptyTissueCounts(): Record<TissueType, number> {
  return {
    [TissueType.EMPTY]: 0,
    [TissueType.EPIDERMIS]: 0,
    [TissueType.MESODERM]: 0,
    [TissueType.VASCULAR]: 0,
    [TissueType.NEURAL]: 0,
    [TissueType.SENSOR]: 0,
    [TissueType.MUSCLE]: 0,
    [TissueType.FLAGELLA]: 0,
  };
}

/**
 * Reverse-downsamples a finer mip level (L - 1) into coarser mip level (L).
 * Preserves thin specialized tissues (Neural, Vascular, Sensor, Muscle, Flagella)
 * and records multi-tissue lineage masks across 2x2 sub-blocks.
 */
export function downsampleMipLayer(fineLayer: MipLayerCompiled): MipLayerCompiled {
  const level = (fineLayer.level + 1) as MipLevel;
  const dim = mipDim(level);
  const stride = mipStride(level);
  const fineDim = fineLayer.dim;

  const tissueGrid = new Uint8Array(dim * dim);
  const lineageGrid = new Uint8Array(dim * dim);
  const nodeIdGrid = new Int32Array(dim * dim);
  const tissueCounts = createEmptyTissueCounts();

  let activeCount = 0;

  // Slight priority boost for thin functional structures so sensors, flagella, nerves & vessels survive downsampling
  const specializedBoost = [0, 0, 0, 0.35, 0.35, 0.55, 0.35, 0.55];
  const tieBreak = [0, 1, 2, 4, 3, 6, 5, 7];

  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const fx = x * 2;
      const fy = y * 2;
      const counts = [0, 0, 0, 0, 0, 0, 0, 0];
      let lineage = 0;
      let nonEmpty = 0;

      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const fIdx = (fy + dy) * fineDim + (fx + dx);
          const t = fineLayer.tissueGrid[fIdx];
          if (t !== TissueType.EMPTY) {
            counts[t]++;
            nonEmpty++;
            lineage |= fineLayer.lineageGrid[fIdx] || (1 << (t - 1));
          }
        }
      }

      const idx = y * dim + x;
      lineageGrid[idx] = lineage;

      if (nonEmpty === 0) {
        tissueGrid[idx] = TissueType.EMPTY;
        tissueCounts[TissueType.EMPTY]++;
        continue;
      }

      let bestTissue: TissueType = TissueType.EPIDERMIS;
      let bestScore = -1;

      for (let t = 1; t <= 7; t++) {
        if (counts[t] === 0) continue;
        const score = counts[t] + specializedBoost[t] + tieBreak[t] * 0.01;
        if (score > bestScore) {
          bestScore = score;
          bestTissue = t as TissueType;
        }
      }

      tissueGrid[idx] = bestTissue;
      tissueCounts[bestTissue]++;
      activeCount++;
    }
  }

  const phiGrid = computeSignedDistanceField(tissueGrid, dim);

  return {
    level,
    dim,
    stride,
    tissueGrid,
    lineageGrid,
    phiGrid,
    nodeIdGrid,
    activeCount,
    tissueCounts,
  };
}
