import {
  BASE_DIM,
  CompiledGenome,
  FoodPellet,
  MipLevel,
  SimParams,
  SoftCell,
  TissueType,
  WorldOrganism,
  WorldParams,
  WorldState,
  mipDim,
} from '../types/morphogenesis';
import { compileBlueprintToGenome } from './compiler';
import { crossoverGenomes } from './genetics';
import {
  blendNeuralNetState,
  cloneNeuralNetState,
  createNeuralNetState,
  crossoverNeuralNetStates,
} from './neuralNet';
import { ORGANISM_PRESETS } from './presets';
import {
  cloneSimStateMasked,
  createSimState,
  exciseSimCellBlock,
  injureSimulation,
  mergeSimStateFromFragment,
  refreshSimComposite,
  stepSimulation,
} from './simulator';
import {
  createEmptySoftMesh,
  extractMeshComponents,
  extractSubMeshByKeys,
  mergeFragmentIntoMesh,
  retainMeshCellsByKeys,
  stepSoftBodyPhysics,
  syncOrganismMeshFromSimState,
} from './softBodyPhysics';

export const WORLD_WIDTH = 1280;
export const WORLD_HEIGHT = 800;
const CHEM_CELL = 10;
const CHEM_COLS = WORLD_WIDTH / CHEM_CELL; // 128
const CHEM_ROWS = WORLD_HEIGHT / CHEM_CELL; // 80

// Pre-allocated diffusion buffer (eliminates per-tick typed-array allocations)
const CHEM_SCRATCH = new Float32Array(CHEM_COLS * CHEM_ROWS);

// Reusable spatial-hash buckets for O(V) collision checks
const HASH_CELL = 6;
const HASH_COLS = Math.ceil((WORLD_WIDTH + 200) / HASH_CELL);
const SPATIAL_BUCKETS = new Map<number, number[]>();
const BUCKET_POOL: number[][] = [];
let BUCKET_POOL_USED = 0;

function resetSpatialHash(): void {
  SPATIAL_BUCKETS.clear();
  BUCKET_POOL_USED = 0;
}

function acquireBucket(): number[] {
  if (BUCKET_POOL_USED < BUCKET_POOL.length) {
    const arr = BUCKET_POOL[BUCKET_POOL_USED++];
    arr.length = 0;
    return arr;
  }
  const arr: number[] = [];
  BUCKET_POOL.push(arr);
  BUCKET_POOL_USED++;
  return arr;
}

export const DEFAULT_WORLD_PARAMS: WorldParams = {
  fluidDrag: 0.04,
  internalPressure: 1.25,
  muscleStrength: 0.28,
  muscleFrequency: 0.2,
  flagellaThrust: 1.45,
  gradientSensitivity: 2.0,
  scentDiffusion: 0.16,
  growthRate: 1.25,
  metabolismRate: 1.0,
  autoMating: true,
  maxOrganisms: 18,
};

export function createInitialWorld(simParams: SimParams): WorldState {
  const world: WorldState = {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    chemCols: CHEM_COLS,
    chemRows: CHEM_ROWS,
    foodField: new Float32Array(CHEM_COLS * CHEM_ROWS),
    scentField: new Float32Array(CHEM_COLS * CHEM_ROWS),
    toxinField: new Float32Array(CHEM_COLS * CHEM_ROWS),
    pellets: [],
    organisms: [],
    nextOrgId: 1,
    nextPelletId: 1,
    worldTick: 0,
    totalBirths: 0,
    deathsStarved: 0,
    deathsExited: 0,
    deathsRuptured: 0,
    totalReconnections: 0,
    totalSplits: 0,
  };

  const pelletCoords: [number, number][] = [
    [230, 180],
    [640, 170],
    [1040, 200],
    [410, 390],
    [860, 410],
    [220, 620],
    [650, 630],
    [1050, 600],
    [520, 260],
    [770, 540],
  ];
  for (const [px, py] of pelletCoords) {
    world.pellets.push({
      id: world.nextPelletId++,
      x: px,
      y: py,
      radius: 10,
      amount: 1.0,
    });
    depositChemical(world.foodField, px, py, 0.9, 5);
  }

  // Spawn 6 diverse swimmers across the larger 1280x800 tank
  const spawns: Array<{
    presetIdx: number;
    x: number;
    y: number;
    heading: number;
    preGrowTicks: number;
  }> = [
    { presetIdx: 0, x: 240, y: 310, heading: -0.2, preGrowTicks: 10 },
    { presetIdx: 1, x: 1020, y: 300, heading: 2.85, preGrowTicks: 10 },
    { presetIdx: 2, x: 620, y: 240, heading: 1.45, preGrowTicks: 10 },
    { presetIdx: 3, x: 460, y: 550, heading: -0.95, preGrowTicks: 10 },
    { presetIdx: 4, x: 850, y: 540, heading: -2.2, preGrowTicks: 10 },
    { presetIdx: 0, x: 660, y: 450, heading: 0.4, preGrowTicks: 10 },
  ];

  for (const sp of spawns) {
    const preset = ORGANISM_PRESETS[sp.presetIdx];
    const bp = preset.generate(BASE_DIM);
    const genome = compileBlueprintToGenome(bp);
    spawnOrganismInWorld(
      world,
      genome,
      preset.name,
      preset.id,
      simParams,
      sp.x,
      sp.y,
      sp.heading,
      sp.preGrowTicks,
    );
  }

  for (let i = 0; i < 6; i++) {
    diffuseField(world.foodField, 0.22, 0.995);
  }

  return world;
}

export function spawnOrganismInWorld(
  world: WorldState,
  genome: CompiledGenome,
  name: string,
  presetId: string,
  simParams: SimParams,
  x: number,
  y: number,
  headingAngle = Math.random() * Math.PI * 2 - Math.PI,
  initialGrowthTicks = 2,
  generation = 1,
  parentIds: [number, number] | null = null,
  inheritedNeuralNet = createNeuralNetState(genome),
): WorldOrganism {
  const simState = createSimState(genome, { ...simParams, growthMode: 'mipmap' });
  for (let t = 0; t < initialGrowthTicks; t++) {
    stepSimulation(simState, genome, { ...simParams, growthMode: 'mipmap' });
  }

  const mesh = createEmptySoftMesh(x, y, headingAngle);
  syncOrganismMeshFromSimState(mesh, simState, genome);

  const id = world.nextOrgId++;
  const org: WorldOrganism = {
    id,
    colonyId: id,
    isFragment: false,
    fragmentBirthCellCount: mesh.cells.length,
    fragmentTicks: 0,
    name,
    presetId,
    generation,
    parentIds,
    genome,
    simState,
    params: { ...simParams, growthMode: 'mipmap' },
    mesh,
    energyReserve: 92,
    lastMetabolicDrain: 0,
    steerBias: 0,
    sensorMagnitude: 0,
    neuralNet: inheritedNeuralNet,
    musclePhaseTime: Math.random() * Math.PI * 2,
    speed: 0,
    ageTicks: 0,
    matingCooldown: 120,
    consumedFood: 0,
    rupturedCells: 0,
    damageFlash: 0,
  };

  world.organisms.push(org);
  return org;
}

export function mateOrganisms(
  world: WorldState,
  parentA: WorldOrganism,
  parentB: WorldOrganism,
  simParams: SimParams,
): WorldOrganism {
  const hybridGenome = crossoverGenomes(parentA.genome, parentB.genome);
  const dxp = parentB.mesh.comX - parentA.mesh.comX;
  const dyp = parentB.mesh.comY - parentA.mesh.comY;
  const pLen = Math.max(1, Math.hypot(dxp, dyp));
  const perpSign = Math.random() < 0.5 ? 1 : -1;
  const perpX = (-dyp / pLen) * perpSign;
  const perpY = (dxp / pLen) * perpSign;
  const mx = (parentA.mesh.comX + parentB.mesh.comX) * 0.5 + perpX * 60;
  const my = (parentA.mesh.comY + parentB.mesh.comY) * 0.5 + perpY * 60;
  const clampedX = Math.max(55, Math.min(world.width - 55, mx));
  const clampedY = Math.max(55, Math.min(world.height - 55, my));

  const gen = Math.max(parentA.generation, parentB.generation) + 1;
  const shortA = parentA.name.split(' ')[0];
  const shortB = parentB.name.split(' ')[0];
  const childName = `${shortA}×${shortB} G${gen}`;

  parentA.energyReserve = Math.max(14, parentA.energyReserve - 20);
  parentB.energyReserve = Math.max(14, parentB.energyReserve - 20);
  parentA.matingCooldown = 260;
  parentB.matingCooldown = 260;

  world.totalBirths += 1;

  const hybridNet = crossoverNeuralNetStates(parentA.neuralNet, parentB.neuralNet);

  return spawnOrganismInWorld(
    world,
    hybridGenome,
    childName,
    'hybrid',
    simParams,
    clampedX,
    clampedY,
    Math.random() * Math.PI * 2 - Math.PI,
    1,
    gen,
    [parentA.colonyId, parentB.colonyId],
    hybridNet,
  );
}

export function sampleFieldBilinear(field: Float32Array, wx: number, wy: number): number {
  const fx = Math.max(0, Math.min(CHEM_COLS - 1.001, wx / CHEM_CELL - 0.5));
  const fy = Math.max(0, Math.min(CHEM_ROWS - 1.001, wy / CHEM_CELL - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(CHEM_COLS - 1, x0 + 1);
  const y1 = Math.min(CHEM_ROWS - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const row0 = y0 * CHEM_COLS;
  const row1 = y1 * CHEM_COLS;
  const v00 = field[row0 + x0];
  const v10 = field[row0 + x1];
  const v01 = field[row1 + x0];
  const v11 = field[row1 + x1];

  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

export function depositChemical(
  field: Float32Array,
  wx: number,
  wy: number,
  amount: number,
  radiusCells = 2,
): void {
  const cx = Math.floor(wx / CHEM_CELL);
  const cy = Math.floor(wy / CHEM_CELL);
  const r2 = radiusCells * radiusCells;
  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    const ny = cy + dy;
    if (ny < 0 || ny >= CHEM_ROWS) continue;
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const nx = cx + dx;
      if (nx < 0 || nx >= CHEM_COLS) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) {
        const falloff = 1 - Math.sqrt(d2) / (radiusCells + 0.5);
        const idx = ny * CHEM_COLS + nx;
        field[idx] = Math.min(2.0, field[idx] + amount * falloff);
      }
    }
  }
}

function diffuseField(field: Float32Array, rate: number, decay: number): void {
  for (let y = 0; y < CHEM_ROWS; y++) {
    const row = y * CHEM_COLS;
    const rowUp = y > 0 ? row - CHEM_COLS : row;
    const rowDn = y < CHEM_ROWS - 1 ? row + CHEM_COLS : row;
    for (let x = 0; x < CHEM_COLS; x++) {
      const idx = row + x;
      const c = field[idx];
      const n = field[rowUp + x];
      const s = field[rowDn + x];
      const w = x > 0 ? field[idx - 1] : c;
      const e = x < CHEM_COLS - 1 ? field[idx + 1] : c;
      const avg = (n + s + w + e) * 0.25;
      CHEM_SCRATCH[idx] = Math.max(0, (c + rate * (avg - c)) * decay);
    }
  }
  field.set(CHEM_SCRATCH);
}

function releaseDeathNutrients(world: WorldState, org: WorldOrganism): void {
  const cx = Math.max(20, Math.min(world.width - 20, org.mesh.comX));
  const cy = Math.max(20, Math.min(world.height - 20, org.mesh.comY));
  const cellCount = Math.max(1, org.mesh.cells.length);
  const scentAmount = Math.min(0.95, 0.08 + cellCount * 0.012);
  depositChemical(world.foodField, cx, cy, scentAmount, cellCount >= 12 ? 4 : 2);

  // Only drop solid food pellets for substantial carcasses so tiny broken slivers don't synthesize free energy
  if (cellCount < 6) return;

  const pelletDrops = cellCount > 140 ? 3 : cellCount > 55 ? 2 : 1;
  const totalBiomass = Math.min(2.4, cellCount * 0.0085);
  const amountPerPellet = Math.min(1.0, totalBiomass / pelletDrops);
  for (let i = 0; i < pelletDrops; i++) {
    if (world.pellets.length >= 24) break;
    const ang = (i * Math.PI * 2) / pelletDrops + Math.random() * 0.5;
    const rad = pelletDrops === 1 ? 0 : 12;
    const px = Math.max(25, Math.min(world.width - 25, cx + Math.cos(ang) * rad));
    const py = Math.max(25, Math.min(world.height - 25, cy + Math.sin(ang) * rad));
    world.pellets.push({
      id: world.nextPelletId++,
      x: px,
      y: py,
      radius: 9,
      amount: amountPerPellet,
    });
  }
}

/**
 * Spatial-hashed O(V) collision resolution with strong elastic overlap bounce,
 * inter-organism squish damage accumulation, and colony touch detection.
 */
function resolveOrganismCollisions(world: WorldState): {
  contactPairs: Array<[number, number]>;
  squishedVerts: Map<number, Set<number>>;
} {
  const organisms = world.organisms;
  const contactPairs: Array<[number, number]> = [];
  const squishedVerts = new Map<number, Set<number>>();
  if (organisms.length < 2) return { contactPairs, squishedVerts };

  const minVertDist = 3.1;
  const minVertDist2 = minVertDist * minVertDist;

  for (let a = 0; a < organisms.length; a++) {
    const orgA = organisms[a];
    const vertsA = orgA.mesh.vertices;
    if (vertsA.length === 0) continue;

    // Quick broad-phase culling using tight per-organism bounding radii
    let hashedA = false;

    for (let b = a + 1; b < organisms.length; b++) {
      const orgB = organisms[b];
      const vertsB = orgB.mesh.vertices;
      if (vertsB.length === 0) continue;

      const cDx = orgB.mesh.comX - orgA.mesh.comX;
      const cDy = orgB.mesh.comY - orgA.mesh.comY;
      const maxSep = orgA.mesh.boundRadius + orgB.mesh.boundRadius + 6;
      if (cDx * cDx + cDy * cDy > maxSep * maxSep) continue;

      // Lazy-build spatial hash of orgA vertices only if an actual broad-phase candidate overlaps
      if (!hashedA) {
        resetSpatialHash();
        for (let i = 0; i < vertsA.length; i++) {
          const hx = Math.floor((vertsA[i].x + 100) / HASH_CELL);
          const hy = Math.floor((vertsA[i].y + 100) / HASH_CELL);
          const hKey = hy * HASH_COLS + hx;
          let bucket = SPATIAL_BUCKETS.get(hKey);
          if (!bucket) {
            bucket = acquireBucket();
            SPATIAL_BUCKETS.set(hKey, bucket);
          }
          bucket.push(i);
        }
        hashedA = true;
      }

      const sameColony = orgA.colonyId === orgB.colonyId;
      let contactCount = 0;
      let pushSumX = 0;
      let pushSumY = 0;
      let overlapIntensity = 0;

      for (let j = 0; j < vertsB.length; j++) {
        const vb = vertsB[j];
        const bx = Math.floor((vb.x + 100) / HASH_CELL);
        const by = Math.floor((vb.y + 100) / HASH_CELL);

        for (let oy = -1; oy <= 1; oy++) {
          const rowKey = (by + oy) * HASH_COLS;
          for (let ox = -1; ox <= 1; ox++) {
            const bucket = SPATIAL_BUCKETS.get(rowKey + bx + ox);
            if (!bucket) continue;

            for (let k = 0; k < bucket.length; k++) {
              const i = bucket[k];
              const va = vertsA[i];
              const dx = vb.x - va.x;
              const dy = vb.y - va.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < minVertDist2 && d2 > 1e-6) {
                contactCount++;
                const d = Math.sqrt(d2);
                const overlap = minVertDist - d;
                const cappedOverlap = Math.min(1.4, overlap);
                const nx = dx / d;
                const ny = dy / d;

                // Strong elastic overlap bounce (lighter when fragments of same colony approach to reconnect)
                const bounceScale = sameColony ? 0.35 : 1.0;
                const posPush = Math.min(0.52, cappedOverlap * 0.24 * bounceScale);
                va.x -= nx * posPush;
                va.y -= ny * posPush;
                vb.x += nx * posPush;
                vb.y += ny * posPush;

                const impulse = cappedOverlap * 0.58 * bounceScale;
                va.vx -= nx * impulse;
                va.vy -= ny * impulse;
                vb.vx += nx * impulse;
                vb.vy += ny * impulse;

                pushSumX += nx * cappedOverlap;
                pushSumY += ny * cappedOverlap;
                overlapIntensity += cappedOverlap;

                // Intense high-velocity/deep overlap impact contributes squish damage stress
                if (!sameColony && cappedOverlap > 0.78) {
                  let setA = squishedVerts.get(orgA.id);
                  if (!setA) {
                    setA = new Set();
                    squishedVerts.set(orgA.id, setA);
                  }
                  setA.add(i);

                  let setB = squishedVerts.get(orgB.id);
                  if (!setB) {
                    setB = new Set();
                    squishedVerts.set(orgB.id, setB);
                  }
                  setB.add(j);
                }
              }
            }
          }
        }
      }

      // Distribute net elastic rebound smoothly across both bodies so overlapping organisms bounce strongly apart
      if (contactCount > 0 && !sameColony) {
        const avgNx = pushSumX / contactCount;
        const avgNy = pushSumY / contactCount;
        const nLen = Math.hypot(avgNx, avgNy);
        if (nLen > 1e-4) {
          const dirX = avgNx / nLen;
          const dirY = avgNy / nLen;
          const bulkV = Math.min(1.35, 0.24 * Math.sqrt(contactCount) + overlapIntensity * 0.035);
          for (let i = 0; i < vertsA.length; i++) {
            vertsA[i].vx -= dirX * bulkV;
            vertsA[i].vy -= dirY * bulkV;
          }
          for (let j = 0; j < vertsB.length; j++) {
            vertsB[j].vx += dirX * bulkV;
            vertsB[j].vy += dirY * bulkV;
          }
        }
      }

      if (contactCount > 0 || Math.hypot(cDx, cDy) < 56) {
        contactPairs.push([a, b]);
      }
    }
  }

  return { contactPairs, squishedVerts };
}

/**
 * If an organism's living cell lattice breaks into 2+ disconnected components,
 * splits them into separate physical meshes sharing the same `colonyId` so they
 * drift independently and can either reconnect via morphogenesis or regenerate into separate organisms.
 * Energy is strictly conserved proportional to the cell count in each part (zero free energy created).
 */
export function splitDisconnectedComponents(
  world: WorldState,
  org: WorldOrganism,
  maxOrganismsCap = Infinity,
): void {
  if (org.mesh.cells.length === 0) return;
  const components = extractMeshComponents(org.mesh);
  if (components.length <= 1) return;

  const meshLevel = org.mesh.meshLevel;
  const primaryKeys = components[0];
  const primarySet = new Set(primaryKeys);
  const fullSimState = org.simState;
  const fullMesh = org.mesh;

  const totalCells = org.mesh.cells.length;
  const parentEnergy = Math.max(0, org.energyReserve);

  // Strictly conserve energy: host retains only the fraction proportional to its surviving cells
  org.energyReserve = parentEnergy * (primaryKeys.length / totalCells);

  // Secondary components split into independent fragments with the SAME colonyId
  for (let ci = 1; ci < components.length; ci++) {
    const compKeys = components[ci];
    if (compKeys.length === 0) continue;

    // Each part receives ONLY its proportional share of the parent's cells' energy (no free minimum floor)
    const fragEnergy = parentEnergy * (compKeys.length / totalCells);

    // Sub-3-cell debris or fragments beyond safety population cap dissolve back into local nutrients cleanly
    if (compKeys.length < 3 || world.organisms.length >= maxOrganismsCap || fragEnergy < 0.5) {
      let sx = 0;
      let sy = 0;
      let count = 0;
      for (let k = 0; k < compKeys.length; k++) {
        const c = fullMesh.cellMap.get(compKeys[k]);
        if (!c) continue;
        const v = fullMesh.vertices[c.vTL];
        if (v) {
          sx += v.x;
          sy += v.y;
          count++;
        }
      }
      if (count > 0) {
        depositChemical(world.foodField, sx / count, sy / count, Math.min(0.45, fragEnergy * 0.025 + 0.05), 2);
      }
      continue;
    }

    const compSet = new Set(compKeys);
    const fragMesh = extractSubMeshByKeys(fullMesh, compSet);
    const fragSim = cloneSimStateMasked(fullSimState, org.genome, meshLevel, compSet);

    // Subtle separation velocity away from primary body so broken segments part cleanly
    const dx = fragMesh.comX - fullMesh.comX;
    const dy = fragMesh.comY - fullMesh.comY;
    const dLen = Math.max(1, Math.hypot(dx, dy));
    for (const v of fragMesh.vertices) {
      v.vx += (dx / dLen) * 0.85;
      v.vy += (dy / dLen) * 0.85;
    }

    const fragId = world.nextOrgId++;
    const fragmentOrg: WorldOrganism = {
      id: fragId,
      colonyId: org.colonyId, // Same organism ID for morphogenesis neighbor reconnection!
      isFragment: true,
      fragmentBirthCellCount: fragMesh.cells.length,
      fragmentTicks: 0,
      name: org.name,
      presetId: org.presetId,
      generation: org.generation,
      parentIds: org.parentIds,
      genome: org.genome,
      simState: fragSim,
      params: { ...org.params },
      mesh: fragMesh,
      energyReserve: fragEnergy,
      lastMetabolicDrain: org.lastMetabolicDrain,
      steerBias: org.steerBias,
      sensorMagnitude: org.sensorMagnitude,
      neuralNet: cloneNeuralNetState(org.neuralNet),
      musclePhaseTime: org.musclePhaseTime,
      speed: org.speed,
      ageTicks: org.ageTicks,
      matingCooldown: 160,
      consumedFood: 0,
      rupturedCells: 0,
      damageFlash: 1.0,
    };

    world.organisms.push(fragmentOrg);
  }

  // Keep only primary component on host organism
  org.simState = cloneSimStateMasked(fullSimState, org.genome, meshLevel, primarySet);
  retainMeshCellsByKeys(org.mesh, primarySet);
}

/**
 * Checks whether two disconnected fragments with the same `colonyId` are touching
 * such that morphogenesis graph growth detects an existing neighbor cell of the correct type.
 */
function canFragmentsReconnectByMorphogenesis(
  orgA: WorldOrganism,
  orgB: WorldOrganism,
): boolean {
  if (orgA.mesh.meshLevel !== orgB.mesh.meshLevel) return false;
  const lvl: MipLevel = orgA.mesh.meshLevel;
  const compiledLayer = orgA.genome.layers[lvl];
  const simLayerA = orgA.simState.layers[lvl];
  const simLayerB = orgB.simState.layers[lvl];
  const vertsA = orgA.mesh.vertices;
  const vertsB = orgB.mesh.vertices;
  const touchDist2 = Math.pow(orgA.mesh.cellSize * 3.4, 2);

  for (let i = 0; i < orgA.mesh.cells.length; i++) {
    const cA = orgA.mesh.cells[i];
    const bCell = findTouchingMorphogenesisNeighbor(
      cA,
      vertsA,
      simLayerA.nodeId[cA.key],
      orgB,
      vertsB,
      simLayerB.nodeId,
      compiledLayer.tissueGrid,
      touchDist2,
    );
    if (bCell) return true;
  }
  return false;
}

function findTouchingMorphogenesisNeighbor(
  cA: SoftCell,
  vertsA: { x: number; y: number }[],
  nodeIdA: number,
  orgB: WorldOrganism,
  vertsB: { x: number; y: number }[],
  nodeIdGridB: Int32Array,
  expectedTissueGrid: Uint8Array,
  touchDist2: number,
): SoftCell | null {
  const dim = mipDim(cA.meshLevel);
  const cxA =
    (vertsA[cA.vTL].x + vertsA[cA.vTR].x + vertsA[cA.vBR].x + vertsA[cA.vBL].x) * 0.25;
  const cyA =
    (vertsA[cA.vTL].y + vertsA[cA.vTR].y + vertsA[cA.vBR].y + vertsA[cA.vBL].y) * 0.25;
  const nodeA = orgB.genome.nodeById.get(nodeIdA);

  for (let d = 0; d < 4; d++) {
    const nx = d === 2 ? cA.gx + 1 : d === 3 ? cA.gx - 1 : cA.gx;
    const ny = d === 0 ? cA.gy - 1 : d === 1 ? cA.gy + 1 : cA.gy;
    if (nx < 0 || nx >= dim || ny < 0 || ny >= dim) continue;

    const bKey = ny * dim + nx;
    const cB = orgB.mesh.cellMap.get(bKey);
    if (!cB) continue;

    // Verify existing cell matches expected morphogenesis tissue type or directive edge
    const expectedTissue = expectedTissueGrid[bKey] as TissueType;
    const tissueMatches = expectedTissue !== TissueType.EMPTY && cB.tissue === expectedTissue;
    const bNodeId = nodeIdGridB[bKey];
    const directiveLinks =
      nodeA !== undefined &&
      (nodeA.lateralNeighbors[0] === bNodeId ||
        nodeA.lateralNeighbors[1] === bNodeId ||
        nodeA.lateralNeighbors[2] === bNodeId ||
        nodeA.lateralNeighbors[3] === bNodeId);

    if (!tissueMatches && !directiveLinks) continue;

    const cxB =
      (vertsB[cB.vTL].x + vertsB[cB.vTR].x + vertsB[cB.vBR].x + vertsB[cB.vBL].x) * 0.25;
    const cyB =
      (vertsB[cB.vTL].y + vertsB[cB.vTR].y + vertsB[cB.vBR].y + vertsB[cB.vBL].y) * 0.25;
    const d2 = (cxA - cxB) * (cxA - cxB) + (cyA - cyB) * (cyA - cyB);
    if (d2 <= touchDist2) {
      return cB;
    }
  }
  return null;
}

export function stepWorldSimulation(
  world: WorldState,
  worldParams: WorldParams,
  defaultSimParams?: SimParams,
): void {
  world.worldTick += 1;

  // 1. Nutrient pellets emit food scent; replenish sparse arena food
  for (let i = world.pellets.length - 1; i >= 0; i--) {
    const p = world.pellets[i];
    depositChemical(world.foodField, p.x, p.y, 0.085 * p.amount, 3);
  }
  while (world.pellets.length < 10) {
    const px = 80 + Math.random() * (world.width - 160);
    const py = 80 + Math.random() * (world.height - 160);
    world.pellets.push({
      id: world.nextPelletId++,
      x: px,
      y: py,
      radius: 10,
      amount: 1.0,
    });
  }

  // 2. Diffuse chemical gradients (zero-allocation scratch buffer)
  diffuseField(world.foodField, worldParams.scentDiffusion, 0.992);
  diffuseField(world.scentField, worldParams.scentDiffusion * 1.15, 0.988);
  diffuseField(world.toxinField, worldParams.scentDiffusion * 0.9, 0.992);

  const sampler = {
    sampleAttractant: (x: number, y: number) =>
      sampleFieldBilinear(world.foodField, x, y) -
      1.4 * sampleFieldBilinear(world.toxinField, x, y) +
      0.1 * sampleFieldBilinear(world.scentField, x, y),
  };

  // 3. Step each organism's morphogenesis, feeding, physics, rupture & death
  const disconnectedQueue: WorldOrganism[] = [];

  for (let idx = world.organisms.length - 1; idx >= 0; idx--) {
    const org = world.organisms[idx];
    org.ageTicks += 1;
    if (org.matingCooldown > 0) org.matingCooldown -= 1;
    if (org.damageFlash > 0) org.damageFlash = Math.max(0, org.damageFlash - 0.12);
    org.musclePhaseTime += worldParams.muscleFrequency;

    const isFullyGrown =
      !org.isFragment &&
      org.simState.layers[0].activeCount >= org.genome.layers[0].activeCount &&
      org.simState.layers[2].activeCount >= org.genome.layers[2].activeCount;
    const growthInterval = Math.max(1, Math.round(5 / Math.max(0.25, worldParams.growthRate)));
    const effectiveInterval = isFullyGrown ? growthInterval * 4 : growthInterval;

    if (world.worldTick % effectiveInterval === 0) {
      stepSimulation(org.simState, org.genome, org.params);
      if (org.simState.lastDivisions > 0 || org.mesh.cells.length === 0) {
        syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
      }
    }

    // Track detached fragments: if they regenerate >=4 cells or survive independently, split into separate organisms
    if (org.isFragment) {
      org.fragmentTicks += 1;
      const grownSinceBreak = org.mesh.cells.length - org.fragmentBirthCellCount;
      if (grownSinceBreak >= 4 || (org.fragmentTicks >= 110 && org.mesh.cells.length >= 6)) {
        org.colonyId = org.id;
        org.isFragment = false;
        if (!org.name.endsWith('(Split)')) {
          org.name = `${org.name} (Split)`;
        }
        world.totalSplits += 1;
      }
    }

    // Feed on nearby food pellets
    for (let i = world.pellets.length - 1; i >= 0; i--) {
      const p = world.pellets[i];
      if (Math.hypot(org.mesh.comX - p.x, org.mesh.comY - p.y) < 42) {
        const bite = Math.min(p.amount, 0.34);
        p.amount -= bite;
        org.energyReserve = Math.min(100, org.energyReserve + bite * 38);
        org.consumedFood += bite;
        for (let k = 0; k < org.simState.nutrients.length; k += 5) {
          org.simState.nutrients[k] = Math.min(1.0, org.simState.nutrients[k] + 0.1);
        }
        if (p.amount <= 0.05) {
          world.pellets.splice(i, 1);
        }
      }
    }

    const localFood = sampleFieldBilinear(world.foodField, org.mesh.comX, org.mesh.comY);
    const localToxin = sampleFieldBilinear(world.toxinField, org.mesh.comX, org.mesh.comY);

    // Step BoxEye soft-body physics & AR-ResNet neural controller
    const phys = stepSoftBodyPhysics(
      org.mesh,
      sampler,
      world.width,
      world.height,
      worldParams,
      org.musclePhaseTime,
      org.steerBias,
      org.energyReserve / 100,
      org.neuralNet,
      localFood,
      localToxin,
    );
    org.steerBias = phys.steerBias;
    org.sensorMagnitude = phys.sensorMagnitude;
    org.speed = phys.speed;

    // Handle cells ruptured by squishing: break connections, damage energy & release micro-nutrients
    if (phys.rupturedKeys.length > 0) {
      const mLevel = org.mesh.meshLevel;
      const mDim = mipDim(mLevel);
      const verts = org.mesh.vertices;
      for (let r = 0; r < phys.rupturedKeys.length; r++) {
        const rKey = phys.rupturedKeys[r];
        const cell = org.mesh.cellMap.get(rKey);
        if (cell) {
          const cx =
            (verts[cell.vTL].x + verts[cell.vTR].x + verts[cell.vBR].x + verts[cell.vBL].x) *
            0.25;
          const cy =
            (verts[cell.vTL].y + verts[cell.vTR].y + verts[cell.vBR].y + verts[cell.vBL].y) *
            0.25;
          depositChemical(world.foodField, cx, cy, 0.14, 2);
          exciseSimCellBlock(
            org.simState,
            org.genome,
            mLevel,
            rKey % mDim,
            Math.floor(rKey / mDim),
            false,
          );
          org.rupturedCells += 1;
        }
      }
      refreshSimComposite(org.simState, org.genome);
      syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
      org.energyReserve = Math.max(0, org.energyReserve - phys.rupturedKeys.length * 1.4);
      org.damageFlash = 1.0;

      if (org.mesh.cells.length === 0) {
        world.deathsRuptured += 1;
        releaseDeathNutrients(world, org);
        world.organisms.splice(idx, 1);
        continue;
      }
      disconnectedQueue.push(org);
    }

    // Energy expenditure vs ambient intake
    const basalDrain = 0.014 * worldParams.metabolismRate;
    const totalDrain = basalDrain + phys.metabolicBurn + localToxin * 0.32;
    const intake = localFood * 0.075;
    org.lastMetabolicDrain = totalDrain;
    org.energyReserve = Math.min(100, org.energyReserve + intake - totalDrain);

    depositChemical(world.scentField, org.mesh.comX, org.mesh.comY, 0.055, 2);

    // Out of bounds death (no carcass pellets dropped outside tank to keep food inside arena)
    const outOfBounds =
      org.mesh.comX < -28 ||
      org.mesh.comX > world.width + 28 ||
      org.mesh.comY < -28 ||
      org.mesh.comY > world.height + 28;

    if (outOfBounds) {
      world.deathsExited += 1;
      world.organisms.splice(idx, 1);
      continue;
    }

    // Starvation death -> releases carcass nutrients
    if (org.energyReserve <= 0) {
      world.deathsStarved += 1;
      releaseDeathNutrients(world, org);
      world.organisms.splice(idx, 1);
      continue;
    }
  }

  // Split any newly disconnected damaged organisms into drifting same-colony pieces (capped safely against cascade storms)
  const splitCap = Math.max(worldParams.maxOrganisms + 12, 30);
  for (let i = 0; i < disconnectedQueue.length; i++) {
    splitDisconnectedComponents(world, disconnectedQueue[i], splitCap);
  }

  // 4. Spatial-hash collisions, strong bounce, squish damage, same-ID reconnection & auto-mating
  const { contactPairs, squishedVerts } = resolveOrganismCollisions(world);

  // Apply collision squish stress onto cells touching compressed boundary vertices
  if (squishedVerts.size > 0) {
    for (let i = 0; i < world.organisms.length; i++) {
      const org = world.organisms[i];
      const vSet = squishedVerts.get(org.id);
      if (!vSet) continue;
      for (let cIdx = 0; cIdx < org.mesh.cells.length; cIdx++) {
        const cell = org.mesh.cells[cIdx];
        if (
          vSet.has(cell.vTL) ||
          vSet.has(cell.vTR) ||
          vSet.has(cell.vBR) ||
          vSet.has(cell.vBL)
        ) {
          cell.crushStress += 0.28;
        }
      }
    }
  }

  // Attempt morphogenesis reconnection between touching same-colony fragments
  const removedIndices = new Set<number>();
  for (let p = 0; p < contactPairs.length; p++) {
    const [ia, ib] = contactPairs[p];
    if (removedIndices.has(ia) || removedIndices.has(ib)) continue;
    const orgA = world.organisms[ia];
    const orgB = world.organisms[ib];
    if (!orgA || !orgB) continue;

    if (orgA.colonyId === orgB.colonyId) {
      if (canFragmentsReconnectByMorphogenesis(orgA, orgB)) {
        const keepA = orgA.mesh.cells.length >= orgB.mesh.cells.length;
        const host = keepA ? orgA : orgB;
        const frag = keepA ? orgB : orgA;
        const dropIdx = keepA ? ib : ia;

        mergeSimStateFromFragment(host.simState, frag.simState, host.genome);
        mergeFragmentIntoMesh(host.mesh, frag.mesh);
        blendNeuralNetState(host.neuralNet, frag.neuralNet);
        host.energyReserve = Math.min(100, host.energyReserve + frag.energyReserve);
        host.consumedFood += frag.consumedFood;
        host.isFragment = false;
        world.totalReconnections += 1;
        removedIndices.add(dropIdx);
      }
    }
  }

  if (removedIndices.size > 0) {
    const sortedDrops = Array.from(removedIndices).sort((a, b) => b - a);
    for (let i = 0; i < sortedDrops.length; i++) {
      world.organisms.splice(sortedDrops[i], 1);
    }
  }

  // Auto-mating proximity crossover between distinct colonies
  if (worldParams.autoMating && world.organisms.length < worldParams.maxOrganisms) {
    for (let p = 0; p < contactPairs.length; p++) {
      const [ia, ib] = contactPairs[p];
      if (removedIndices.has(ia) || removedIndices.has(ib)) continue;
      if (world.organisms.length >= worldParams.maxOrganisms) break;
      const orgA = world.organisms[ia];
      const orgB = world.organisms[ib];
      if (!orgA || !orgB || orgA.colonyId === orgB.colonyId) continue;
      if (
        !orgA.isFragment &&
        !orgB.isFragment &&
        orgA.matingCooldown === 0 &&
        orgB.matingCooldown === 0 &&
        orgA.ageTicks >= 60 &&
        orgB.ageTicks >= 60 &&
        orgA.energyReserve >= 52 &&
        orgB.energyReserve >= 52 &&
        orgA.simState.iouPercent >= 70 &&
        orgB.simState.iouPercent >= 70
      ) {
        mateOrganisms(world, orgA, orgB, defaultSimParams ?? orgA.params);
        break;
      }
    }
  }
}

export function pokeWorldMesh(
  world: WorldState,
  wx: number,
  wy: number,
  dvx: number,
  dvy: number,
  radius = 36,
): void {
  const r2 = radius * radius;
  for (const org of world.organisms) {
    for (const v of org.mesh.vertices) {
      const dx = v.x - wx;
      const dy = v.y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < r2) {
        const w = 1 - Math.sqrt(d2) / radius;
        v.vx += dvx * w * 1.4;
        v.vy += dvy * w * 1.4;
        v.x += dvx * w * 0.35;
        v.y += dvy * w * 0.35;
      }
    }
  }
}

export function injureWorldOrganism(
  world: WorldState,
  wx: number,
  wy: number,
  worldRadius = 18,
): boolean {
  let anyHit = false;
  const splitTargets: WorldOrganism[] = [];

  for (let i = world.organisms.length - 1; i >= 0; i--) {
    const org = world.organisms[i];
    if (Math.hypot(org.mesh.comX - wx, org.mesh.comY - wy) > org.mesh.boundRadius + worldRadius) {
      continue;
    }
    const verts = org.mesh.vertices;
    let orgHit = false;
    for (const cell of org.mesh.cells) {
      const cx =
        (verts[cell.vTL].x + verts[cell.vTR].x + verts[cell.vBR].x + verts[cell.vBL].x) * 0.25;
      const cy =
        (verts[cell.vTL].y + verts[cell.vTR].y + verts[cell.vBR].y + verts[cell.vBL].y) * 0.25;
      if (Math.hypot(cx - wx, cy - wy) <= worldRadius) {
        const stride = 1 << cell.meshLevel;
        const px = cell.gx * stride + stride * 0.5;
        const py = cell.gy * stride + stride * 0.5;
        injureSimulation(org.simState, org.genome, px, py, stride * 1.15, false);
        orgHit = true;
        org.rupturedCells += 1;
        depositChemical(world.foodField, cx, cy, 0.14, 2);
      }
    }
    if (orgHit) {
      anyHit = true;
      org.damageFlash = 1.0;
      refreshSimComposite(org.simState, org.genome);
      syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
      if (org.mesh.cells.length === 0) {
        world.deathsRuptured += 1;
        releaseDeathNutrients(world, org);
        world.organisms.splice(i, 1);
      } else {
        splitTargets.push(org);
      }
    }
  }

  for (const org of splitTargets) {
    splitDisconnectedComponents(world, org);
  }
  return anyHit;
}
