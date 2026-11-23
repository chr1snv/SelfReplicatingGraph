import {
  MipLevel,
  SoftCell,
  TissueType,
  WorldOrganism,
  WorldState,
  mipDim,
} from '../types/morphogenesis';
import { blendNeuralNetState, cloneNeuralNetState } from './neuralNet';
import {
  cloneSimStateMasked,
  injureSimulation,
  mergeSimStateFromFragment,
  refreshSimComposite,
} from './simulator';
import {
  extractMeshComponents,
  extractSubMeshByKeys,
  mergeFragmentIntoMesh,
  retainMeshCellsByKeys,
  syncOrganismMeshFromSimState,
} from './softBodyPhysics';
import { WORLD_HEIGHT, WORLD_WIDTH, depositChemical } from './worldChemicals';

// Pre-allocated flat spatial-hash & collision scratch buffers (zero per-frame GC allocation)
const HASH_CELL = 6;
const HASH_COLS = Math.ceil((WORLD_WIDTH + 240) / HASH_CELL); // 307
const HASH_ROWS = Math.ceil((WORLD_HEIGHT + 240) / HASH_CELL); // 207
const SPATIAL_HEAD = new Int32Array(HASH_COLS * HASH_ROWS);
SPATIAL_HEAD.fill(-1);
const MAX_HASH_VERTS = 4096;
const SPATIAL_NEXT = new Int32Array(MAX_HASH_VERTS);
const TOUCHED_BUCKETS = new Int32Array(MAX_HASH_VERTS);
let TOUCHED_BUCKET_COUNT = 0;

export const MAX_WORLD_ORGS_SCRATCH = 128;
export const MAX_ORG_VERTS_SCRATCH = 1024;
const VERT_SQUISH_MARK = new Uint8Array(MAX_WORLD_ORGS_SCRATCH * MAX_ORG_VERTS_SCRATCH);
const VERT_PIERCE_MARK = new Uint8Array(MAX_WORLD_ORGS_SCRATCH * MAX_ORG_VERTS_SCRATCH);
const ORG_HAS_SQUISH = new Uint8Array(MAX_WORLD_ORGS_SCRATCH);
const VERT_SPIKE_A = new Uint8Array(MAX_ORG_VERTS_SCRATCH);
const VERT_SPIKE_B = new Uint8Array(MAX_ORG_VERTS_SCRATCH);

const MAX_CONTACT_PAIRS = 512;
export const CONTACT_PAIR_A = new Int32Array(MAX_CONTACT_PAIRS);
export const CONTACT_PAIR_B = new Int32Array(MAX_CONTACT_PAIRS);
export let CONTACT_PAIR_COUNT = 0;

export const REMOVED_FLAGS = new Uint8Array(MAX_WORLD_ORGS_SCRATCH);
const SPIKE_DIRTY_ORGS = new Uint8Array(MAX_WORLD_ORGS_SCRATCH);
const MAX_SPIKE_HITS = 128;
const SPIKE_HIT_TARGET_IDX = new Int32Array(MAX_SPIKE_HITS);
const SPIKE_HIT_ATTACKER_IDX = new Int32Array(MAX_SPIKE_HITS);
const SPIKE_HIT_WX = new Float32Array(MAX_SPIKE_HITS);
const SPIKE_HIT_WY = new Float32Array(MAX_SPIKE_HITS);
let SPIKE_HIT_COUNT = 0;
const SPIKE_SPLIT_LIST: WorldOrganism[] = [];

function resetSpatialHash(): void {
  for (let i = 0; i < TOUCHED_BUCKET_COUNT; i++) {
    SPATIAL_HEAD[TOUCHED_BUCKETS[i]] = -1;
  }
  TOUCHED_BUCKET_COUNT = 0;
}

function buildVertexSpikeMask(org: WorldOrganism, mask: Uint8Array, vertCount: number): void {
  const limit = Math.min(vertCount, MAX_ORG_VERTS_SCRATCH);
  mask.fill(0, 0, limit);
  if (org.mesh.spikeCount <= 0) return;
  const cells = org.mesh.cells;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.spikeWeight > 0.15 || c.tissue === TissueType.SPIKE) {
      if (c.vTL < limit) mask[c.vTL] = 1;
      if (c.vTR < limit) mask[c.vTR] = 1;
      if (c.vBR < limit) mask[c.vBR] = 1;
      if (c.vBL < limit) mask[c.vBL] = 1;
    }
  }
}

/**
 * Releases localized nutrient cloud and pellets back into the world upon organism death.
 */
export function releaseDeathNutrients(
  world: WorldState,
  org: WorldOrganism,
  createPelletFn: (w: WorldState, x: number, y: number, isPhoto: boolean, amount: number) => WorldState['pellets'][0],
): void {
  const cx = Math.max(20, Math.min(world.width - 20, org.mesh.comX));
  const cy = Math.max(20, Math.min(world.height - 20, org.mesh.comY));
  const cellCount = Math.max(1, org.mesh.cells.length);
  const scentAmount = Math.min(0.85, 0.08 + cellCount * 0.01);
  depositChemical(world.foodField, cx, cy, scentAmount, cellCount >= 12 ? 3 : 2);

  if (cellCount < 6) return;

  const pelletDrops = cellCount > 140 ? 3 : cellCount > 55 ? 2 : 1;
  const totalBiomass = Math.min(2.4, cellCount * 0.0085);
  const amountPerPellet = Math.min(1.0, totalBiomass / pelletDrops);
  for (let i = 0; i < pelletDrops; i++) {
    if (world.pellets.length >= 28) break;
    const ang = (i * Math.PI * 2) / pelletDrops + Math.random() * 0.5;
    const rad = pelletDrops === 1 ? 0 : 14;
    const px = Math.max(25, Math.min(world.width - 25, cx + Math.cos(ang) * rad));
    const py = Math.max(25, Math.min(world.height - 25, cy + Math.sin(ang) * rad));
    world.pellets.push(createPelletFn(world, px, py, false, amountPerPellet));
  }
}

/**
 * Spatial-hashed O(V) collision resolution with elastic overlap bounce,
 * inter-organism squish, active spike localized excision queues, and colony touch pairs.
 */
export function resolveOrganismCollisions(world: WorldState): void {
  const organisms = world.organisms;
  const orgCount = Math.min(organisms.length, MAX_WORLD_ORGS_SCRATCH);
  CONTACT_PAIR_COUNT = 0;
  SPIKE_HIT_COUNT = 0;
  ORG_HAS_SQUISH.fill(0, 0, orgCount);
  if (organisms.length < 2) return;

  const minVertDist = 3.1;
  const minVertDist2 = minVertDist * minVertDist;
  let spikeSoundTriggered = false;

  const markOrgVertHit = (orgIdx: number, vIdx: number, isPierced: boolean): void => {
    if (orgIdx >= MAX_WORLD_ORGS_SCRATCH || vIdx >= MAX_ORG_VERTS_SCRATCH) return;
    const base = orgIdx * MAX_ORG_VERTS_SCRATCH;
    if (ORG_HAS_SQUISH[orgIdx] === 0) {
      const vLen = Math.min(organisms[orgIdx].mesh.vertices.length, MAX_ORG_VERTS_SCRATCH);
      VERT_SQUISH_MARK.fill(0, base, base + vLen);
      VERT_PIERCE_MARK.fill(0, base, base + vLen);
      ORG_HAS_SQUISH[orgIdx] = 1;
    }
    VERT_SQUISH_MARK[base + vIdx] = 1;
    if (isPierced) VERT_PIERCE_MARK[base + vIdx] = 1;
  };

  for (let a = 0; a < organisms.length; a++) {
    const orgA = organisms[a];
    const vertsA = orgA.mesh.vertices;
    if (vertsA.length === 0) continue;

    let hashedA = false;
    const vertCountA = Math.min(vertsA.length, MAX_HASH_VERTS);

    for (let b = a + 1; b < organisms.length; b++) {
      const orgB = organisms[b];
      const vertsB = orgB.mesh.vertices;
      if (vertsB.length === 0) continue;

      const cDx = orgB.mesh.comX - orgA.mesh.comX;
      const cDy = orgB.mesh.comY - orgA.mesh.comY;
      const maxSep = orgA.mesh.boundRadius + orgB.mesh.boundRadius + 6;
      if (cDx * cDx + cDy * cDy > maxSep * maxSep) continue;

      if (!hashedA) {
        resetSpatialHash();
        for (let i = 0; i < vertCountA; i++) {
          const hx = Math.max(0, Math.min(HASH_COLS - 1, Math.floor((vertsA[i].x + 100) / HASH_CELL)));
          const hy = Math.max(0, Math.min(HASH_ROWS - 1, Math.floor((vertsA[i].y + 100) / HASH_CELL)));
          const hKey = hy * HASH_COLS + hx;
          if (SPATIAL_HEAD[hKey] === -1 && TOUCHED_BUCKET_COUNT < MAX_HASH_VERTS) {
            TOUCHED_BUCKETS[TOUCHED_BUCKET_COUNT++] = hKey;
          }
          SPATIAL_NEXT[i] = SPATIAL_HEAD[hKey];
          SPATIAL_HEAD[hKey] = i;
        }
        buildVertexSpikeMask(orgA, VERT_SPIKE_A, vertsA.length);
        hashedA = true;
      }

      buildVertexSpikeMask(orgB, VERT_SPIKE_B, vertsB.length);

      const sameColony = orgA.colonyId === orgB.colonyId;
      const isHostileRivals =
        world.battle.enabled &&
        !world.battle.barrierActive &&
        orgA.faction !== 'neutral' &&
        orgB.faction !== 'neutral' &&
        orgA.faction !== orgB.faction;

      const aSpikesActive = orgA.mesh.spikeCount > 0 && orgA.neuralNet.isAggressive;
      const bSpikesActive = orgB.mesh.spikeCount > 0 && orgB.neuralNet.isAggressive;

      let contactCount = 0;
      let pushSumX = 0;
      let pushSumY = 0;
      let overlapIntensity = 0;
      let pairHitsOnB = 0;
      let pairHitsOnA = 0;
      let lastHitBx = 0;
      let lastHitBy = 0;
      let lastHitAx = 0;
      let lastHitAy = 0;

      for (let j = 0; j < vertsB.length; j++) {
        const vb = vertsB[j];
        const bx = Math.max(1, Math.min(HASH_COLS - 2, Math.floor((vb.x + 100) / HASH_CELL)));
        const by = Math.max(1, Math.min(HASH_ROWS - 2, Math.floor((vb.y + 100) / HASH_CELL)));
        const bIsSpike = j < MAX_ORG_VERTS_SCRATCH && VERT_SPIKE_B[j] === 1;

        for (let oy = -1; oy <= 1; oy++) {
          const rowKey = (by + oy) * HASH_COLS;
          for (let ox = -1; ox <= 1; ox++) {
            let i = SPATIAL_HEAD[rowKey + bx + ox];
            while (i !== -1) {
              const va = vertsA[i];
              const dx = vb.x - va.x;
              const dy = vb.y - va.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < minVertDist2 && d2 > 1e-6) {
                contactCount++;
                const d = Math.sqrt(d2);
                const cappedOverlap = Math.min(1.4, minVertDist - d);
                const nx = dx / d;
                const ny = dy / d;

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

                if (!sameColony) {
                  const aIsSpike = i < MAX_ORG_VERTS_SCRATCH && VERT_SPIKE_A[i] === 1;
                  const aPiercesB = aSpikesActive && aIsSpike && !bIsSpike;
                  const bPiercesA = bSpikesActive && bIsSpike && !aIsSpike;

                  if (aPiercesB) {
                    markOrgVertHit(b, j, true);
                    if (
                      pairHitsOnB < 2 &&
                      SPIKE_HIT_COUNT < MAX_SPIKE_HITS &&
                      b < MAX_WORLD_ORGS_SCRATCH &&
                      (pairHitsOnB === 0 ||
                        Math.hypot(vb.x - lastHitBx, vb.y - lastHitBy) >= orgB.mesh.cellSize * 1.4)
                    ) {
                      SPIKE_HIT_TARGET_IDX[SPIKE_HIT_COUNT] = b;
                      SPIKE_HIT_ATTACKER_IDX[SPIKE_HIT_COUNT] = a;
                      SPIKE_HIT_WX[SPIKE_HIT_COUNT] = vb.x;
                      SPIKE_HIT_WY[SPIKE_HIT_COUNT] = vb.y;
                      SPIKE_HIT_COUNT++;
                      pairHitsOnB++;
                      lastHitBx = vb.x;
                      lastHitBy = vb.y;
                    }
                  }
                  if (bPiercesA) {
                    markOrgVertHit(a, i, true);
                    if (
                      pairHitsOnA < 2 &&
                      SPIKE_HIT_COUNT < MAX_SPIKE_HITS &&
                      a < MAX_WORLD_ORGS_SCRATCH &&
                      (pairHitsOnA === 0 ||
                        Math.hypot(va.x - lastHitAx, va.y - lastHitAy) >= orgA.mesh.cellSize * 1.4)
                    ) {
                      SPIKE_HIT_TARGET_IDX[SPIKE_HIT_COUNT] = a;
                      SPIKE_HIT_ATTACKER_IDX[SPIKE_HIT_COUNT] = b;
                      SPIKE_HIT_WX[SPIKE_HIT_COUNT] = va.x;
                      SPIKE_HIT_WY[SPIKE_HIT_COUNT] = va.y;
                      SPIKE_HIT_COUNT++;
                      pairHitsOnA++;
                      lastHitAx = va.x;
                      lastHitAy = va.y;
                    }
                  }

                  const crushThresh = isHostileRivals ? 0.42 : 0.78;
                  if (cappedOverlap > crushThresh) {
                    markOrgVertHit(a, i, bPiercesA);
                    markOrgVertHit(b, j, aPiercesB);
                  }
                }
              }
              i = SPATIAL_NEXT[i];
            }
          }
        }
      }

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

        if ((pairHitsOnB > 0 || pairHitsOnA > 0) && !spikeSoundTriggered) {
          world.soundEvents.push({ type: 'rupture', intensity: 0.78 });
          spikeSoundTriggered = true;
        }

        if (isHostileRivals) {
          const massA = orgA.mesh.cells.length * (0.5 + orgA.energyReserve / 150) + orgA.mesh.spikeCount * 2.0;
          const massB = orgB.mesh.cells.length * (0.5 + orgB.energyReserve / 150) + orgB.mesh.spikeCount * 2.0;
          if (massA >= massB) {
            orgB.energyReserve = Math.max(0, orgB.energyReserve - 1.35);
            orgA.energyReserve = Math.min(100, orgA.energyReserve + 0.35);
            orgA.combatScore += 1;
            orgB.damageFlash = 0.8;
          } else {
            orgA.energyReserve = Math.max(0, orgA.energyReserve - 1.35);
            orgB.energyReserve = Math.min(100, orgB.energyReserve + 0.35);
            orgB.combatScore += 1;
            orgA.damageFlash = 0.8;
          }
        }
      }

      if ((contactCount > 0 || Math.hypot(cDx, cDy) < 56) && CONTACT_PAIR_COUNT < MAX_CONTACT_PAIRS) {
        CONTACT_PAIR_A[CONTACT_PAIR_COUNT] = a;
        CONTACT_PAIR_B[CONTACT_PAIR_COUNT] = b;
        CONTACT_PAIR_COUNT++;
      }
    }
  }
}

/**
 * Splits any disconnected mesh component (e.g. post-scalpel or spike excision) into
 * independent colony fragments or reclaims sub-viable <3-cell debris into chemical nutrients.
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
  const parentWaste = Math.max(0, org.wasteLevel);

  org.energyReserve = parentEnergy * (primaryKeys.length / totalCells);
  org.wasteLevel = parentWaste * (primaryKeys.length / totalCells);

  for (let ci = 1; ci < components.length; ci++) {
    const compKeys = components[ci];
    if (compKeys.length === 0) continue;

    const frac = compKeys.length / totalCells;
    const fragEnergy = parentEnergy * frac;
    const fragWaste = parentWaste * frac;

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

    const dx = fragMesh.comX - fullMesh.comX;
    const dy = fragMesh.comY - fullMesh.comY;
    const dLen = Math.max(1, Math.hypot(dx, dy));
    for (const v of fragMesh.vertices) {
      v.vx += (dx / dLen) * 0.85;
      v.vy += (dy / dLen) * 0.85;
    }

    const fragId = world.nextOrgId++;
    world.organisms.push({
      id: fragId,
      colonyId: org.colonyId,
      faction: org.faction,
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
      wasteLevel: fragWaste,
      lastMetabolicDrain: org.lastMetabolicDrain,
      steerBias: org.steerBias,
      sensorMagnitude: org.sensorMagnitude,
      neuralNet: cloneNeuralNetState(org.neuralNet),
      mood: 'threatened',
      scentSignature: org.scentSignature,
      ignoredPelletUntil: new Map(org.ignoredPelletUntil),
      combatScore: 0,
      musclePhaseTime: org.musclePhaseTime,
      speed: org.speed,
      ageTicks: org.ageTicks,
      matingCooldown: 160,
      consumedFood: 0,
      rupturedCells: 0,
      damageFlash: 1.0,
    });
  }

  org.simState = cloneSimStateMasked(fullSimState, org.genome, meshLevel, primarySet);
  retainMeshCellsByKeys(org.mesh, primarySet);
}

/**
 * Applies queued Chitin Spike localized scalpel-style cell excisions + squishes + reconnection.
 */
export function applyPostCollisionEffects(
  world: WorldState,
  orgCap: number,
  splitCap: number,
  createPelletFn: (w: WorldState, x: number, y: number, isPhoto: boolean, amount: number) => WorldState['pellets'][0],
): boolean {
  REMOVED_FLAGS.fill(0, 0, orgCap);
  let anyRemoved = false;

  if (SPIKE_HIT_COUNT > 0) {
    SPIKE_DIRTY_ORGS.fill(0, 0, orgCap);
    for (let h = 0; h < SPIKE_HIT_COUNT; h++) {
      const targetIdx = SPIKE_HIT_TARGET_IDX[h];
      const atkIdx = SPIKE_HIT_ATTACKER_IDX[h];
      if (targetIdx >= orgCap || atkIdx >= orgCap) continue;
      const target = world.organisms[targetIdx];
      const attacker = world.organisms[atkIdx];
      if (!target || !attacker) continue;

      const hx = SPIKE_HIT_WX[h];
      const hy = SPIKE_HIT_WY[h];
      const verts = target.mesh.vertices;
      const strikeRadius = Math.max(6.5, target.mesh.cellSize * 1.95);
      let excisedHere = 0;

      for (let cIdx = 0; cIdx < target.mesh.cells.length; cIdx++) {
        const cell = target.mesh.cells[cIdx];
        const cx =
          (verts[cell.vTL].x + verts[cell.vTR].x + verts[cell.vBR].x + verts[cell.vBL].x) * 0.25;
        const cy =
          (verts[cell.vTL].y + verts[cell.vTR].y + verts[cell.vBR].y + verts[cell.vBL].y) * 0.25;
        if (Math.hypot(cx - hx, cy - hy) <= strikeRadius) {
          const stride = 1 << cell.meshLevel;
          const px = cell.gx * stride + stride * 0.5;
          const py = cell.gy * stride + stride * 0.5;
          injureSimulation(target.simState, target.genome, px, py, stride * 1.15, false);
          depositChemical(world.foodField, cx, cy, 0.08, 2);
          target.rupturedCells += 1;
          attacker.combatScore += 1;
          SPIKE_DIRTY_ORGS[targetIdx] = 1;
          excisedHere++;
          if (excisedHere >= 2) break;
        }
      }
    }

    SPIKE_SPLIT_LIST.length = 0;
    for (let i = 0; i < orgCap; i++) {
      if (SPIKE_DIRTY_ORGS[i] === 0) continue;
      const org = world.organisms[i];
      org.damageFlash = 1.0;
      refreshSimComposite(org.simState, org.genome);
      syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
      if (org.mesh.cells.length === 0) {
        world.deathsRuptured += 1;
        releaseDeathNutrients(world, org, createPelletFn);
        REMOVED_FLAGS[i] = 1;
        anyRemoved = true;
      } else {
        SPIKE_SPLIT_LIST.push(org);
      }
    }
    for (let s = 0; s < SPIKE_SPLIT_LIST.length; s++) {
      splitDisconnectedComponents(world, SPIKE_SPLIT_LIST[s], splitCap);
    }
  }

  for (let i = 0; i < orgCap; i++) {
    if (ORG_HAS_SQUISH[i] === 0 || REMOVED_FLAGS[i] === 1) continue;
    const org = world.organisms[i];
    const base = i * MAX_ORG_VERTS_SCRATCH;
    const vLimit = Math.min(org.mesh.vertices.length, MAX_ORG_VERTS_SCRATCH);
    for (let cIdx = 0; cIdx < org.mesh.cells.length; cIdx++) {
      const cell = org.mesh.cells[cIdx];
      const pierced =
        (cell.vTL < vLimit && VERT_PIERCE_MARK[base + cell.vTL] === 1) ||
        (cell.vTR < vLimit && VERT_PIERCE_MARK[base + cell.vTR] === 1) ||
        (cell.vBR < vLimit && VERT_PIERCE_MARK[base + cell.vBR] === 1) ||
        (cell.vBL < vLimit && VERT_PIERCE_MARK[base + cell.vBL] === 1);
      if (pierced) {
        cell.crushStress += 0.58;
        continue;
      }
      const squished =
        (cell.vTL < vLimit && VERT_SQUISH_MARK[base + cell.vTL] === 1) ||
        (cell.vTR < vLimit && VERT_SQUISH_MARK[base + cell.vTR] === 1) ||
        (cell.vBR < vLimit && VERT_SQUISH_MARK[base + cell.vBR] === 1) ||
        (cell.vBL < vLimit && VERT_SQUISH_MARK[base + cell.vBL] === 1);
      if (squished) {
        cell.crushStress += 0.3;
      }
    }
  }

  for (let p = 0; p < CONTACT_PAIR_COUNT; p++) {
    const ia = CONTACT_PAIR_A[p];
    const ib = CONTACT_PAIR_B[p];
    if (ia >= orgCap || ib >= orgCap || REMOVED_FLAGS[ia] || REMOVED_FLAGS[ib]) continue;
    const orgA = world.organisms[ia];
    const orgB = world.organisms[ib];
    if (!orgA || !orgB) continue;

    if (orgA.colonyId === orgB.colonyId && (!world.battle.enabled || orgA.faction === orgB.faction)) {
      if (canFragmentsReconnectByMorphogenesis(orgA, orgB)) {
        const keepA = orgA.mesh.cells.length >= orgB.mesh.cells.length;
        const host = keepA ? orgA : orgB;
        const frag = keepA ? orgB : orgA;
        const dropIdx = keepA ? ib : ia;

        mergeSimStateFromFragment(host.simState, frag.simState, host.genome);
        mergeFragmentIntoMesh(host.mesh, frag.mesh);
        blendNeuralNetState(host.neuralNet, frag.neuralNet);
        host.energyReserve = Math.min(100, host.energyReserve + frag.energyReserve);
        host.wasteLevel = Math.min(100, host.wasteLevel + frag.wasteLevel);
        host.consumedFood += frag.consumedFood;
        host.isFragment = false;
        world.totalReconnections += 1;
        world.soundEvents.push({ type: 'reconnect', intensity: 1 });
        REMOVED_FLAGS[dropIdx] = 1;
        anyRemoved = true;
      }
    }
  }

  if (anyRemoved) {
    for (let i = orgCap - 1; i >= 0; i--) {
      if (REMOVED_FLAGS[i] === 1) {
        world.organisms.splice(i, 1);
      }
    }
  }

  return anyRemoved;
}

function canFragmentsReconnectByMorphogenesis(orgA: WorldOrganism, orgB: WorldOrganism): boolean {
  if (orgA.faction !== orgB.faction || orgA.mesh.meshLevel !== orgB.mesh.meshLevel) return false;
  const lvl: MipLevel = orgA.mesh.meshLevel;
  const compiledLayer = orgA.genome.layers[lvl];
  const simLayerA = orgA.simState.layers[lvl];
  const simLayerB = orgB.simState.layers[lvl];
  const vertsA = orgA.mesh.vertices;
  const vertsB = orgB.mesh.vertices;
  const touchDist2 = Math.pow(orgA.mesh.cellSize * 3.4, 2);

  for (let i = 0; i < orgA.mesh.cells.length; i++) {
    const cA = orgA.mesh.cells[i];
    if (
      findTouchingMorphogenesisNeighbor(
        cA,
        vertsA,
        simLayerA.nodeId[cA.key],
        orgB,
        vertsB,
        simLayerB.nodeId,
        compiledLayer.tissueGrid,
        touchDist2,
      )
    ) {
      return true;
    }
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
  const cxA = (vertsA[cA.vTL].x + vertsA[cA.vTR].x + vertsA[cA.vBR].x + vertsA[cA.vBL].x) * 0.25;
  const cyA = (vertsA[cA.vTL].y + vertsA[cA.vTR].y + vertsA[cA.vBR].y + vertsA[cA.vBL].y) * 0.25;
  const nodeA = orgB.genome.nodeById.get(nodeIdA);

  for (let d = 0; d < 4; d++) {
    const nx = d === 2 ? cA.gx + 1 : d === 3 ? cA.gx - 1 : cA.gx;
    const ny = d === 0 ? cA.gy - 1 : d === 1 ? cA.gy + 1 : cA.gy;
    if (nx < 0 || nx >= dim || ny < 0 || ny >= dim) continue;

    const bKey = ny * dim + nx;
    const cB = orgB.mesh.cellMap.get(bKey);
    if (!cB) continue;

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

    const cxB = (vertsB[cB.vTL].x + vertsB[cB.vTR].x + vertsB[cB.vBR].x + vertsB[cB.vBL].x) * 0.25;
    const cyB = (vertsB[cB.vTL].y + vertsB[cB.vTR].y + vertsB[cB.vBR].y + vertsB[cB.vBL].y) * 0.25;
    if ((cxA - cxB) * (cxA - cxB) + (cyA - cyB) * (cyA - cyB) <= touchDist2) {
      return cB;
    }
  }
  return null;
}
