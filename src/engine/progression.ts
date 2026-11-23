import {
  CompiledGenome,
  LocomotionMode,
  SimState,
  TissueType,
  WorldState,
} from '../types/morphogenesis';

export type ProgressionKind = 'mission' | 'achievement';

export interface ProgressionEntryDef {
  id: string;
  kind: ProgressionKind;
  title: string;
  description: string;
  target: number;
  unitLabel: string;
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
  observedModes: Record<LocomotionMode, boolean>;
  unlockedAt: Record<string, number>; // id -> timestamp
}

export interface ProgressionEvaluatedItem extends ProgressionEntryDef {
  current: number;
  progressPct: number;
  completed: boolean;
  unlockedAt: number | null;
}

export const PROGRESSION_STORAGE_KEY = 'morphograph_progress_v1';

export const PROGRESSION_CATALOG: ProgressionEntryDef[] = [
  // 6 Core Missions
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
    id: 'mission_hybrid_speciation',
    kind: 'mission',
    title: 'Hybrid Speciation',
    description: 'Recombine two directive graphs to produce a Generation 2+ hybrid organism.',
    target: 2,
    unitLabel: 'gen',
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
    id: 'mission_biome_bloom',
    kind: 'mission',
    title: 'Biosphere Bloom',
    description: 'Sustain 12 living organisms simultaneously in the Fluid Ecosystem.',
    target: 12,
    unitLabel: 'organisms',
  },
  {
    id: 'mission_tissue_triad',
    kind: 'mission',
    title: 'Motorized Chimera',
    description: 'Compile a custom blueprint containing Sensor, Muscle, and Flagella tissues.',
    target: 1,
    unitLabel: 'compiled',
  },

  // 8 Unlockable Achievements
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
    id: 'ach_apex_lineage',
    kind: 'achievement',
    title: 'Generation 3 Lineage',
    description: 'Breed a Generation 3 or higher multi-hybrid descendant.',
    target: 3,
    unitLabel: 'gen',
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
    id: 'ach_nutrient_feast',
    kind: 'achievement',
    title: 'Trophic Cascade',
    description: 'Track organisms harvesting 8.0 cumulative food units in the ecosystem.',
    target: 8,
    unitLabel: 'food',
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
    description: 'Run the World Ecosystem continuously past 1,500 simulation ticks.',
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
      observedModes: {
        ...def.observedModes,
        ...(parsed.observedModes ?? {}),
      },
      unlockedAt: {
        ...(parsed.unlockedAt ?? {}),
      },
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
    // Ignore storage quota or private-mode exceptions
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
  // Update live peaks from designer + world
  if (designerSim.iouPercent > tracker.peakDesignerIou) {
    tracker.peakDesignerIou = designerSim.iouPercent;
  }
  if (isCustomBlueprint && hasSensorMuscleFlagellaTriad(designerGenome)) {
    tracker.designerCustomFullTriad = true;
  }

  if (world.organisms.length > tracker.peakWorldOrganisms) {
    tracker.peakWorldOrganisms = world.organisms.length;
  }

  let liveFoodSum = 0;
  for (let i = 0; i < world.organisms.length; i++) {
    const org = world.organisms[i];
    if (org.generation > tracker.peakGeneration) {
      tracker.peakGeneration = org.generation;
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

  const modeCount =
    (tracker.observedModes.seek ? 1 : 0) +
    (tracker.observedModes.turn ? 1 : 0) +
    (tracker.observedModes.coast ? 1 : 0) +
    (tracker.observedModes.brake ? 1 : 0);

  const rawValues: Record<string, number> = {
    mission_embryo_iou: tracker.peakDesignerIou,
    mission_chemotaxis_forager: tracker.peakSingleFoodConsumed,
    mission_hybrid_speciation: tracker.peakGeneration,
    mission_mitotic_split: world.totalSplits,
    mission_biome_bloom: tracker.peakWorldOrganisms,
    mission_tissue_triad: tracker.designerCustomFullTriad ? 1 : 0,

    ach_custom_architect: tracker.customBlueprintsCompiled + tracker.imagesImported,
    ach_colony_reconnection: world.totalReconnections,
    ach_neural_maestro: modeCount,
    ach_apex_lineage: tracker.peakGeneration,
    ach_micro_surgeon: tracker.scalpelHits,
    ach_nutrient_feast: tracker.cumulativeWorldFood,
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
