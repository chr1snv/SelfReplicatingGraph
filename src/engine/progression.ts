import {
  BiomeId,
  CompiledGenome,
  LocomotionMode,
  SimState,
  TissueType,
  WorldState,
} from '../types/morphogenesis';
import { BIOMES } from './biomes';

export type ProgressionKind = 'mission' | 'achievement';

export interface ProgressionEntryDef {
  id: string;
  kind: ProgressionKind;
  title: string;
  description: string;
  target: number;
  unitLabel: string;
  biomeTag?: BiomeId;
}

export interface ProgressionTracker {
  customBlueprintsCompiled: number;
  imagesImported: number;
  manualMatings: number;
  scalpelHits: number;
  foodDrops: number;
  pokes: number;
  designerCustomFullTriad: boolean;
  peakDesignerIou: number;
  peakWorldOrganisms: number;
  peakGeneration: number;
  peakSingleFoodConsumed: number;
  cumulativeWorldFood: number;
  barrierBreaches: number;
  battleVictories: number;
  biomePeakPop: Record<BiomeId, number>;
  biomeBestGen: Record<BiomeId, number>;
  biomeFood: Record<BiomeId, number>;
  observedModes: Record<LocomotionMode, boolean>;
  unlockedAt: Record<string, number>;
}

export interface ProgressionEvaluatedItem extends ProgressionEntryDef {
  current: number;
  progressPct: number;
  completed: boolean;
  unlockedAt: number | null;
}

export const PROGRESSION_STORAGE_KEY = 'morphograph_progress_v2';

export const PROGRESSION_CATALOG: ProgressionEntryDef[] = [
  // Biome Progression Missions (unlock next areas!)
  {
    id: 'mission_pond_clear',
    kind: 'mission',
    biomeTag: 'pond',
    title: 'Pond Pioneer (Unlocks Tidepool)',
    description: 'In Sunlit Garden Pond: sustain 8+ living organisms and breed a Gen 2+ hybrid.',
    target: 8,
    unitLabel: 'organisms',
  },
  {
    id: 'mission_tidepool_clear',
    kind: 'mission',
    biomeTag: 'tidepool',
    title: 'Tidepool Surge (Unlocks Leaf Drop)',
    description: 'In Coastal Tidepool: harvest 6.0 cumulative food units across swimmers.',
    target: 6.0,
    unitLabel: 'food',
  },
  {
    id: 'mission_leaf_clear',
    kind: 'mission',
    biomeTag: 'leaf_droplet',
    title: 'Canopy Dew Bloom (Unlocks Frozen Ice)',
    description: 'In Forest Leaf Droplet: sustain 10+ photosynthetic swimmers at once.',
    target: 10,
    unitLabel: 'organisms',
  },
  {
    id: 'mission_ice_clear',
    kind: 'mission',
    biomeTag: 'frozen_ice',
    title: 'Cryo Lineage (Unlocks Cave)',
    description: 'Under Frozen Ice: breed a hardy Generation 3+ cold-water descendant.',
    target: 3,
    unitLabel: 'gen',
  },
  {
    id: 'mission_cave_clear',
    kind: 'mission',
    biomeTag: 'cave',
    title: 'Abyssal Mastery',
    description: 'In Bioluminescent Cave: thrive with 12+ dark-water organisms.',
    target: 12,
    unitLabel: 'organisms',
  },

  // Core Morphogenesis & Chemotaxis Missions
  {
    id: 'mission_embryo_iou',
    kind: 'mission',
    title: 'Embryo Architect',
    description: 'Grow an organism in the Blueprint Designer to 85% shape fidelity IoU.',
    target: 85,
    unitLabel: '% IoU',
  },
  {
    id: 'mission_chemotaxis_forager',
    kind: 'mission',
    title: 'Chemotactic Hunter',
    description: 'Have a single world organism consume 2.5 food pellet units via AR-ResNet steering.',
    target: 2.5,
    unitLabel: 'pellets',
  },
  {
    id: 'mission_mitotic_split',
    kind: 'mission',
    title: 'Mitotic Cleavage',
    description: 'Split an organism into drifting same-colony pieces using crush stress or the scalpel.',
    target: 1,
    unitLabel: 'splits',
  },
  {
    id: 'mission_tissue_triad',
    kind: 'mission',
    title: 'Motorized Chimera',
    description: 'Compile a custom blueprint containing Sensor, Muscle, and Flagella tissues.',
    target: 1,
    unitLabel: 'compiled',
  },

  // Achievements
  {
    id: 'ach_battle_breach',
    kind: 'achievement',
    title: 'Barrier Breaker',
    description: 'Reach colony strength threshold in Battle vs AI and shatter the central wall.',
    target: 1,
    unitLabel: 'breach',
  },
  {
    id: 'ach_battle_victor',
    kind: 'achievement',
    title: 'Apex Commander',
    description: 'Defeat the AI colony in Competitive Battle Mode to control the entire tank.',
    target: 1,
    unitLabel: 'wins',
  },
  {
    id: 'ach_custom_architect',
    kind: 'achievement',
    title: 'Genesis Compiler',
    description: 'Paint a custom organism blueprint or import an external silhouette image.',
    target: 1,
    unitLabel: 'compiled',
  },
  {
    id: 'ach_colony_reconnection',
    kind: 'achievement',
    title: 'Cellular Weaver',
    description: 'Observe two same-colony fragments reconnect cleanly through morphogenesis.',
    target: 1,
    unitLabel: 'fusions',
  },
  {
    id: 'ach_neural_maestro',
    kind: 'achievement',
    title: 'Neural Cruise Maestro',
    description: 'Observe all 4 AR-ResNet modes (seek, turn, coast, brake) across living swimmers.',
    target: 4,
    unitLabel: 'modes',
  },
  {
    id: 'ach_micro_surgeon',
    kind: 'achievement',
    title: 'Micro-Surgeon',
    description: 'Use the Scalpel tool 5 times to cleave tissue and trigger regeneration.',
    target: 5,
    unitLabel: 'cuts',
  },
  {
    id: 'ach_crowded_reef',
    kind: 'achievement',
    title: 'Crowded Reef',
    description: 'Maintain a dense population of 18+ concurrent organisms in the tank.',
    target: 18,
    unitLabel: 'organisms',
  },
  {
    id: 'ach_long_run',
    kind: 'achievement',
    title: 'Chronobiologist',
    description: 'Run the World Ecosystem past 1,500 simulation ticks.',
    target: 1500,
    unitLabel: 'ticks',
  },
];

export function createDefaultTracker(): ProgressionTracker {
  return {
    customBlueprintsCompiled: 0,
    imagesImported: 0,
    manualMatings: 0,
    scalpelHits: 0,
    foodDrops: 0,
    pokes: 0,
    designerCustomFullTriad: false,
    peakDesignerIou: 0,
    peakWorldOrganisms: 0,
    peakGeneration: 1,
    peakSingleFoodConsumed: 0,
    cumulativeWorldFood: 0,
    barrierBreaches: 0,
    battleVictories: 0,
    biomePeakPop: {
      pond: 0,
      tidepool: 0,
      leaf_droplet: 0,
      frozen_ice: 0,
      cave: 0,
    },
    biomeBestGen: {
      pond: 1,
      tidepool: 1,
      leaf_droplet: 1,
      frozen_ice: 1,
      cave: 1,
    },
    biomeFood: {
      pond: 0,
      tidepool: 0,
      leaf_droplet: 0,
      frozen_ice: 0,
      cave: 0,
    },
    observedModes: {
      seek: false,
      turn: false,
      coast: false,
      brake: false,
    },
    unlockedAt: {},
  };
}

export function loadProgressionTracker(): ProgressionTracker {
  const def = createDefaultTracker();
  try {
    if (typeof window === 'undefined' || !window.localStorage) return def;
    const raw = window.localStorage.getItem(PROGRESSION_STORAGE_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as Partial<ProgressionTracker>;
    return {
      ...def,
      ...parsed,
      biomePeakPop: { ...def.biomePeakPop, ...(parsed.biomePeakPop ?? {}) },
      biomeBestGen: { ...def.biomeBestGen, ...(parsed.biomeBestGen ?? {}) },
      biomeFood: { ...def.biomeFood, ...(parsed.biomeFood ?? {}) },
      observedModes: { ...def.observedModes, ...(parsed.observedModes ?? {}) },
      unlockedAt: { ...(parsed.unlockedAt ?? {}) },
    };
  } catch {
    return def;
  }
}

export function saveProgressionTracker(tracker: ProgressionTracker): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(PROGRESSION_STORAGE_KEY, JSON.stringify(tracker));
  } catch {
    // Ignore storage errors
  }
}

export function hasSensorMuscleFlagellaTriad(genome: CompiledGenome): boolean {
  const counts = genome.layers[0].tissueCounts;
  return (
    (counts[TissueType.SENSOR] ?? 0) > 0 &&
    (counts[TissueType.MUSCLE] ?? 0) > 0 &&
    (counts[TissueType.FLAGELLA] ?? 0) > 0
  );
}

export function isBiomeUnlocked(
  biomeId: BiomeId,
  items: ProgressionEvaluatedItem[],
): boolean {
  const def = BIOMES.find((b) => b.id === biomeId);
  if (!def || !def.unlockMissionId) return true;
  const req = items.find((i) => i.id === def.unlockMissionId);
  return req ? req.completed : false;
}

export function updateTrackerAndEvaluate(
  tracker: ProgressionTracker,
  world: WorldState,
  designerSim: SimState,
  designerGenome: CompiledGenome,
  isCustomBlueprint: boolean,
): {
  items: ProgressionEvaluatedItem[];
  newlyUnlocked: ProgressionEntryDef[];
} {
  if (designerSim.iouPercent > tracker.peakDesignerIou) {
    tracker.peakDesignerIou = designerSim.iouPercent;
  }
  if (isCustomBlueprint && hasSensorMuscleFlagellaTriad(designerGenome)) {
    tracker.designerCustomFullTriad = true;
  }

  const biome = world.biomeId;
  if (world.organisms.length > tracker.peakWorldOrganisms) {
    tracker.peakWorldOrganisms = world.organisms.length;
  }
  if (world.organisms.length > (tracker.biomePeakPop[biome] ?? 0)) {
    tracker.biomePeakPop[biome] = world.organisms.length;
  }

  if (world.battle.enabled && !world.battle.barrierActive) {
    tracker.barrierBreaches = Math.max(tracker.barrierBreaches, 1);
  }
  if (world.battle.enabled && world.battle.winner === 'player') {
    tracker.battleVictories = Math.max(tracker.battleVictories, 1);
  }

  let liveFoodSum = 0;
  for (let i = 0; i < world.organisms.length; i++) {
    const org = world.organisms[i];
    if (org.generation > tracker.peakGeneration) {
      tracker.peakGeneration = org.generation;
    }
    if (org.generation > (tracker.biomeBestGen[biome] ?? 1)) {
      tracker.biomeBestGen[biome] = org.generation;
    }
    if (org.consumedFood > tracker.peakSingleFoodConsumed) {
      tracker.peakSingleFoodConsumed = org.consumedFood;
    }
    if (org.simState.iouPercent > tracker.peakDesignerIou) {
      tracker.peakDesignerIou = org.simState.iouPercent;
    }
    liveFoodSum += org.consumedFood;
    tracker.observedModes[org.neuralNet.mode] = true;
  }

  if (liveFoodSum > tracker.cumulativeWorldFood) {
    tracker.cumulativeWorldFood = liveFoodSum;
  }
  if (liveFoodSum > (tracker.biomeFood[biome] ?? 0)) {
    tracker.biomeFood[biome] = liveFoodSum;
  }

  const modeCount =
    (tracker.observedModes.seek ? 1 : 0) +
    (tracker.observedModes.turn ? 1 : 0) +
    (tracker.observedModes.coast ? 1 : 0) +
    (tracker.observedModes.brake ? 1 : 0);

  // Pond requires 8 organisms AND a G2+ hybrid before marking complete
  const pondProgress =
    tracker.biomeBestGen.pond >= 2
      ? tracker.biomePeakPop.pond
      : Math.min(7, tracker.biomePeakPop.pond);

  const rawValues: Record<string, number> = {
    mission_pond_clear: pondProgress,
    mission_tidepool_clear: tracker.biomeFood.tidepool,
    mission_leaf_clear: tracker.biomePeakPop.leaf_droplet,
    mission_ice_clear: tracker.biomeBestGen.frozen_ice,
    mission_cave_clear: tracker.biomePeakPop.cave,

    mission_embryo_iou: tracker.peakDesignerIou,
    mission_chemotaxis_forager: tracker.peakSingleFoodConsumed,
    mission_mitotic_split: world.totalSplits,
    mission_tissue_triad: tracker.designerCustomFullTriad ? 1 : 0,

    ach_battle_breach: tracker.barrierBreaches,
    ach_battle_victor: tracker.battleVictories,
    ach_custom_architect: tracker.customBlueprintsCompiled + tracker.imagesImported,
    ach_colony_reconnection: world.totalReconnections,
    ach_neural_maestro: modeCount,
    ach_micro_surgeon: tracker.scalpelHits,
    ach_crowded_reef: tracker.peakWorldOrganisms,
    ach_long_run: world.worldTick,
  };

  const newlyUnlocked: ProgressionEntryDef[] = [];
  const now = Date.now();

  const items: ProgressionEvaluatedItem[] = PROGRESSION_CATALOG.map((def) => {
    const alreadyTime = tracker.unlockedAt[def.id] ?? null;
    const raw = rawValues[def.id] ?? 0;
    const current = Math.min(def.target, raw);
    const completed = alreadyTime !== null || raw >= def.target;

    if (completed && alreadyTime === null) {
      tracker.unlockedAt[def.id] = now;
      newlyUnlocked.push(def);
    }

    return {
      ...def,
      current: completed ? def.target : current,
      progressPct: completed ? 100 : Math.min(99, Math.round((current / def.target) * 100)),
      completed,
      unlockedAt: tracker.unlockedAt[def.id] ?? null,
    };
  });

  if (newlyUnlocked.length > 0) {
    saveProgressionTracker(tracker);
  }

  return { items, newlyUnlocked };
}
