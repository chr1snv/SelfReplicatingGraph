import { BASE_DIM, CompiledGenome, TissueType } from '../types/morphogenesis';
import { compileBlueprintToGenome } from './compiler';

/**
 * Recombines two parents' morphogenesis directive graphs (via their aligned multi-resolution
 * tissue blueprints & L3/L2 organ domains) to synthesize a viable hybrid offspring genome.
 *
 * Uses three complementary biological crossover operators:
 * 1. Centroid-aligned cleavage crossover (anterior/posterior or bilateral split across the body axis)
 * 2. L2 Organ-Module directive mixing (specialized Sensor, Muscle, Flagella, Neural blocks
 *    are inherited as intact functional subtrees from either parent)
 * 3. Epidermal sealing & light somatic mutation so the hybrid body plan forms a cohesive organism.
 */
export function crossoverGenomes(
  parentA: CompiledGenome,
  parentB: CompiledGenome,
): CompiledGenome {
  const bpA = parentA.blueprint;
  const bpB = parentB.blueprint;
  const child = new Uint8Array(BASE_DIM * BASE_DIM);

  // Compute centroids of both blueprints so differently shaped parents align cleanly
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

  // Random cleavage plane orientation (horizontal anterior/posterior, vertical bilateral, or diagonal)
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

      // Smooth blend zone around cleavage boundary mixes L2 organ blocks
      if (proj > 6) {
        child[y * BASE_DIM + x] = tA !== TissueType.EMPTY ? tA : (dom === 1 ? tB : TissueType.EMPTY);
      } else if (proj < -6) {
        child[y * BASE_DIM + x] = tB !== TissueType.EMPTY ? tB : (dom === 0 ? tA : TissueType.EMPTY);
      } else {
        // Transition / hybrid recombination zone: union of core + L2 module selection
        if (tA !== TissueType.EMPTY && tB !== TissueType.EMPTY) {
          // Prioritize specialized tissues from either parent during hybridization
          const specA = tA >= TissueType.NEURAL;
          const specB = tB >= TissueType.NEURAL;
          if (specA && !specB) child[y * BASE_DIM + x] = tA;
          else if (specB && !specA) child[y * BASE_DIM + x] = tB;
          else child[y * BASE_DIM + x] = dom === 0 ? tA : tB;
        } else {
          child[y * BASE_DIM + x] = dom === 0 ? tA : tB;
        }
      }
    }
  }

  // Light somatic mutation: occasionally sprout or shift a sensor/flagellum cluster along boundary
  if (Math.random() < 0.35) {
    const mx = Math.round(targetC.x + (Math.random() - 0.5) * 32);
    const my = Math.round(targetC.y + (Math.random() - 0.5) * 32);
    const mutTissue = Math.random() < 0.5 ? TissueType.SENSOR : TissueType.FLAGELLA;
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

  return compileBlueprintToGenome(child);
}
