import {
  BASE_DIM,
  CompiledGenome,
  MAX_MIP_LEVEL,
  MIP_LEVELS,
  MipLevel,
  SimLayerState,
  SimParams,
  SimState,
  TelemetryPoint,
  TissueType,
  mipDim,
  mipStride,
} from '../types/morphogenesis';

const CARDINAL_DELTAS: [number, number][] = [
  [0, -1], // N (0)
  [0, 1], // S (1)
  [1, 0], // E (2)
  [-1, 0], // W (3)
];

const ENERGY_SCRATCH: Record<MipLevel, Float32Array> = {
  0: new Float32Array(BASE_DIM * BASE_DIM),
  1: new Float32Array((BASE_DIM >> 1) * (BASE_DIM >> 1)),
  2: new Float32Array((BASE_DIM >> 2) * (BASE_DIM >> 2)),
  3: new Float32Array((BASE_DIM >> 3) * (BASE_DIM >> 3)),
};

const SIGNAL_SCRATCH: Record<MipLevel, Float32Array> = {
  0: new Float32Array(BASE_DIM * BASE_DIM),
  1: new Float32Array((BASE_DIM >> 1) * (BASE_DIM >> 1)),
  2: new Float32Array((BASE_DIM >> 2) * (BASE_DIM >> 2)),
  3: new Float32Array((BASE_DIM >> 3) * (BASE_DIM >> 3)),
};

function revNeighbor(dir: number): number {
  switch (dir) {
    case 0:
      return 1;
    case 1:
      return 0;
    case 2:
      return 3;
    default:
      return 2;
  }
}

function createEmptySimLayer(level: MipLevel): SimLayerState {
  const dim = mipDim(level);
  const len = dim * dim;
  return {
    level,
    dim,
    stride: mipStride(level),
    alive: new Uint8Array(len),
    nodeId: new Int32Array(len),
    tissue: new Uint8Array(len),
    age: new Uint16Array(len),
    energy: new Float32Array(len),
    flash: new Float32Array(len),
    signal: new Float32Array(len),
    activeCount: 0,
  };
}

function seededNoise(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function createNutrientField(density: number): Float32Array {
  const field = new Float32Array(BASE_DIM * BASE_DIM);
  for (let y = 0; y < BASE_DIM; y++) {
    for (let x = 0; x < BASE_DIM; x++) {
      const wave =
        0.5 +
        0.25 * Math.sin(x * 0.12) * Math.cos(y * 0.12) +
        0.25 * seededNoise(x, y);
      field[y * BASE_DIM + x] = wave <= density ? Math.min(1, 0.45 + 0.55 * density) : 0.08;
    }
  }
  return field;
}

function rebuildCompositeAndMetrics(state: SimState, genome: CompiledGenome): void {
  const { layers, compositeTissue, compositeLevel, compositeNodeId } = state;
  compositeTissue.fill(TissueType.EMPTY);
  compositeLevel.fill(-1);
  compositeNodeId.fill(0);

  // Paint from coarsest (L3) to finest (L0); once a parent cell has divided into L-1
  // (any of its 2x2 sub-quadrants is alive in L-1), clear the parent's footprint so
  // finer empty sub-quadrants carve out accurate boundaries and internal cavities.
  for (let li = 0; li < MIP_LEVELS.length; li++) {
    const level = MIP_LEVELS[li];
    const layer = layers[level];
    const stride = layer.stride;

    for (let gy = 0; gy < layer.dim; gy++) {
      for (let gx = 0; gx < layer.dim; gx++) {
        const idx = gy * layer.dim + gx;
        if (!layer.alive[idx]) continue;

        const startX = gx * stride;
        const startY = gy * stride;

        if (level > 0) {
          const childLayer = layers[(level - 1) as MipLevel];
          const c00 = childLayer.alive[(gy * 2) * childLayer.dim + (gx * 2)];
          const c10 = childLayer.alive[(gy * 2) * childLayer.dim + (gx * 2 + 1)];
          const c01 = childLayer.alive[(gy * 2 + 1) * childLayer.dim + (gx * 2)];
          const c11 = childLayer.alive[(gy * 2 + 1) * childLayer.dim + (gx * 2 + 1)];
          if (c00 || c10 || c01 || c11) {
            // Clear coarse parent pixels so only active finer daughters occupy this block
            for (let dy = 0; dy < stride; dy++) {
              const rowOff = (startY + dy) * BASE_DIM;
              for (let dx = 0; dx < stride; dx++) {
                const pIdx = rowOff + startX + dx;
                compositeTissue[pIdx] = TissueType.EMPTY;
                compositeLevel[pIdx] = -1;
                compositeNodeId[pIdx] = 0;
              }
            }
            continue;
          }
        }

        const tissue = layer.tissue[idx];
        const nid = layer.nodeId[idx];

        for (let dy = 0; dy < stride; dy++) {
          const py = startY + dy;
          const rowOff = py * BASE_DIM;
          for (let dx = 0; dx < stride; dx++) {
            const pIdx = rowOff + startX + dx;
            compositeTissue[pIdx] = tissue;
            compositeLevel[pIdx] = level;
            compositeNodeId[pIdx] = nid;
          }
        }
      }
    }
  }

  let intersection = 0;
  let union = 0;
  let tissueMatched = 0;
  let visibleCount = 0;
  let targetCount = 0;

  let epi = 0;
  let meso = 0;
  let vasc = 0;
  let neur = 0;
  let sens = 0;
  let musc = 0;
  let flag = 0;

  for (let i = 0; i < BASE_DIM * BASE_DIM; i++) {
    const target = genome.blueprint[i];
    const actual = compositeTissue[i];
    const tOccupied = target !== TissueType.EMPTY;
    const aOccupied = actual !== TissueType.EMPTY;

    if (tOccupied) targetCount++;
    if (aOccupied) {
      visibleCount++;
      if (actual === TissueType.EPIDERMIS) epi++;
      else if (actual === TissueType.MESODERM) meso++;
      else if (actual === TissueType.VASCULAR) vasc++;
      else if (actual === TissueType.NEURAL) neur++;
      else if (actual === TissueType.SENSOR) sens++;
      else if (actual === TissueType.MUSCLE) musc++;
      else if (actual === TissueType.FLAGELLA) flag++;
    }

    if (tOccupied && aOccupied) {
      intersection++;
      if (target === actual) tissueMatched++;
    }
    if (tOccupied || aOccupied) union++;
  }

  // Blend spatial overlap IoU and tissue fidelity
  const shapeIou = union > 0 ? intersection / union : 0;
  const tissueAcc = intersection > 0 ? tissueMatched / intersection : 0;
  const iouPercent = union > 0 ? (shapeIou * 0.55 + shapeIou * tissueAcc * 0.45) * 100 : 0;

  state.iouPercent = iouPercent;
  state.totalVisibleCoverage = visibleCount;
  state.targetCoverage = targetCount;

  // Determine current dominant active wave level
  let activeWave: MipLevel = 3;
  for (const lvl of [0, 1, 2, 3] as MipLevel[]) {
    if (layers[lvl].activeCount > 0) {
      activeWave = lvl;
      break;
    }
  }
  state.activeWaveLevel = activeWave;

  const point: TelemetryPoint = {
    tick: state.tick,
    iouPercent,
    l3Count: layers[3].activeCount,
    l2Count: layers[2].activeCount,
    l1Count: layers[1].activeCount,
    l0Count: layers[0].activeCount,
    epidermis: epi,
    mesoderm: meso,
    vascular: vasc,
    neural: neur,
    sensor: sens,
    muscle: musc,
    flagella: flag,
  };

  if (state.history.length === 0 || state.history[state.history.length - 1].tick !== state.tick) {
    state.history.push(point);
    if (state.history.length > 260) {
      // Downsample older points subtly or trim oldest while keeping start
      state.history.splice(1, 1);
    }
  }
}

export function createSimState(genome: CompiledGenome, params: SimParams): SimState {
  const layers: Record<MipLevel, SimLayerState> = {
    0: createEmptySimLayer(0),
    1: createEmptySimLayer(1),
    2: createEmptySimLayer(2),
    3: createEmptySimLayer(3),
  };

  const nutrients = createNutrientField(params.nutrientDensity);

  if (params.growthMode === 'mipmap') {
    const seedNode = genome.nodeById.get(genome.seedNodeId);
    if (seedNode) {
      const l3 = layers[3];
      const idx = seedNode.gy * l3.dim + seedNode.gx;
      l3.alive[idx] = 1;
      l3.nodeId[idx] = seedNode.id;
      l3.tissue[idx] = seedNode.tissue;
      l3.energy[idx] = 1.0;
      l3.flash[idx] = 1.0;
      l3.activeCount = 1;
    }
  } else {
    const seedNode = genome.legacyNodeById.get(genome.legacySeedNodeId);
    if (seedNode) {
      const l0 = layers[0];
      const idx = seedNode.gy * l0.dim + seedNode.gx;
      l0.alive[idx] = 1;
      l0.nodeId[idx] = seedNode.id;
      l0.tissue[idx] = seedNode.tissue;
      l0.energy[idx] = 1.0;
      l0.flash[idx] = 1.0;
      l0.activeCount = 1;
    }
  }

  const state: SimState = {
    tick: 0,
    layers,
    nutrients,
    compositeTissue: new Uint8Array(BASE_DIM * BASE_DIM),
    compositeLevel: new Int8Array(BASE_DIM * BASE_DIM),
    compositeNodeId: new Int32Array(BASE_DIM * BASE_DIM),
    lastDivisions: 0,
    iouPercent: 0,
    totalVisibleCoverage: 0,
    targetCoverage: genome.layers[0].activeCount,
    activeWaveLevel: params.growthMode === 'mipmap' ? 3 : 0,
    history: [],
  };

  rebuildCompositeAndMetrics(state, genome);
  return state;
}

function sampleBlockNutrient(nutrients: Float32Array, gx: number, gy: number, stride: number): number {
  if (stride === 1) {
    return nutrients[gy * BASE_DIM + gx];
  }
  let sum = 0;
  let count = 0;
  const sx = gx * stride;
  const sy = gy * stride;
  for (let dy = 0; dy < stride; dy++) {
    const py = sy + dy;
    if (py < 0 || py >= BASE_DIM) continue;
    const row = py * BASE_DIM;
    for (let dx = 0; dx < stride; dx++) {
      const px = sx + dx;
      if (px >= 0 && px < BASE_DIM) {
        sum += nutrients[row + px];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

function consumeBlockNutrient(nutrients: Float32Array, gx: number, gy: number, stride: number, amount: number): number {
  if (stride === 1) {
    const idx = gy * BASE_DIM + gx;
    const avail = nutrients[idx];
    const take = avail < amount ? avail : amount;
    nutrients[idx] = avail - take;
    return take;
  }
  let harvested = 0;
  const sx = gx * stride;
  const sy = gy * stride;
  const perPixel = amount / (stride * stride);
  for (let dy = 0; dy < stride; dy++) {
    const row = (sy + dy) * BASE_DIM + sx;
    for (let dx = 0; dx < stride; dx++) {
      const idx = row + dx;
      const avail = nutrients[idx];
      const take = avail < perPixel ? avail : perPixel;
      nutrients[idx] = avail - take;
      harvested += take;
    }
  }
  return harvested;
}

export function stepSimulation(
  state: SimState,
  genome: CompiledGenome,
  params: SimParams,
): void {
  state.tick += 1;
  let divisionsThisTick = 0;

  // 1. Decay flashes, age cells, metabolize nutrients & propagate neural/vascular cues
  const nutrients = state.nutrients;
  for (let li = 0; li < MIP_LEVELS.length; li++) {
    const level = MIP_LEVELS[li];
    const layer = state.layers[level];
    if (layer.activeCount === 0) continue;

    const dim = layer.dim;
    const stride = layer.stride;
    const alive = layer.alive;
    const age = layer.age;
    const flash = layer.flash;
    const tissueArr = layer.tissue;
    const nextEnergy = ENERGY_SCRATCH[level];
    const nextSignal = SIGNAL_SCRATCH[level];
    nextEnergy.set(layer.energy);
    nextSignal.set(layer.signal);

    for (let gy = 0; gy < dim; gy++) {
      const row = gy * dim;
      for (let gx = 0; gx < dim; gx++) {
        const idx = row + gx;
        if (!alive[idx]) continue;

        if (age[idx] < 65535) age[idx] += 1;
        if (flash[idx] > 0) {
          const nf = flash[idx] - 0.16;
          flash[idx] = nf > 0 ? nf : 0;
        }

        const tissue = tissueArr[idx] as TissueType;

        // Basal nutrient absorption from medium
        const harvestRate =
          tissue === TissueType.VASCULAR
            ? 0.085 * params.vascularBoost
            : tissue === TissueType.EPIDERMIS
              ? 0.028
              : 0.036;
        const absorbed = consumeBlockNutrient(nutrients, gx, gy, stride, harvestRate);
        let e = nextEnergy[idx] + absorbed * 1.35 + 0.012;
        if (e > 1.0) e = 1.0;

        // Epidermis retains energy; others have tiny metabolic upkeep
        const upkeep = tissue === TissueType.EPIDERMIS ? 0.002 : 0.005;
        e -= upkeep;
        if (e < 0.05) e = 0.05;
        nextEnergy[idx] = e;

        // Vascular cells actively diffuse ATP to 4 neighbors; Neural cells broadcast morphogen signal
        if (tissue === TissueType.VASCULAR && e > 0.25) {
          const share = 0.045 * params.vascularBoost;
          if (gy > 0 && alive[idx - dim]) {
            const v = nextEnergy[idx - dim] + share;
            nextEnergy[idx - dim] = v > 1.0 ? 1.0 : v;
          }
          if (gy < dim - 1 && alive[idx + dim]) {
            const v = nextEnergy[idx + dim] + share;
            nextEnergy[idx + dim] = v > 1.0 ? 1.0 : v;
          }
          if (gx < dim - 1 && alive[idx + 1]) {
            const v = nextEnergy[idx + 1] + share;
            nextEnergy[idx + 1] = v > 1.0 ? 1.0 : v;
          }
          if (gx > 0 && alive[idx - 1]) {
            const v = nextEnergy[idx - 1] + share;
            nextEnergy[idx - 1] = v > 1.0 ? 1.0 : v;
          }
        }

        if (tissue === TissueType.NEURAL) {
          nextSignal[idx] = 1.0;
          if (gy > 0 && alive[idx - dim] && nextSignal[idx - dim] < 0.78) nextSignal[idx - dim] = 0.78;
          if (gy < dim - 1 && alive[idx + dim] && nextSignal[idx + dim] < 0.78) nextSignal[idx + dim] = 0.78;
          if (gx < dim - 1 && alive[idx + 1] && nextSignal[idx + 1] < 0.78) nextSignal[idx + 1] = 0.78;
          if (gx > 0 && alive[idx - 1] && nextSignal[idx - 1] < 0.78) nextSignal[idx - 1] = 0.78;
        } else {
          nextSignal[idx] *= 0.75;
        }
      }
    }

    layer.energy.set(nextEnergy);
    layer.signal.set(nextSignal);
  }

  // Slow ambient medium replenishment so regeneration remains possible
  const nFloor = params.nutrientDensity * 0.55;
  for (let i = 0; i < nutrients.length; i++) {
    if (nutrients[i] < nFloor) {
      const nv = nutrients[i] + 0.003;
      nutrients[i] = nv > 1.0 ? 1.0 : nv;
    }
  }

  if (params.growthMode === 'legacy') {
    // LEGACY SINGLE-GRID MODE (L0 only, sequential outward gather without mipmap hierarchy)
    const l0 = state.layers[0];
    const spawns: Array<{ idx: number; nodeId: number; tissue: TissueType; energy: number }> = [];
    const cap = params.legacyNodeCap > 0 ? params.legacyNodeCap : Infinity;

    for (let gy = 0; gy < BASE_DIM; gy++) {
      for (let gx = 0; gx < BASE_DIM; gx++) {
        const idx = gy * BASE_DIM + gx;
        if (l0.alive[idx]) continue;

        for (let d = 0; d < 4; d++) {
          const nx = gx + CARDINAL_DELTAS[d][0];
          const ny = gy + CARDINAL_DELTAS[d][1];
          if (nx < 0 || nx >= BASE_DIM || ny < 0 || ny >= BASE_DIM) continue;
          const nIdx = ny * BASE_DIM + nx;
          if (!l0.alive[nIdx]) continue;
          if (l0.age[nIdx] < Math.max(1, params.lateralDelay)) continue;
          if (l0.energy[nIdx] < params.divisionCost) continue;

          const neighborNodeId = l0.nodeId[nIdx];
          const neighborDir = genome.legacyNodeById.get(neighborNodeId);
          if (!neighborDir) continue;

          const targetId = neighborDir.lateralNeighbors[revNeighbor(d)];
          if (targetId > neighborNodeId && targetId <= cap) {
            const targetDir = genome.legacyNodeById.get(targetId);
            if (targetDir) {
              const localFood = nutrients[idx];
              if (localFood >= 0.05) {
                spawns.push({
                  idx,
                  nodeId: targetId,
                  tissue: targetDir.tissue,
                  energy: Math.min(1, l0.energy[nIdx] * 0.5 + localFood * 0.45),
                });
                l0.energy[nIdx] = Math.max(0.08, l0.energy[nIdx] - params.divisionCost * 0.55);
                break;
              }
            }
          }
        }
      }
    }

    for (const s of spawns) {
      if (!l0.alive[s.idx]) {
        l0.alive[s.idx] = 1;
        l0.nodeId[s.idx] = s.nodeId;
        l0.tissue[s.idx] = s.tissue;
        l0.age[s.idx] = 0;
        l0.energy[s.idx] = s.energy;
        l0.flash[s.idx] = 1.0;
        l0.activeCount++;
        divisionsThisTick++;
      }
    }

    state.lastDivisions = divisionsThisTick;
    if (divisionsThisTick > 0 || state.history.length === 0) {
      rebuildCompositeAndMetrics(state, genome);
    } else {
      const lastPt = state.history[state.history.length - 1];
      if (lastPt.tick !== state.tick) {
        state.history.push({ ...lastPt, tick: state.tick });
        if (state.history.length > 260) state.history.splice(1, 1);
      }
    }
    return;
  }

  // HIERARCHICAL MIPMAP MODE:
  // Step A: Lateral division within each level (builds sparse L3 scaffold first,
  //         and supports lateral wound healing / bridge repair in L2, L1, L0)
  for (let li = 0; li < MIP_LEVELS.length; li++) {
    const level = MIP_LEVELS[li];
    const layer = state.layers[level];
    const compiledLayer = genome.layers[level];
    // Fast skip: if this layer already holds every blueprint cell, no empty slots remain
    if (compiledLayer.activeCount === 0 || layer.activeCount >= compiledLayer.activeCount) continue;

    const parentLevelHasBeenReached =
      level === MAX_MIP_LEVEL ||
      state.layers[(level + 1) as MipLevel].activeCount >=
        Math.max(1, Math.floor(genome.layers[(level + 1) as MipLevel].activeCount * 0.5));
    if (!parentLevelHasBeenReached) continue;

    const minAge = level === MAX_MIP_LEVEL ? Math.max(1, params.lateralDelay) : 2;
    const minEnergy = params.divisionCost * 0.45;
    const dim = layer.dim;

    // Collect lateral gather spawns
    const lateralSpawns: Array<{
      idx: number;
      nodeId: number;
      tissue: TissueType;
      energy: number;
      parentIdx: number;
    }> = [];

    for (let gy = 0; gy < dim; gy++) {
      for (let gx = 0; gx < dim; gx++) {
        const idx = gy * dim + gx;
        if (layer.alive[idx]) continue;

        for (let d = 0; d < 4; d++) {
          const nx = gx + CARDINAL_DELTAS[d][0];
          const ny = gy + CARDINAL_DELTAS[d][1];
          if (nx < 0 || nx >= dim || ny < 0 || ny >= dim) continue;
          const nIdx = ny * dim + nx;
          if (!layer.alive[nIdx]) continue;
          if (layer.age[nIdx] < minAge) continue;
          if (layer.energy[nIdx] < minEnergy) continue;

          const neighborNode = genome.nodeById.get(layer.nodeId[nIdx]);
          if (!neighborNode) continue;

          const targetId = neighborNode.lateralNeighbors[revNeighbor(d)];
          if (targetId <= 0) continue;

          const allowLateral =
            level === MAX_MIP_LEVEL ||
            targetId > neighborNode.id ||
            layer.age[nIdx] >= params.subdivisionDelay + 4;

          if (allowLateral) {
            const targetNode = genome.nodeById.get(targetId);
            if (targetNode) {
              const blockFood = sampleBlockNutrient(nutrients, gx, gy, layer.stride);
              lateralSpawns.push({
                idx,
                nodeId: targetId,
                tissue: targetNode.tissue,
                energy: Math.min(1.0, layer.energy[nIdx] * 0.55 + blockFood * 0.45),
                parentIdx: nIdx,
              });
              break;
            }
          }
        }
      }
    }

    for (let i = 0; i < lateralSpawns.length; i++) {
      const s = lateralSpawns[i];
      if (!layer.alive[s.idx]) {
        layer.alive[s.idx] = 1;
        layer.nodeId[s.idx] = s.nodeId;
        layer.tissue[s.idx] = s.tissue;
        layer.age[s.idx] = 0;
        layer.energy[s.idx] = s.energy;
        layer.flash[s.idx] = 1.0;
        layer.activeCount++;
        layer.energy[s.parentIdx] = Math.max(0.15, layer.energy[s.parentIdx] - params.divisionCost * 0.28);
        divisionsThisTick++;
      }
    }

    // Pioneer migration bridges across disconnected islands at coarsest level
    if (level === MAX_MIP_LEVEL) {
      for (let idx = 0; idx < dim * dim; idx++) {
        if (!layer.alive[idx] || layer.age[idx] < params.lateralDelay + 2) continue;
        const srcNode = genome.nodeById.get(layer.nodeId[idx]);
        if (!srcNode || srcNode.bridgeTargetIds.length === 0) continue;

        for (const bId of srcNode.bridgeTargetIds) {
          const bNode = genome.nodeById.get(bId);
          if (!bNode) continue;
          const bIdx = bNode.gy * dim + bNode.gx;
          if (!layer.alive[bIdx]) {
            layer.alive[bIdx] = 1;
            layer.nodeId[bIdx] = bNode.id;
            layer.tissue[bIdx] = bNode.tissue;
            layer.age[bIdx] = 0;
            layer.energy[bIdx] = 0.85;
            layer.flash[bIdx] = 1.0;
            layer.activeCount++;
            divisionsThisTick++;
          }
        }
      }
    }
  }

  // Step B: Downward Mipmap Subdivision (L -> L - 1)
  // Coarse cells divide into their 4 higher-resolution sub-quadrants [TL, TR, BL, BR],
  // specializing into distinct tissues as they descend through the mipmap hierarchy.
  for (let parentLevel = MAX_MIP_LEVEL; parentLevel >= 1; parentLevel--) {
    const pLvl = parentLevel as MipLevel;
    const cLvl = (parentLevel - 1) as MipLevel;
    const pLayer = state.layers[pLvl];
    const cLayer = state.layers[cLvl];
    const compiledParent = genome.layers[pLvl];
    const compiledChild = genome.layers[cLvl];

    if (pLayer.activeCount === 0 || cLayer.activeCount >= compiledChild.activeCount) continue;

    // If stagedWaves is enabled, ensure the coarse scaffold reaches ~80% completion
    // before triggering the next higher-resolution wave, clearly demonstrating
    // "simplified pattern first, complex version later".
    if (params.stagedWaves) {
      const completion =
        compiledParent.activeCount > 0 ? pLayer.activeCount / compiledParent.activeCount : 1;
      if (completion < 0.82) continue;
    }

    for (let gy = 0; gy < pLayer.dim; gy++) {
      for (let gx = 0; gx < pLayer.dim; gx++) {
        const pIdx = gy * pLayer.dim + gx;
        if (!pLayer.alive[pIdx]) continue;

        // Neural signals accelerate subdivision maturation
        const neuralAccel = pLayer.signal[pIdx] > 0.4 ? Math.max(1, Math.floor(params.subdivisionDelay * 0.45)) : 0;
        const requiredAge = Math.max(1, params.subdivisionDelay - neuralAccel);
        if (pLayer.age[pIdx] < requiredAge) continue;
        if (pLayer.energy[pIdx] < params.divisionCost * 0.35) continue;

        const pNode = genome.nodeById.get(pLayer.nodeId[pIdx]);
        if (!pNode) continue;

        let spawnedAny = false;
        let qIdx = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const childId = pNode.subdivisionChildren[qIdx++];
            if (childId <= 0) continue;
            const cgx = gx * 2 + dx;
            const cgy = gy * 2 + dy;
            const cIdx = cgy * cLayer.dim + cgx;
            if (cLayer.alive[cIdx]) continue;

            const cNode = genome.nodeById.get(childId);
            if (!cNode) continue;

            const blockFood = sampleBlockNutrient(nutrients, cgx, cgy, cLayer.stride);
            cLayer.alive[cIdx] = 1;
            cLayer.nodeId[cIdx] = cNode.id;
            cLayer.tissue[cIdx] = cNode.tissue;
            cLayer.age[cIdx] = 0;
            cLayer.energy[cIdx] = Math.min(1.0, Math.max(0.42, pLayer.energy[pIdx] * 0.6 + blockFood * 0.4));
            cLayer.flash[cIdx] = 1.0;
            cLayer.signal[cIdx] = pLayer.signal[pIdx];
            cLayer.activeCount++;
            divisionsThisTick++;
            spawnedAny = true;
          }
        }

        if (spawnedAny) {
          pLayer.energy[pIdx] = Math.max(0.2, pLayer.energy[pIdx] - params.divisionCost * 0.25);
        }
      }
    }
  }

  state.lastDivisions = divisionsThisTick;
  if (divisionsThisTick > 0 || state.history.length === 0) {
    rebuildCompositeAndMetrics(state, genome);
  } else {
    const lastPt = state.history[state.history.length - 1];
    if (lastPt.tick !== state.tick) {
      state.history.push({ ...lastPt, tick: state.tick });
      if (state.history.length > 260) {
        state.history.splice(1, 1);
      }
    }
  }
}

/**
 * Excises cells across all mipmap layers within radius `r` around physical coordinate (px, py)
 * to test live wound healing and morphogenetic regeneration.
 */
export function injureSimulation(
  state: SimState,
  genome: CompiledGenome,
  px: number,
  py: number,
  radius: number,
  rebuildMetrics = true,
): void {
  for (const level of MIP_LEVELS) {
    const layer = state.layers[level];
    const stride = layer.stride;
    for (let gy = 0; gy < layer.dim; gy++) {
      for (let gx = 0; gx < layer.dim; gx++) {
        const idx = gy * layer.dim + gx;
        if (!layer.alive[idx]) continue;
        const cx = gx * stride + stride * 0.5;
        const cy = gy * stride + stride * 0.5;
        if (Math.hypot(cx - px, cy - py) <= radius + stride * 0.35) {
          layer.alive[idx] = 0;
          layer.nodeId[idx] = 0;
          layer.tissue[idx] = TissueType.EMPTY;
          layer.age[idx] = 0;
          layer.energy[idx] = 0;
          layer.flash[idx] = 0;
          layer.activeCount = Math.max(0, layer.activeCount - 1);
        }
      }
    }
  }
  if (rebuildMetrics) {
    rebuildCompositeAndMetrics(state, genome);
  }
}

/**
 * Excises a single ruptured cell at `(meshLevel, gx, gy)` and its fine L1/L0 sub-cells,
 * pruning any coarse parent block left empty so morphogenesis can heal the wound.
 */
export function exciseSimCellBlock(
  state: SimState,
  genome: CompiledGenome,
  meshLevel: MipLevel,
  gx: number,
  gy: number,
  rebuildMetrics = true,
): void {
  const layer = state.layers[meshLevel];
  const idx = gy * layer.dim + gx;
  if (layer.alive[idx]) {
    layer.alive[idx] = 0;
    layer.nodeId[idx] = 0;
    layer.tissue[idx] = TissueType.EMPTY;
    layer.age[idx] = 0;
    layer.energy[idx] = 0;
    layer.flash[idx] = 0;
    layer.activeCount = Math.max(0, layer.activeCount - 1);
  }

  // Clear descending child layers inside this block
  for (let cl = meshLevel - 1; cl >= 0; cl--) {
    const subLayer = state.layers[cl as MipLevel];
    const scale = 1 << (meshLevel - cl);
    const sx = gx * scale;
    const sy = gy * scale;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const sIdx = (sy + dy) * subLayer.dim + (sx + dx);
        if (subLayer.alive[sIdx]) {
          subLayer.alive[sIdx] = 0;
          subLayer.nodeId[sIdx] = 0;
          subLayer.tissue[sIdx] = TissueType.EMPTY;
          subLayer.age[sIdx] = 0;
          subLayer.energy[sIdx] = 0;
          subLayer.flash[sIdx] = 0;
          subLayer.activeCount = Math.max(0, subLayer.activeCount - 1);
        }
      }
    }
  }

  // If coarse L3 parent now has zero alive L2 daughters, clear the L3 parent too
  if (meshLevel === 2) {
    const l3 = state.layers[3];
    const px = gx >> 1;
    const py = gy >> 1;
    const pIdx = py * l3.dim + px;
    if (l3.alive[pIdx]) {
      const x0 = px * 2;
      const y0 = py * 2;
      const hasChild =
        layer.alive[y0 * layer.dim + x0] ||
        layer.alive[y0 * layer.dim + x0 + 1] ||
        layer.alive[(y0 + 1) * layer.dim + x0] ||
        layer.alive[(y0 + 1) * layer.dim + x0 + 1];
      if (!hasChild) {
        l3.alive[pIdx] = 0;
        l3.nodeId[pIdx] = 0;
        l3.tissue[pIdx] = TissueType.EMPTY;
        l3.age[pIdx] = 0;
        l3.energy[pIdx] = 0;
        l3.activeCount = Math.max(0, l3.activeCount - 1);
      }
    }
  }

  if (rebuildMetrics) {
    rebuildCompositeAndMetrics(state, genome);
  }
}

export function refreshSimComposite(state: SimState, genome: CompiledGenome): void {
  rebuildCompositeAndMetrics(state, genome);
}

/**
 * Clones a SimState keeping ONLY the cells belonging to `keepKeys` at `meshLevel`
 * (and their matching ancestor/descendant blocks across L3..L0).
 */
export function cloneSimStateMasked(
  source: SimState,
  genome: CompiledGenome,
  meshLevel: MipLevel,
  keepKeys: Set<number>,
): SimState {
  const layers: Record<MipLevel, SimLayerState> = {
    0: createEmptySimLayer(0),
    1: createEmptySimLayer(1),
    2: createEmptySimLayer(2),
    3: createEmptySimLayer(3),
  };

  const mDim = mipDim(meshLevel);
  for (const key of keepKeys) {
    const gx = key % mDim;
    const gy = Math.floor(key / mDim);

    // Copy meshLevel & descendant layers
    for (let cl = meshLevel; cl >= 0; cl--) {
      const srcL = source.layers[cl as MipLevel];
      const dstL = layers[cl as MipLevel];
      const scale = 1 << (meshLevel - cl);
      const sx = gx * scale;
      const sy = gy * scale;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (sy + dy) * srcL.dim + (sx + dx);
          if (srcL.alive[i]) {
            dstL.alive[i] = 1;
            dstL.nodeId[i] = srcL.nodeId[i];
            dstL.tissue[i] = srcL.tissue[i];
            dstL.age[i] = srcL.age[i];
            dstL.energy[i] = srcL.energy[i];
            dstL.signal[i] = srcL.signal[i];
            dstL.activeCount++;
          }
        }
      }
    }

    // Ensure ancestor L3 cell is active if meshLevel < 3
    if (meshLevel < 3) {
      const shift = 3 - meshLevel;
      const px = gx >> shift;
      const py = gy >> shift;
      const src3 = source.layers[3];
      const dst3 = layers[3];
      const pIdx = py * src3.dim + px;
      if (src3.alive[pIdx] && !dst3.alive[pIdx]) {
        dst3.alive[pIdx] = 1;
        dst3.nodeId[pIdx] = src3.nodeId[pIdx];
        dst3.tissue[pIdx] = src3.tissue[pIdx];
        dst3.age[pIdx] = src3.age[pIdx];
        dst3.energy[pIdx] = src3.energy[pIdx];
        dst3.signal[pIdx] = src3.signal[pIdx];
        dst3.activeCount++;
      }
    }
  }

  const nextState: SimState = {
    tick: source.tick,
    layers,
    nutrients: new Float32Array(source.nutrients),
    compositeTissue: new Uint8Array(BASE_DIM * BASE_DIM),
    compositeLevel: new Int8Array(BASE_DIM * BASE_DIM),
    compositeNodeId: new Int32Array(BASE_DIM * BASE_DIM),
    lastDivisions: 0,
    iouPercent: 0,
    totalVisibleCoverage: 0,
    targetCoverage: source.targetCoverage,
    activeWaveLevel: meshLevel,
    history: [],
  };

  rebuildCompositeAndMetrics(nextState, genome);
  return nextState;
}

/**
 * Merges living cells from a disconnected fragment's SimState back into the host SimState.
 */
export function mergeSimStateFromFragment(
  target: SimState,
  frag: SimState,
  genome: CompiledGenome,
): void {
  for (const level of MIP_LEVELS) {
    const tL = target.layers[level];
    const fL = frag.layers[level];
    for (let i = 0; i < fL.alive.length; i++) {
      if (fL.alive[i] && !tL.alive[i]) {
        tL.alive[i] = 1;
        tL.nodeId[i] = fL.nodeId[i];
        tL.tissue[i] = fL.tissue[i];
        tL.age[i] = fL.age[i];
        tL.energy[i] = fL.energy[i];
        tL.flash[i] = 1.0;
        tL.signal[i] = fL.signal[i];
        tL.activeCount++;
      }
    }
  }
  rebuildCompositeAndMetrics(target, genome);
}
