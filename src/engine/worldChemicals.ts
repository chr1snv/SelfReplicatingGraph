import {
  BiomeId,
  FoodPellet,
  OrganismMood,
  SunZone,
  WorldOrganism,
  WorldParams,
  WorldState,
} from '../types/morphogenesis';
import { getBiomeDef } from './biomes';

/** World chemical grid dimensions (shared with GPU chemical diffusion FBO) */
export const WORLD_WIDTH = 1600;
export const WORLD_HEIGHT = 1000;
export const CHEM_CELL = 10;
export const CHEM_COLS = WORLD_WIDTH / CHEM_CELL; // 160
export const CHEM_ROWS = WORLD_HEIGHT / CHEM_CELL; // 100

/** Pre-allocated scratch buffer for zero-GC chemical diffusion */
const CHEM_SCRATCH = new Float32Array(CHEM_COLS * CHEM_ROWS);

/**
 * Returns localized volumetric sunlight shaft regions for each aquatic biome.
 */
export function generateBiomeSunZones(biomeId: BiomeId): SunZone[] {
  switch (biomeId) {
    case 'pond':
      return [
        { x: 420, y: 310, radius: 240, intensity: 0.9 },
        { x: 1120, y: 380, radius: 260, intensity: 0.85 },
        { x: 760, y: 740, radius: 210, intensity: 0.72 },
      ];
    case 'tidepool':
      return [
        { x: 340, y: 260, radius: 270, intensity: 1.0 },
        { x: 820, y: 490, radius: 300, intensity: 0.95 },
        { x: 1280, y: 290, radius: 250, intensity: 0.92 },
      ];
    case 'leaf_droplet':
      return [
        { x: 800, y: 500, radius: 480, intensity: 1.0 },
        { x: 520, y: 340, radius: 260, intensity: 0.96 },
        { x: 1080, y: 660, radius: 260, intensity: 0.96 },
      ];
    case 'frozen_ice':
      return [
        { x: 480, y: 460, radius: 185, intensity: 0.58 },
        { x: 1120, y: 520, radius: 185, intensity: 0.55 },
      ];
    case 'cave':
      return [{ x: 800, y: 500, radius: 110, intensity: 0.14 }];
  }
}

/**
 * Samples local photosynthetic light irradiance at world coordinate `(wx, wy)`.
 */
export function sampleSunlightAt(
  world: WorldState,
  worldParams: WorldParams,
  wx: number,
  wy: number,
): number {
  const biome = getBiomeDef(world.biomeId);
  let sun = biome.ambientSunlight * 0.42;
  for (let i = 0; i < world.sunZones.length; i++) {
    const sz = world.sunZones[i];
    const dx = wx - sz.x;
    const dy = wy - sz.y;
    const r2 = sz.radius * sz.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 < r2) {
      const falloff = 1 - Math.sqrt(d2) / sz.radius;
      sun += sz.intensity * falloff * falloff * 0.75;
    }
  }
  return Math.max(0, Math.min(1.5, sun * worldParams.sunlightLevel));
}

/**
 * Instantiates a nutrient detritus pellet or photosynthesizing algae spore.
 */
export function createPellet(
  world: WorldState,
  x: number,
  y: number,
  isPhotosynthetic: boolean,
  amount = 1.0,
): FoodPellet {
  return {
    id: world.nextPelletId++,
    x,
    y,
    radius: isPhotosynthetic ? 11 : 9,
    amount,
    maxAmount: isPhotosynthetic ? 1.35 : 1.0,
    isPhotosynthetic,
    growthRate: isPhotosynthetic ? 1.0 : 0,
  };
}

/**
 * Bilinearly interpolates a continuous scalar from a discrete world chemical grid.
 */
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

/**
 * Deposits chemical plume intensity with linear radial falloff around `(wx, wy)`.
 */
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
        field[idx] = Math.max(-2.0, Math.min(2.0, field[idx] + amount * falloff));
      }
    }
  }
}

/**
 * Rapidly clears lingering food scent spots immediately after a pellet is consumed
 * so organisms swim toward the next untouched pellet instead of orbiting an empty crumb.
 */
export function clearChemicalSpot(
  field: Float32Array,
  wx: number,
  wy: number,
  radiusCells = 4,
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
        field[idx] *= 1 - falloff * 0.85;
      }
    }
  }
}

/**
 * Runs 4-neighbor discrete Laplacian diffusion + exponential decay on a chemical grid
 * using the module-level pre-allocated `CHEM_SCRATCH` buffer.
 */
export function diffuseField(field: Float32Array, rate: number, decay: number): void {
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
      CHEM_SCRATCH[idx] = (c + rate * (avg - c)) * decay;
    }
  }
  field.set(CHEM_SCRATCH);
}

/**
 * Derives high-level behavioral mood from ATP reserve, damage trauma, AR aggression,
 * and mating readiness.
 */
export function updateOrganismMood(org: WorldOrganism): OrganismMood {
  if (org.damageFlash > 0.25 && !org.neuralNet.isAggressive) return 'threatened';
  if (org.energyReserve < 26) return 'exhausted';
  if (org.neuralNet.isAggressive && org.energyReserve >= 34 && !org.isFragment) {
    return 'aggressive';
  }
  if (
    !org.isFragment &&
    org.energyReserve >= 54 &&
    org.matingCooldown === 0 &&
    org.ageTicks >= 60
  ) {
    return 'amorous';
  }
  return 'foraging';
}

/**
 * Computes normalized hostile rival proximity [0..1] to feed Neuron 1's aggression trigger.
 */
export function computeHostileProximity(world: WorldState, org: WorldOrganism): number {
  if (org.energyReserve < 34 || org.isFragment) return 0;
  const barrierBlocked = world.battle.enabled && world.battle.barrierActive;
  const hasSpikes = org.mesh.spikeCount > 0;
  const hasHunterDrive = org.neuralNet.neurons[1].bias >= 0.28;
  let maxProx = 0;

  for (let i = 0; i < world.organisms.length; i++) {
    const other = world.organisms[i];
    if (other.id === org.id || other.colonyId === org.colonyId) continue;
    if (barrierBlocked && other.faction !== org.faction) continue;

    // Mutual amorous mates approach cleanly without arming spikes
    if (
      org.mood === 'amorous' &&
      other.mood === 'amorous' &&
      (!world.battle.enabled || other.faction === org.faction)
    ) {
      continue;
    }

    const dx = other.mesh.comX - org.mesh.comX;
    const dy = other.mesh.comY - org.mesh.comY;
    const d = Math.hypot(dx, dy);

    const isBattleRival =
      world.battle.enabled &&
      org.faction !== 'neutral' &&
      other.faction !== 'neutral' &&
      org.faction !== other.faction;

    if (isBattleRival) {
      if (d < 240) {
        const strikeRange = org.mesh.boundRadius + other.mesh.boundRadius + 48;
        const p = d <= strikeRange ? 1.0 : Math.max(0.45, 1.0 - d / 260);
        if (p > maxProx) maxProx = p;
      }
    } else if (hasSpikes) {
      const contactRange = org.mesh.boundRadius + other.mesh.boundRadius + 24;
      if (org.damageFlash > 0.06 && d < contactRange + 42) {
        if (0.9 > maxProx) maxProx = 0.9;
      } else if (hasHunterDrive && d < 145) {
        const p = d <= contactRange + 16 ? 0.95 : 0.72;
        if (p > maxProx) maxProx = p;
      } else if (d < contactRange && other.energyReserve > 0) {
        if (0.76 > maxProx) maxProx = 0.76;
      }
    }
  }
  return maxProx;
}

/**
 * Evaluates organism-specific chemotaxis potential at world point `(wx, wy)`:
 * - Local chemical food & toxin fields
 * - Edge-reaching analytical food plume for each active pellet (skipping recently eaten IDs)
 * - Same-faction mating pheromone attraction & rival threat repulsion/pursuit
 */
export function sampleAttractantForOrganism(
  world: WorldState,
  org: WorldOrganism,
  wx: number,
  wy: number,
): number {
  let score =
    sampleFieldBilinear(world.foodField, wx, wy) * 0.85 -
    1.45 * sampleFieldBilinear(world.toxinField, wx, wy);

  const tick = world.worldTick;
  const barrierBlocked = world.battle.enabled && world.battle.barrierActive;
  const bx = world.battle.barrierX;

  for (let i = 0; i < world.pellets.length; i++) {
    const p = world.pellets[i];
    if (barrierBlocked) {
      if (org.faction === 'player' && p.x > bx) continue;
      if (org.faction === 'ai' && p.x < bx) continue;
    }
    const expiry = org.ignoredPelletUntil.get(p.id);
    if (expiry !== undefined && tick < expiry) continue;

    const dx = p.x - wx;
    const dy = p.y - wy;
    const d2 = dx * dx + dy * dy;
    const d = Math.sqrt(d2);
    score += p.amount * (0.88 / (1 + d2 / (185 * 185)) + 0.36 / (1 + d / 560));
  }

  for (let i = 0; i < world.organisms.length; i++) {
    const other = world.organisms[i];
    if (other.id === org.id || other.colonyId === org.colonyId) continue;
    if (barrierBlocked && other.faction !== org.faction) continue;

    const dx = other.mesh.comX - wx;
    const dy = other.mesh.comY - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 > 540 * 540) continue;

    const isHostile =
      world.battle.enabled &&
      org.faction !== 'neutral' &&
      other.faction !== 'neutral' &&
      org.faction !== other.faction;

    if (isHostile) {
      const weAreStronger =
        org.energyReserve >= 46 && org.mesh.cells.length >= other.mesh.cells.length * 0.78;
      if (weAreStronger && !barrierBlocked) {
        score += 0.48 / (1 + d2 / (220 * 220));
      } else {
        score -= 0.72 / (1 + d2 / (140 * 140));
      }
    } else if (other.mood === 'threatened' && org.energyReserve < 45) {
      score -= 0.35 / (1 + d2 / (120 * 120));
    } else if (
      org.mood === 'amorous' &&
      other.mood === 'amorous' &&
      (!world.battle.enabled || (other.faction === org.faction && org.faction !== 'neutral'))
    ) {
      score += 0.62 / (1 + d2 / (210 * 210));
    }
  }

  return score;
}
