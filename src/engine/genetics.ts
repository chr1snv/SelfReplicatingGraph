import { BASE_DIM, CompiledGenome, TissueType } from '../types/morphogenesis';
import { compileBlueprintToGenome } from './compiler';
import { crossoverNeuralConfigs } from './neuralNet';

const MUTATABLE_ORGANS: TissueType[] = [
  TissueType.SENSOR,
  TissueType.FLAGELLA,
  TissueType.DIGESTIVE,
  TissueType.EXCRETORY,
  TissueType.SPIKE,
];

// Pre-allocated zero-GC scratch buffers for connected-component pruning in offspring blueprints
const GEN_VISITED = new Uint8Array(BASE_DIM * BASE_DIM);
const GEN_QUEUE = new Int32Array(BASE_DIM * BASE_DIM);
const GEN_CURR_COMP = new Int32Array(BASE_DIM * BASE_DIM);
const GEN_BEST_COMP = new Int32Array(BASE_DIM * BASE_DIM);

/**
 * Retains only the single largest 4-connected tissue component in a 128x128 blueprint.
 * Because downsampleMipLayer marks any L1/L2/L3 block active whenever >= 1 child L0 pixel
 * is active, 4-connectivity at L0 guarantees 4-connectivity across all coarser mip levels
 * and the resulting SoftBodyMesh (zero floating detached cells or void bridges).
 */
export function pruneToLargestConnectedComponent(blueprint: Uint8Array): void {
  const total = BASE_DIM * BASE_DIM;
  GEN_VISITED.fill(0);
  let bestCount = 0;

  for (let i = 0; i < total; i++) {
    if (blueprint[i] === TissueType.EMPTY || GEN_VISITED[i]) continue;

    let qHead = 0;
    let qTail = 0;
    let currCount = 0;
    GEN_VISITED[i] = 1;
    GEN_QUEUE[qTail++] = i;

    while (qHead < qTail) {
      const idx = GEN_QUEUE[qHead++];
      GEN_CURR_COMP[currCount++] = idx;
      const x = idx % BASE_DIM;
      const y = (idx / BASE_DIM) | 0;

      if (x > 0) {
        const n = idx - 1;
        if (!GEN_VISITED[n] && blueprint[n] !== TissueType.EMPTY) {
          GEN_VISITED[n] = 1;
          GEN_QUEUE[qTail++] = n;
        }
      }
      if (x < BASE_DIM - 1) {
        const n = idx + 1;
        if (!GEN_VISITED[n] && blueprint[n] !== TissueType.EMPTY) {
          GEN_VISITED[n] = 1;
          GEN_QUEUE[qTail++] = n;
        }
      }
      if (y > 0) {
        const n = idx - BASE_DIM;
        if (!GEN_VISITED[n] && blueprint[n] !== TissueType.EMPTY) {
          GEN_VISITED[n] = 1;
          GEN_QUEUE[qTail++] = n;
        }
      }
      if (y < BASE_DIM - 1) {
        const n = idx + BASE_DIM;
        if (!GEN_VISITED[n] && blueprint[n] !== TissueType.EMPTY) {
          GEN_VISITED[n] = 1;
          GEN_QUEUE[qTail++] = n;
        }
      }
    }

    if (currCount > bestCount) {
      bestCount = currCount;
      GEN_BEST_COMP.set(GEN_CURR_COMP.subarray(0, currCount));
    }
  }

  if (bestCount === 0) return;

  // Temporarily mark kept indices in GEN_VISITED (= 2) and clear all smaller islands
  for (let k = 0; k < bestCount; k++) {
    GEN_VISITED[GEN_BEST_COMP[k]] = 2;
  }
  for (let i = 0; i < total; i++) {
    if (blueprint[i] !== TissueType.EMPTY && GEN_VISITED[i] !== 2) {
      blueprint[i] = TissueType.EMPTY;
    }
  }
}

/**
 * Recombines two parents' morphogenesis directive graphs (via their aligned multi-resolution
 * tissue blueprints & L3/L2 organ domains) plus their AR-ResNet neural controller parameters
 * to synthesize a single connected viable hybrid offspring genome.
 */
export function crossoverGenomes(
  parentA: CompiledGenome,
  parentB: CompiledGenome,
): CompiledGenome {
  const bpA = parentA.blueprint;
  const bpB = parentB.blueprint;
  const child = new Uint8Array(BASE_DIM * BASE_DIM);

  const centroidOf = (bp: Uint8Array) => {
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let y = 0; y < BASE_DIM; y++) {
      for (let x = 0; x < BASE_DIM; x++) {
        if (bp[y * BASE_DIM + x] !== TissueType.EMPTY) {
          sx += x;
          sy += y;
          c++;
        }
      }
    }
    return c > 0 ? { x: sx / c, y: sy / c } : { x: BASE_DIM / 2, y: BASE_DIM / 2 };
  };

  const cA = centroidOf(bpA);
  const cB = centroidOf(bpB);
  const targetC = { x: BASE_DIM / 2, y: BASE_DIM / 2 };

  const sampleAligned = (bp: Uint8Array, c: { x: number; y: number }, x: number, y: number): TissueType => {
    const sx = Math.round(x - targetC.x + c.x);
    const sy = Math.round(y - targetC.y + c.y);
    if (sx < 0 || sx >= BASE_DIM || sy < 0 || sy >= BASE_DIM) return TissueType.EMPTY;
    return bp[sy * BASE_DIM + sx] as TissueType;
  };

  const angle = Math.random() * Math.PI * 2;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  const planeOffset = (Math.random() - 0.5) * 14;

  // L2 block gene dominance map (32x32 organ modules)
  const blockDim = 32;
  const blockDominance = new Uint8Array(blockDim * blockDim);
  for (let i = 0; i < blockDominance.length; i++) {
    blockDominance[i] = Math.random() < 0.5 ? 0 : 1;
  }

  for (let y = 0; y < BASE_DIM; y++) {
    for (let x = 0; x < BASE_DIM; x++) {
      const tA = sampleAligned(bpA, cA, x, y);
      const tB = sampleAligned(bpB, cB, x, y);
      if (tA === TissueType.EMPTY && tB === TissueType.EMPTY) continue;

      const proj = (x - targetC.x) * nx + (y - targetC.y) * ny + planeOffset;
      const bIdx = (y >> 2) * blockDim + (x >> 2);
      const dom = blockDominance[bIdx];

      if (proj > 6) {
        child[y * BASE_DIM + x] = tA !== TissueType.EMPTY ? tA : (dom === 1 ? tB : TissueType.EMPTY);
      } else if (proj < -6) {
        child[y * BASE_DIM + x] = tB !== TissueType.EMPTY ? tB : (dom === 0 ? tA : TissueType.EMPTY);
      } else {
        if (tA !== TissueType.EMPTY && tB !== TissueType.EMPTY) {
          const specA = tA >= TissueType.NEURAL;
          const specB = tB >= TissueType.NEURAL;
          if (specA && !specB) child[y * BASE_DIM + x] = tA;
          else if (specB && !specA) child[y * BASE_DIM + x] = tB;
          else child[y * BASE_DIM + x] = dom === 0 ? tA : tB;
        } else {
          // Keep bridge tissue along suture line when inside either parent's core silhouette
          child[y * BASE_DIM + x] = tA !== TissueType.EMPTY ? tA : tB;
        }
      }
    }
  }

  // Light somatic mutation: occasionally sprout a sensor/flagellum/digestive/renal/spike cluster
  if (Math.random() < 0.35) {
    const mx = Math.round(targetC.x + (Math.random() - 0.5) * 32);
    const my = Math.round(targetC.y + (Math.random() - 0.5) * 32);
    const mutTissue = MUTATABLE_ORGANS[Math.floor(Math.random() * MUTATABLE_ORGANS.length)];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > 5) continue;
        const px = mx + dx;
        const py = my + dy;
        if (px >= 2 && px < BASE_DIM - 2 && py >= 2 && py < BASE_DIM - 2) {
          if (child[py * BASE_DIM + px] !== TissueType.EMPTY) {
            child[py * BASE_DIM + px] = mutTissue;
          }
        }
      }
    }
  }

  // Prune any disconnected islands so offspring anatomy is strictly 1 single connected body
  pruneToLargestConnectedComponent(child);

  // Ensure outer boundary has protective Epidermis where raw Mesoderm touches void
  const copy = new Uint8Array(child);
  for (let y = 1; y < BASE_DIM - 1; y++) {
    for (let x = 1; x < BASE_DIM - 1; x++) {
      const idx = y * BASE_DIM + x;
      if (copy[idx] !== TissueType.MESODERM) continue;
      if (
        copy[idx - 1] === TissueType.EMPTY ||
        copy[idx + 1] === TissueType.EMPTY ||
        copy[idx - BASE_DIM] === TissueType.EMPTY ||
        copy[idx + BASE_DIM] === TissueType.EMPTY
      ) {
        child[idx] = TissueType.EPIDERMIS;
      }
    }
  }

  const hybridNeural = crossoverNeuralConfigs(parentA.neuralConfig, parentB.neuralConfig);
  return compileBlueprintToGenome(child, hybridNeural);
}
