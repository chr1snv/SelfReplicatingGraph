import {
  BASE_DIM,
  BattleState,
  BiomeId,
  CompiledGenome,
  SimParams,
  WorldFaction,
  WorldOrganism,
  WorldParams,
  WorldState,
  mipDim,
} from '../types/morphogenesis';
import { getBiomeDef } from './biomes';
import { compileBlueprintToGenome } from './compiler';
import { crossoverGenomes } from './genetics';
import {
  createNeuralNetState,
  crossoverNeuralNetStates,
} from './neuralNet';
import { ORGANISM_PRESETS } from './presets';
import {
  createSimState,
  exciseSimCellBlock,
  injureSimulation,
  refreshSimComposite,
  stepSimulation,
} from './simulator';
import {
  createEmptySoftMesh,
  extractMeshComponents,
  retainMeshCellsByKeys,
  stepSoftBodyPhysics,
  syncOrganismMeshFromSimState,
} from './softBodyPhysics';
import {
  CHEM_COLS,
  CHEM_ROWS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  clearChemicalSpot,
  computeHostileProximity,
  createPellet,
  depositChemical,
  diffuseField,
  generateBiomeSunZones,
  sampleAttractantForOrganism,
  sampleFieldBilinear,
  sampleSunlightAt,
  updateOrganismMood,
} from './worldChemicals';
import {
  CONTACT_PAIR_A,
  CONTACT_PAIR_B,
  CONTACT_PAIR_COUNT,
  MAX_WORLD_ORGS_SCRATCH,
  REMOVED_FLAGS,
  applyPostCollisionEffects,
  releaseDeathNutrients,
  resolveOrganismCollisions,
  splitDisconnectedComponents,
} from './worldCollisions';
import { generateOffspringNickname, generateSplitNickname } from './worldNaming';

export {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  clearChemicalSpot,
  depositChemical,
  sampleAttractantForOrganism,
  sampleFieldBilinear,
  sampleSunlightAt,
  splitDisconnectedComponents,
};

export const DEFAULT_WORLD_PARAMS: WorldParams = {
  fluidDrag: 0.04,
  internalPressure: 1.25,
  muscleStrength: 0.28,
  muscleFrequency: 0.2,
  flagellaThrust: 2.5,
  gradientSensitivity: 2.2,
  scentDiffusion: 0.24,
  growthRate: 1.25,
  metabolismRate: 1.0,
  sunlightLevel: 1.0,
  autoMating: true,
  maxOrganisms: 32,
};

const EFFECTIVE_WORLD_PARAMS: WorldParams = { ...DEFAULT_WORLD_PARAMS };
const DISCONNECTED_QUEUE: WorldOrganism[] = [];

let ACTIVE_SAMPLER_WORLD: WorldState | null = null;
let ACTIVE_SAMPLER_ORG: WorldOrganism | null = null;
const SHARED_WORLD_SAMPLER = {
  sampleAttractant: (sx: number, sy: number): number =>
    sampleAttractantForOrganism(ACTIVE_SAMPLER_WORLD!, ACTIVE_SAMPLER_ORG!, sx, sy),
};

function computeScentSignature(presetId: string, faction: WorldFaction): number {
  let hash = 0;
  for (let i = 0; i < presetId.length; i++) {
    hash = (hash * 31 + presetId.charCodeAt(i)) % 997;
  }
  const base = (hash % 100) / 100;
  if (faction === 'player') return base * 0.45;
  if (faction === 'ai') return 0.55 + base * 0.45;
  return base;
}

function createInitialBattleState(enabled: boolean): BattleState {
  return {
    enabled,
    barrierActive: enabled,
    barrierX: WORLD_WIDTH * 0.5,
    barrierHealth: 100,
    barrierMaxHealth: 100,
    breachThreshold: 10000,
    playerStrength: 0,
    aiStrength: 0,
    playerCount: 0,
    aiCount: 0,
    winner: null,
    aiNextActionTick: 45,
  };
}

/**
 * Initializes a populated 1600x1000 WorldState for the selected aquatic biome
 * and optional Player vs AI containment battle arena.
 */
export function createInitialWorld(
  simParams: SimParams,
  biomeId: BiomeId = 'pond',
  battleEnabled = false,
): WorldState {
  const biome = getBiomeDef(biomeId);
  const world: WorldState = {
    biomeId,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    chemCols: CHEM_COLS,
    chemRows: CHEM_ROWS,
    foodField: new Float32Array(CHEM_COLS * CHEM_ROWS),
    scentField: new Float32Array(CHEM_COLS * CHEM_ROWS),
    moodField: new Float32Array(CHEM_COLS * CHEM_ROWS),
    toxinField: new Float32Array(CHEM_COLS * CHEM_ROWS),
    pellets: [],
    sunZones: generateBiomeSunZones(biomeId),
    hearts: [],
    soundEvents: [],
    organisms: [],
    battle: createInitialBattleState(battleEnabled),
    nextOrgId: 1,
    nextPelletId: 1,
    nextHeartId: 1,
    worldTick: 0,
    totalBirths: 0,
    deathsStarved: 0,
    deathsExited: 0,
    deathsRuptured: 0,
    totalReconnections: 0,
    totalSplits: 0,
  };

  if (battleEnabled) {
    const halfFoods: Array<[number, number, boolean]> = [
      [210, 220, true],
      [480, 260, true],
      [310, 500, true],
      [560, 710, false],
      [250, 790, true],
      [630, 390, false],
    ];
    for (const [lx, ly, photo] of halfFoods) {
      const rx = WORLD_WIDTH - lx;
      world.pellets.push(createPellet(world, lx, ly, photo, 1.0), createPellet(world, rx, ly, photo, 1.0));
      depositChemical(world.foodField, lx, ly, 0.85, 5);
      depositChemical(world.foodField, rx, ly, 0.85, 5);
    }

    const battleSpawns = [
      { presetIdx: 0, y: 260 },
      { presetIdx: 1, y: 510 },
      { presetIdx: 3, y: 760 },
    ];
    for (let i = 0; i < battleSpawns.length; i++) {
      const sp = battleSpawns[i];
      const preset = ORGANISM_PRESETS[sp.presetIdx % ORGANISM_PRESETS.length];
      spawnOrganismInWorld(
        world,
        compileBlueprintToGenome(preset.generate(BASE_DIM)),
        preset.name,
        preset.id,
        simParams,
        290 + i * 95,
        sp.y,
        0.15,
        10,
        1,
        null,
        undefined,
        'player',
      );

      const aiPreset = ORGANISM_PRESETS[(sp.presetIdx + 1) % ORGANISM_PRESETS.length];
      spawnOrganismInWorld(
        world,
        compileBlueprintToGenome(aiPreset.generate(BASE_DIM)),
        aiPreset.name,
        aiPreset.id,
        simParams,
        WORLD_WIDTH - (290 + i * 95),
        sp.y,
        Math.PI - 0.15,
        10,
        1,
        null,
        undefined,
        'ai',
      );
    }
  } else {
    const totalFood = biome.photosynthTargetCount + biome.detritusTargetCount;
    for (let i = 0; i < totalFood; i++) {
      const isPhoto = i < biome.photosynthTargetCount;
      let px = 140 + Math.random() * (WORLD_WIDTH - 280);
      let py = 120 + Math.random() * (WORLD_HEIGHT - 240);
      if (isPhoto && world.sunZones.length > 0) {
        const sz = world.sunZones[i % world.sunZones.length];
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.random() * sz.radius * 0.72;
        px = Math.max(100, Math.min(WORLD_WIDTH - 100, sz.x + Math.cos(ang) * rad));
        py = Math.max(90, Math.min(WORLD_HEIGHT - 90, sz.y + Math.sin(ang) * rad));
      }
      world.pellets.push(createPellet(world, px, py, isPhoto, 1.0));
      depositChemical(world.foodField, px, py, 0.85, 6);
    }

    if (biomeId === 'cave') {
      depositChemical(world.toxinField, 460, 310, 0.9, 4);
      depositChemical(world.toxinField, 1140, 690, 0.9, 4);
    }

    const spawns = [
      { presetIdx: 0, x: 310, y: 340, heading: -0.2 },
      { presetIdx: 1, x: 1260, y: 330, heading: 2.85 },
      { presetIdx: 2, x: 790, y: 260, heading: 1.45 },
      { presetIdx: 3, x: 540, y: 690, heading: -0.95 },
      { presetIdx: 4, x: 1050, y: 680, heading: -2.2 },
      { presetIdx: 0, x: 820, y: 540, heading: 0.4 },
    ];
    for (const sp of spawns) {
      const preset = ORGANISM_PRESETS[sp.presetIdx % ORGANISM_PRESETS.length];
      spawnOrganismInWorld(
        world,
        compileBlueprintToGenome(preset.generate(BASE_DIM)),
        preset.name,
        preset.id,
        simParams,
        sp.x,
        sp.y,
        sp.heading,
        10,
      );
    }
  }

  for (let i = 0; i < 6; i++) {
    diffuseField(world.foodField, 0.28, 0.992);
  }
  return world;
}

/**
 * Spawns a single connected organism directly into `world` at `(x, y)`.
 */
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
  faction: WorldFaction = world.battle.enabled ? 'player' : 'neutral',
  initialEnergy = 100,
): WorldOrganism {
  let clampedX = Math.max(45, Math.min(world.width - 45, x));
  const clampedY = Math.max(45, Math.min(world.height - 45, y));
  if (world.battle.enabled && world.battle.barrierActive) {
    if (faction === 'player') clampedX = Math.min(world.battle.barrierX - 36, clampedX);
    else if (faction === 'ai') clampedX = Math.max(world.battle.barrierX + 36, clampedX);
  }

  const simState = createSimState(genome, { ...simParams, growthMode: 'mipmap' });
  for (let t = 0; t < initialGrowthTicks; t++) {
    stepSimulation(simState, genome, { ...simParams, growthMode: 'mipmap' });
  }

  const mesh = createEmptySoftMesh(clampedX, clampedY, headingAngle);
  syncOrganismMeshFromSimState(mesh, simState, genome);
  const spawnComps = extractMeshComponents(mesh);
  if (spawnComps.length > 1) {
    retainMeshCellsByKeys(mesh, new Set(spawnComps[0]));
  }

  const id = world.nextOrgId++;
  const org: WorldOrganism = {
    id,
    colonyId: id,
    faction,
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
    energyReserve: initialEnergy,
    wasteLevel: 0,
    lastMetabolicDrain: 0,
    steerBias: 0,
    sensorMagnitude: 0,
    neuralNet: inheritedNeuralNet,
    mood: 'foraging',
    scentSignature: computeScentSignature(presetId, faction),
    ignoredPelletUntil: new Map(),
    combatScore: 0,
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

export interface SpawnFromFoodResult {
  organism: WorldOrganism | null;
  reason?: 'no_food' | 'barrier_broken';
  consumedFood: number;
}

/**
 * Consumes an existing FoodPellet on the allowed barrier side and spawns the organism
 * atop that pellet so spawning conserves world energy.
 */
export function spawnOrganismFromFood(
  world: WorldState,
  genome: CompiledGenome,
  name: string,
  presetId: string,
  simParams: SimParams,
  faction: WorldFaction = world.battle.enabled ? 'player' : 'neutral',
  preferredX?: number,
  preferredY?: number,
  initialGrowthTicks = 2,
): SpawnFromFoodResult {
  if (world.battle.enabled && !world.battle.barrierActive) {
    return { organism: null, reason: 'barrier_broken', consumedFood: 0 };
  }

  const bx = world.battle.barrierX;
  const sideGuard = 24;
  const hasPreferred = preferredX !== undefined && preferredY !== undefined;
  let targetX = preferredX ?? world.width * 0.5;
  const targetY = preferredY ?? world.height * 0.5;
  if (hasPreferred && world.battle.enabled) {
    if (faction === 'player') targetX = Math.min(bx - sideGuard, Math.max(45, targetX));
    else if (faction === 'ai') targetX = Math.max(bx + sideGuard, Math.min(world.width - 45, targetX));
  }

  let chosenIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < world.pellets.length; i++) {
    const p = world.pellets[i];
    if (p.amount <= 0.12) continue;
    if (world.battle.enabled) {
      if (faction === 'player' && p.x > bx - sideGuard) continue;
      if (faction === 'ai' && p.x < bx + sideGuard) continue;
    }
    const score = hasPreferred ? -Math.hypot(p.x - targetX, p.y - targetY) + p.amount * 35 : p.amount;
    if (score > bestScore) {
      bestScore = score;
      chosenIdx = i;
    }
  }

  if (chosenIdx === -1) {
    return { organism: null, reason: 'no_food', consumedFood: 0 };
  }

  const pellet = world.pellets[chosenIdx];
  const consumed = Math.min(pellet.amount, 0.85);
  const spawnX = pellet.x;
  const spawnY = pellet.y;
  pellet.amount -= consumed;
  if (pellet.amount <= 0.05) {
    clearChemicalSpot(world.foodField, pellet.x, pellet.y, 4);
    world.pellets.splice(chosenIdx, 1);
  }

  const initialEnergy = Math.max(55, Math.min(100, Math.round(consumed * 118)));
  const heading =
    faction === 'ai'
      ? Math.PI + (Math.random() - 0.5) * 0.6
      : faction === 'player'
        ? (Math.random() - 0.5) * 0.6
        : Math.random() * Math.PI * 2 - Math.PI;

  const org = spawnOrganismInWorld(
    world,
    genome,
    name,
    presetId,
    simParams,
    spawnX,
    spawnY,
    heading,
    initialGrowthTicks,
    1,
    null,
    undefined,
    faction,
    initialEnergy,
  );
  return { organism: org, consumedFood: consumed };
}

/**
 * Queues mating pixel-heart particles (animated on GPU Transform Feedback + CPU fallback).
 */
export function spawnMatingHearts(world: WorldState, x: number, y: number, count = 3): void {
  for (let i = 0; i < count; i++) {
    world.hearts.push({
      id: world.nextHeartId++,
      x: x + (Math.random() - 0.5) * 26,
      y: y + (Math.random() - 0.5) * 16,
      vx: (Math.random() - 0.5) * 0.55,
      vy: -0.95 - Math.random() * 0.65,
      age: 0,
      maxAge: 52 + Math.floor(Math.random() * 16),
      scale: 0.9 + Math.random() * 0.45,
    });
  }
}

/**
 * Crosses over two organisms' blueprints & AR-ResNet neural weights to birth an offspring
 * assigned a short, non-concatenated biological nickname.
 */
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
  const midX = (parentA.mesh.comX + parentB.mesh.comX) * 0.5;
  const midY = (parentA.mesh.comY + parentB.mesh.comY) * 0.5;

  let clampedX = Math.max(55, Math.min(world.width - 55, midX + (-dyp / pLen) * perpSign * 60));
  const clampedY = Math.max(55, Math.min(world.height - 55, midY + (dxp / pLen) * perpSign * 60));

  let faction: WorldFaction = 'neutral';
  if (world.battle.enabled && parentA.faction === parentB.faction) {
    faction = parentA.faction;
  }
  if (world.battle.enabled && world.battle.barrierActive) {
    if (faction === 'player') clampedX = Math.min(world.battle.barrierX - 42, clampedX);
    else if (faction === 'ai') clampedX = Math.max(world.battle.barrierX + 42, clampedX);
  }

  const gen = Math.max(parentA.generation, parentB.generation) + 1;
  const childName = generateOffspringNickname(world, parentA, parentB, gen);

  parentA.energyReserve = Math.max(14, parentA.energyReserve - 20);
  parentB.energyReserve = Math.max(14, parentB.energyReserve - 20);
  parentA.matingCooldown = 260;
  parentB.matingCooldown = 260;

  world.totalBirths += 1;
  spawnMatingHearts(world, midX, midY, 4);
  world.soundEvents.push({ type: 'mate', intensity: 1 });

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
    crossoverNeuralNetStates(parentA.neuralNet, parentB.neuralNet),
    faction,
  );
}

function stepAiBattleCommander(
  world: WorldState,
  worldParams: WorldParams,
  simParams: SimParams,
): void {
  const battle = world.battle;
  if (!battle.enabled || battle.winner !== null) return;
  if (world.worldTick < battle.aiNextActionTick) return;
  battle.aiNextActionTick = world.worldTick + 65;

  const aiOrgs = world.organisms.filter((o) => o.faction === 'ai');
  const maxAiPop = Math.min(18, Math.max(5, Math.floor(worldParams.maxOrganisms * 0.52)));

  if (battle.barrierActive && aiOrgs.length < maxAiPop) {
    const preset = ORGANISM_PRESETS[Math.floor(Math.random() * ORGANISM_PRESETS.length)];
    spawnOrganismFromFood(
      world,
      compileBlueprintToGenome(preset.generate(BASE_DIM)),
      `AI ${preset.name.split(' ')[0]}`,
      preset.id,
      simParams,
      'ai',
      undefined,
      undefined,
      3,
    );
  } else if (aiOrgs.length >= 2) {
    const ready = aiOrgs.filter((o) => o.energyReserve >= 52 && o.matingCooldown === 0 && !o.isFragment);
    if (ready.length >= 2 && aiOrgs.length < worldParams.maxOrganisms) {
      mateOrganisms(world, ready[0], ready[1], simParams);
    }
  }
}

function replenishFoodAndDiffuse(world: WorldState, worldParams: WorldParams): void {
  const biome = getBiomeDef(world.biomeId);
  const targetTotalPellets =
    world.battle.enabled ? 14 : biome.photosynthTargetCount + biome.detritusTargetCount;

  for (let i = world.pellets.length - 1; i >= 0; i--) {
    const p = world.pellets[i];
    if (p.isPhotosynthetic) {
      const sun = sampleSunlightAt(world, worldParams, p.x, p.y);
      if (sun > 0.15 && p.amount < p.maxAmount) {
        p.amount = Math.min(p.maxAmount, p.amount + sun * 0.0028);
      }
      p.radius = 7.5 + p.amount * 3.8;
    }
    depositChemical(world.foodField, p.x, p.y, 0.11 * p.amount, 3);
  }

  let attempts = 0;
  const photoRatio =
    biome.photosynthTargetCount / Math.max(1, biome.photosynthTargetCount + biome.detritusTargetCount);
  while (world.pellets.length < targetTotalPellets && attempts < 10) {
    attempts++;
    const isPhoto = Math.random() < photoRatio;
    let px = 90 + Math.random() * (world.width - 180);
    let py = 90 + Math.random() * (world.height - 180);

    if (world.battle.enabled && world.battle.barrierActive) {
      const leftSide = world.pellets.length % 2 === 0;
      px = leftSide
        ? 90 + Math.random() * (world.battle.barrierX - 160)
        : world.battle.barrierX + 70 + Math.random() * (world.width - world.battle.barrierX - 160);
    } else if (isPhoto && world.sunZones.length > 0) {
      const sz = world.sunZones[Math.floor(Math.random() * world.sunZones.length)];
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * sz.radius * 0.72;
      px = Math.max(85, Math.min(world.width - 85, sz.x + Math.cos(ang) * rad));
      py = Math.max(85, Math.min(world.height - 85, sz.y + Math.sin(ang) * rad));
    }
    world.pellets.push(createPellet(world, px, py, isPhoto, isPhoto ? 0.65 : 1.0));
  }

  diffuseField(world.foodField, Math.min(0.45, worldParams.scentDiffusion * 1.35), 0.958);
  diffuseField(world.toxinField, worldParams.scentDiffusion * 0.9, 0.985);
  // Stagger secondary scent/mood field diffusion across odd/even ticks to cut CPU work while GPU smooths visually
  if ((world.worldTick & 1) === 0) {
    diffuseField(world.scentField, Math.min(0.45, worldParams.scentDiffusion * 1.15), 0.972);
  } else {
    diffuseField(world.moodField, Math.min(0.45, worldParams.scentDiffusion), 0.965);
  }
}

/**
 * Advances the entire aquatic ecosystem simulation by one tick:
 * 1. Replenishes photosynthetic/detritus pellets & chemical plumes
 * 2. Steps morphogenesis, grazing, soft-body physics, metabolism, and excretion per organism
 * 3. Updates Battle Mode barrier durability & victory resolution
 * 4. Resolves spatial-hashed collisions, aggressive spike excisions, fragment reconnections, and auto-mating
 */
export function stepWorldSimulation(
  world: WorldState,
  worldParams: WorldParams,
  defaultSimParams?: SimParams,
): void {
  world.worldTick += 1;
  const biome = getBiomeDef(world.biomeId);

  replenishFoodAndDiffuse(world, worldParams);

  // Advance light heart bookkeeping (GPU Transform Feedback animates all visual heart kinematics)
  for (let i = world.hearts.length - 1; i >= 0; i--) {
    const h = world.hearts[i];
    h.age += 1;
    h.x += h.vx + Math.sin(h.age * 0.22) * 0.25;
    h.y += h.vy;
    h.vy *= 0.985;
    if (h.age >= h.maxAge) world.hearts.splice(i, 1);
  }

  EFFECTIVE_WORLD_PARAMS.fluidDrag = Math.min(0.28, worldParams.fluidDrag * biome.fluidDragMod);
  EFFECTIVE_WORLD_PARAMS.internalPressure = worldParams.internalPressure;
  EFFECTIVE_WORLD_PARAMS.muscleStrength = worldParams.muscleStrength;
  EFFECTIVE_WORLD_PARAMS.muscleFrequency = worldParams.muscleFrequency;
  EFFECTIVE_WORLD_PARAMS.flagellaThrust = worldParams.flagellaThrust;
  EFFECTIVE_WORLD_PARAMS.gradientSensitivity = worldParams.gradientSensitivity;
  EFFECTIVE_WORLD_PARAMS.scentDiffusion = worldParams.scentDiffusion;
  EFFECTIVE_WORLD_PARAMS.growthRate = worldParams.growthRate;
  EFFECTIVE_WORLD_PARAMS.metabolismRate = worldParams.metabolismRate * biome.metabolismMod;
  EFFECTIVE_WORLD_PARAMS.sunlightLevel = worldParams.sunlightLevel;
  EFFECTIVE_WORLD_PARAMS.autoMating = worldParams.autoMating;
  EFFECTIVE_WORLD_PARAMS.maxOrganisms = worldParams.maxOrganisms;

  if (world.battle.enabled) {
    stepAiBattleCommander(
      world,
      worldParams,
      defaultSimParams ?? {
        growthMode: 'mipmap',
        subdivisionDelay: 4,
        lateralDelay: 1,
        divisionCost: 0.28,
        nutrientDensity: 0.85,
        vascularBoost: 1.2,
        stagedWaves: true,
        legacyNodeCap: 0,
      },
    );
  }

  DISCONNECTED_QUEUE.length = 0;
  let playerStrength = 0;
  let aiStrength = 0;
  let playerCount = 0;
  let aiCount = 0;

  for (let idx = world.organisms.length - 1; idx >= 0; idx--) {
    const org = world.organisms[idx];
    org.ageTicks += 1;
    if (org.matingCooldown > 0) org.matingCooldown -= 1;
    if (org.damageFlash > 0) org.damageFlash = Math.max(0, org.damageFlash - 0.12);
    org.musclePhaseTime += worldParams.muscleFrequency;
    org.mood = updateOrganismMood(org);

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
        const comps = extractMeshComponents(org.mesh);
        if (comps.length > 1) {
          retainMeshCellsByKeys(org.mesh, new Set(comps[0]));
        }
      }
    }

    if (org.isFragment) {
      org.fragmentTicks += 1;
      const grownSinceBreak = org.mesh.cells.length - org.fragmentBirthCellCount;
      if (grownSinceBreak >= 4 || (org.fragmentTicks >= 110 && org.mesh.cells.length >= 6)) {
        org.colonyId = org.id;
        org.isFragment = false;
        org.name = generateSplitNickname(world, org.name);
        world.totalSplits += 1;
        world.soundEvents.push({ type: 'split', intensity: 1 });
      }
    }

    // Grazing on nearby pellets with Digestive efficiency gain
    let eatenThisTick = 0;
    const digestGain = 52 + 32 * org.mesh.digestiveEfficiency;
    for (let i = world.pellets.length - 1; i >= 0; i--) {
      const p = world.pellets[i];
      if (Math.hypot(org.mesh.comX - p.x, org.mesh.comY - p.y) < 42) {
        const bite = Math.min(p.amount, 0.36);
        p.amount -= bite;
        eatenThisTick += bite;
        org.energyReserve = Math.min(100, org.energyReserve + bite * digestGain);
        org.consumedFood += bite;
        if (org.energyReserve >= 92) {
          org.ignoredPelletUntil.set(p.id, world.worldTick + 45);
        }
        world.soundEvents.push({ type: 'eat', intensity: bite });
        for (let k = 0; k < org.simState.nutrients.length; k += 5) {
          org.simState.nutrients[k] = Math.min(1.0, org.simState.nutrients[k] + 0.12);
        }
        if (p.amount <= 0.05) {
          clearChemicalSpot(world.foodField, p.x, p.y, 4);
          world.pellets.splice(i, 1);
        }
      }
    }

    const localFood = sampleFieldBilinear(world.foodField, org.mesh.comX, org.mesh.comY);
    const localToxin = sampleFieldBilinear(world.toxinField, org.mesh.comX, org.mesh.comY);
    const hostileProx = computeHostileProximity(world, org);

    ACTIVE_SAMPLER_WORLD = world;
    ACTIVE_SAMPLER_ORG = org;
    const phys = stepSoftBodyPhysics(
      org.mesh,
      SHARED_WORLD_SAMPLER,
      world.width,
      world.height,
      EFFECTIVE_WORLD_PARAMS,
      org.musclePhaseTime,
      org.steerBias,
      org.energyReserve / 100,
      org.neuralNet,
      localFood,
      localToxin,
      hostileProx,
    );
    org.steerBias = phys.steerBias;
    org.sensorMagnitude = phys.sensorMagnitude;
    org.speed = phys.speed;

    if (biome.currentX !== 0 || biome.currentY !== 0) {
      for (let vi = 0; vi < org.mesh.vertices.length; vi++) {
        org.mesh.vertices[vi].vx += biome.currentX;
        org.mesh.vertices[vi].vy += biome.currentY;
      }
    }

    if (world.battle.enabled && world.battle.barrierActive) {
      const bx = world.battle.barrierX;
      const margin = 14;
      for (let vi = 0; vi < org.mesh.vertices.length; vi++) {
        const v = org.mesh.vertices[vi];
        if (org.faction === 'player' && v.x > bx - margin) {
          v.x = bx - margin;
          v.vx = -Math.abs(v.vx) * 0.7 - 0.12;
        } else if (org.faction === 'ai' && v.x < bx + margin) {
          v.x = bx + margin;
          v.vx = Math.abs(v.vx) * 0.7 + 0.12;
        }
      }
    }

    if (phys.rupturedKeys.length > 0) {
      const mLevel = org.mesh.meshLevel;
      const mDim = mipDim(mLevel);
      const verts = org.mesh.vertices;
      for (let r = 0; r < phys.rupturedKeys.length; r++) {
        const rKey = phys.rupturedKeys[r];
        const cell = org.mesh.cellMap.get(rKey);
        if (cell) {
          const cx = (verts[cell.vTL].x + verts[cell.vTR].x + verts[cell.vBR].x + verts[cell.vBL].x) * 0.25;
          const cy = (verts[cell.vTL].y + verts[cell.vTR].y + verts[cell.vBR].y + verts[cell.vBL].y) * 0.25;
          depositChemical(world.foodField, cx, cy, 0.12, 2);
          exciseSimCellBlock(org.simState, org.genome, mLevel, rKey % mDim, Math.floor(rKey / mDim), false);
          org.rupturedCells += 1;
        }
      }
      refreshSimComposite(org.simState, org.genome);
      syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
      org.energyReserve = Math.max(0, org.energyReserve - phys.rupturedKeys.length * 1.4);
      org.damageFlash = 1.0;
      world.soundEvents.push({ type: 'rupture', intensity: 1 });

      if (org.mesh.cells.length === 0) {
        world.deathsRuptured += 1;
        releaseDeathNutrients(world, org, createPellet);
        world.organisms.splice(idx, 1);
        continue;
      }
      DISCONNECTED_QUEUE.push(org);
    }

    const solarTrickle = sampleSunlightAt(world, worldParams, org.mesh.comX, org.mesh.comY) * 0.014;
    org.wasteLevel = Math.min(100, org.wasteLevel + phys.metabolicBurn * 3.2 + eatenThisTick * 1.8);
    org.wasteLevel = Math.max(0, org.wasteLevel - (0.045 + org.mesh.excretoryEfficiency * 0.36));

    const toxinMitigation = 1 - Math.min(0.65, org.mesh.excretoryEfficiency * 0.48);
    const uremicDrain = org.wasteLevel > 72 ? (org.wasteLevel - 72) * 0.004 : 0;
    const basalDrain = 0.0032 * EFFECTIVE_WORLD_PARAMS.metabolismRate;
    const totalDrain = basalDrain + phys.metabolicBurn + localToxin * 0.32 * toxinMitigation + uremicDrain;
    const intake = localFood * 0.125 * (0.72 + 0.42 * org.mesh.digestiveEfficiency) + solarTrickle;
    org.lastMetabolicDrain = totalDrain;
    org.energyReserve = Math.min(100, org.energyReserve + intake - totalDrain);

    const moodVal = org.mood === 'amorous' ? 0.24 : org.mood === 'threatened' ? -0.28 : 0.04;
    depositChemical(world.scentField, org.mesh.comX, org.mesh.comY, 0.065, 2);
    depositChemical(world.moodField, org.mesh.comX, org.mesh.comY, moodVal, 2);

    if (
      org.mesh.comX < -28 ||
      org.mesh.comX > world.width + 28 ||
      org.mesh.comY < -28 ||
      org.mesh.comY > world.height + 28
    ) {
      world.deathsExited += 1;
      world.organisms.splice(idx, 1);
      continue;
    }

    if (org.energyReserve <= 0) {
      world.deathsStarved += 1;
      releaseDeathNutrients(world, org, createPellet);
      world.organisms.splice(idx, 1);
      continue;
    }

    const orgStrength =
      org.mesh.cells.length * 4.5 + org.energyReserve * 1.8 + org.generation * 35 + org.combatScore * 20;
    if (org.faction === 'player') {
      playerStrength += orgStrength;
      playerCount++;
    } else if (org.faction === 'ai') {
      aiStrength += orgStrength;
      aiCount++;
    }
  }

  if (world.battle.enabled) {
    world.battle.playerStrength = playerStrength;
    world.battle.aiStrength = aiStrength;
    world.battle.playerCount = playerCount;
    world.battle.aiCount = aiCount;

    if (world.battle.barrierActive) {
      if (
        Math.max(playerStrength, aiStrength) >= world.battle.breachThreshold ||
        Math.max(playerCount, aiCount) >= 15
      ) {
        world.battle.barrierHealth = Math.max(0, world.battle.barrierHealth - 4);
      }
      if (world.battle.barrierHealth <= 0) {
        world.battle.barrierActive = false;
        world.soundEvents.push({ type: 'breach', intensity: 1 });
      }
    } else if (world.battle.winner === null) {
      if (playerCount > 0 && aiCount === 0) {
        world.battle.winner = 'player';
        world.soundEvents.push({ type: 'victory', intensity: 1 });
      } else if (aiCount > 0 && playerCount === 0) {
        world.battle.winner = 'ai';
        world.soundEvents.push({ type: 'victory', intensity: 1 });
      }
    }
  }

  const splitCap = Math.max(worldParams.maxOrganisms + 12, 34);
  for (let i = 0; i < DISCONNECTED_QUEUE.length; i++) {
    splitDisconnectedComponents(world, DISCONNECTED_QUEUE[i], splitCap);
  }

  resolveOrganismCollisions(world);

  const orgCap = Math.min(world.organisms.length, MAX_WORLD_ORGS_SCRATCH);
  const anyRemoved = applyPostCollisionEffects(world, orgCap, splitCap, createPellet);

  if (!anyRemoved && worldParams.autoMating && world.organisms.length < worldParams.maxOrganisms) {
    for (let p = 0; p < CONTACT_PAIR_COUNT; p++) {
      const ia = CONTACT_PAIR_A[p];
      const ib = CONTACT_PAIR_B[p];
      if (ia >= orgCap || ib >= orgCap || REMOVED_FLAGS[ia] || REMOVED_FLAGS[ib]) continue;
      if (world.organisms.length >= worldParams.maxOrganisms) break;
      const orgA = world.organisms[ia];
      const orgB = world.organisms[ib];
      if (!orgA || !orgB || orgA.colonyId === orgB.colonyId) continue;
      if (world.battle.enabled && orgA.faction !== orgB.faction) continue;
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

/**
 * Applies an interactive fluid impulse poke to mesh vertices within `radius`.
 */
export function pokeWorldMesh(
  world: WorldState,
  wx: number,
  wy: number,
  dvx: number,
  dvy: number,
  radius = 36,
  playerOnly = false,
): void {
  const r2 = radius * radius;
  for (const org of world.organisms) {
    if (playerOnly && org.faction !== 'player') continue;
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

/**
 * Performs localized interactive Scalpel excision on world organisms near `(wx, wy)`.
 */
export function injureWorldOrganism(
  world: WorldState,
  wx: number,
  wy: number,
  worldRadius = 18,
  playerOnly = false,
): boolean {
  let anyHit = false;
  const splitTargets: WorldOrganism[] = [];

  for (let i = world.organisms.length - 1; i >= 0; i--) {
    const org = world.organisms[i];
    if (playerOnly && org.faction !== 'player') continue;
    if (Math.hypot(org.mesh.comX - wx, org.mesh.comY - wy) > org.mesh.boundRadius + worldRadius) {
      continue;
    }
    const verts = org.mesh.vertices;
    let orgHit = false;
    for (const cell of org.mesh.cells) {
      const cx = (verts[cell.vTL].x + verts[cell.vTR].x + verts[cell.vBR].x + verts[cell.vBL].x) * 0.25;
      const cy = (verts[cell.vTL].y + verts[cell.vTR].y + verts[cell.vBR].y + verts[cell.vBL].y) * 0.25;
      if (Math.hypot(cx - wx, cy - wy) <= worldRadius) {
        const stride = 1 << cell.meshLevel;
        injureSimulation(
          org.simState,
          org.genome,
          cell.gx * stride + stride * 0.5,
          cell.gy * stride + stride * 0.5,
          stride * 1.15,
          false,
        );
        orgHit = true;
        org.rupturedCells += 1;
        depositChemical(world.foodField, cx, cy, 0.1, 2);
      }
    }
    if (orgHit) {
      anyHit = true;
      org.damageFlash = 1.0;
      refreshSimComposite(org.simState, org.genome);
      syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
      if (org.mesh.cells.length === 0) {
        world.deathsRuptured += 1;
        releaseDeathNutrients(world, org, createPellet);
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
