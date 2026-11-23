import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Award,
  CheckCircle2,
  Lock,
  Music,
  Paintbrush,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  StepForward,
  Swords,
  Target,
  Volume2,
  VolumeX,
  Wrench,
  X,
} from 'lucide-react';
import { BlueprintCanvas } from './components/BlueprintCanvas';
import { DesignerControlsPanel } from './components/DesignerControlsPanel';
import { DirectiveGraph3D } from './components/DirectiveGraph3D';
import { MipmapPyramidStrip } from './components/MipmapPyramidStrip';
import { MissionsPanel } from './components/MissionsPanel';
import { OrganismSideTab } from './components/OrganismSideTab';
import { ResNetEditorPanel } from './components/ResNetEditorPanel';
import { SimulationCanvas } from './components/SimulationCanvas';
import { TelemetryCharts } from './components/TelemetryCharts';
import { WorldCanvas } from './components/WorldCanvas';
import { WorldControlsPanel } from './components/WorldControlsPanel';
import { BIOMES, getBiomeDef } from './engine/biomes';
import { compileBlueprintToGenome } from './engine/compiler';
import { createDefaultNeuralConfig, extractNeuralConfigFromState } from './engine/neuralNet';
import { ORGANISM_PRESETS } from './engine/presets';
import {
  ProgressionEntryDef,
  ProgressionEvaluatedItem,
  ProgressionTracker,
  createDefaultTracker,
  isBiomeUnlocked,
  loadProgressionTracker,
  saveProgressionTracker,
  updateTrackerAndEvaluate,
} from './engine/progression';
import { createSimState, injureSimulation, stepSimulation } from './engine/simulator';
import { soundEngine } from './engine/soundEngine';
import { syncOrganismMeshFromSimState } from './engine/softBodyPhysics';
import {
  DEFAULT_WORLD_PARAMS,
  createInitialWorld,
  depositChemical,
  injureWorldOrganism,
  mateOrganisms,
  pokeWorldMesh,
  spawnOrganismFromFood,
  spawnOrganismInWorld,
  stepWorldSimulation,
} from './engine/worldSim';
import {
  ACTIVE_TISSUE_TYPES,
  BASE_DIM,
  BiomeId,
  BrushTool,
  CompiledGenome,
  GrowthMode,
  InspectedCell,
  MipLevel,
  NeuralBlueprintConfig,
  SimParams,
  SimState,
  TISSUE_SPECS,
  TissueType,
  WorldOrganism,
  WorldParams,
  WorldState,
  WorldTool,
} from './types/morphogenesis';

const DEFAULT_SIM_PARAMS: SimParams = {
  growthMode: 'mipmap',
  subdivisionDelay: 4,
  lateralDelay: 1,
  divisionCost: 0.28,
  nutrientDensity: 0.85,
  vascularBoost: 1.2,
  stagedWaves: true,
  legacyNodeCap: 0,
};

type WorkspaceView = 'world' | 'designer' | 'missions';
type MobileSheet = 'none' | 'tools' | 'physics' | 'inspector';

export default function App() {
  const [view, setView] = useState<WorkspaceView>('world');
  const [mobileSheet, setMobileSheet] = useState<MobileSheet>('none');

  // Biome, Battle Mode & Audio state
  const [activeBiomeId, setActiveBiomeId] = useState<BiomeId>('pond');
  const [battleMode, setBattleMode] = useState<boolean>(false);
  const [sfxEnabled, setSfxEnabled] = useState<boolean>(true);
  const [musicEnabled, setMusicEnabled] = useState<boolean>(false);

  // Designer / Standalone Morphogenesis state
  const [selectedPresetId, setSelectedPresetId] = useState<string>(ORGANISM_PRESETS[0].id);
  const [neuralConfig, setNeuralConfig] = useState<NeuralBlueprintConfig>(() =>
    createDefaultNeuralConfig(),
  );
  const [blueprint, setBlueprint] = useState<Uint8Array>(() =>
    ORGANISM_PRESETS[0].generate(BASE_DIM),
  );
  const [genome, setGenome] = useState<CompiledGenome>(() =>
    compileBlueprintToGenome(
      ORGANISM_PRESETS[0].generate(BASE_DIM),
      createDefaultNeuralConfig(),
    ),
  );
  const [simParams, setSimParams] = useState<SimParams>(DEFAULT_SIM_PARAMS);
  const [simState, setSimState] = useState<SimState>(() =>
    createSimState(compileBlueprintToGenome(ORGANISM_PRESETS[0].generate(BASE_DIM)), DEFAULT_SIM_PARAMS),
  );
  const [designerPlaying, setDesignerPlaying] = useState<boolean>(true);
  const [designerTps, setDesignerTps] = useState<number>(12);
  const [activeTool, setActiveTool] = useState<BrushTool>('muscle');
  const [brushSize, setBrushSize] = useState<number>(3);
  const [inspectLevel, setInspectLevel] = useState<MipLevel>(0);
  const [graphFilterLevel, setGraphFilterLevel] = useState<MipLevel | 'all'>('all');
  const [showLevelSet, setShowLevelSet] = useState<boolean>(true);
  const [showNutrients, setShowNutrients] = useState<boolean>(true);
  const [showDirectives, setShowDirectives] = useState<boolean>(false);
  const [showTargetGhost, setShowTargetGhost] = useState<boolean>(false);
  const [inspectedCell, setInspectedCell] = useState<InspectedCell | null>(null);

  // World Simulation state stored in a mutable ref so 30Hz physics never triggers React DOM diffing
  const worldRef = useRef<WorldState>(null!);
  if (!worldRef.current) {
    worldRef.current = createInitialWorld(DEFAULT_SIM_PARAMS, 'pond', false);
  }
  const [, setHudVersion] = useState<number>(0);
  const [renderEpoch, setRenderEpoch] = useState<number>(0);
  const hudTickCounterRef = useRef<number>(0);
  const prevBarrierActiveRef = useRef<boolean>(worldRef.current.battle.barrierActive);
  const prevBattleWinnerRef = useRef<WorldState['battle']['winner']>(worldRef.current.battle.winner);

  const [worldParams, setWorldParams] = useState<WorldParams>(DEFAULT_WORLD_PARAMS);
  const [worldPlaying, setWorldPlaying] = useState<boolean>(true);
  const [worldTool, setWorldTool] = useState<WorldTool>('select');
  const [selectedOrgId, setSelectedOrgId] = useState<number | null>(null);
  const [showChemFields, setShowChemFields] = useState<boolean>(true);
  const [showGradientArrows, setShowGradientArrows] = useState<boolean>(false);
  const [showPhysicsMesh, setShowPhysicsMesh] = useState<boolean>(false);
  const [spawnSourceId, setSpawnSourceId] = useState<string>(ORGANISM_PRESETS[0].id);

  // Progression (Missions & Achievements)
  const trackerRef = useRef<ProgressionTracker>(loadProgressionTracker());
  const [progressionItems, setProgressionItems] = useState<ProgressionEvaluatedItem[]>(() => {
    const initial = updateTrackerAndEvaluate(
      trackerRef.current,
      worldRef.current,
      simState,
      genome,
      false,
    );
    return initial.items;
  });
  const [toastItem, setToastItem] = useState<ProgressionEntryDef | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [spawnNotice, setSpawnNotice] = useState<string | null>(null);
  const spawnNoticeTimerRef = useRef<number | null>(null);

  const showSpawnNotice = useCallback((msg: string) => {
    setSpawnNotice(msg);
    if (spawnNoticeTimerRef.current !== null) {
      window.clearTimeout(spawnNoticeTimerRef.current);
    }
    spawnNoticeTimerRef.current = window.setTimeout(() => {
      setSpawnNotice(null);
    }, 3600);
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Mutable refs for smooth animation loops
  const simStateRef = useRef(simState);
  simStateRef.current = simState;
  const genomeRef = useRef(genome);
  genomeRef.current = genome;
  const simParamsRef = useRef(simParams);
  simParamsRef.current = simParams;
  const blueprintRef = useRef(blueprint);
  blueprintRef.current = blueprint;

  const worldParamsRef = useRef(worldParams);
  worldParamsRef.current = worldParams;
  const selectedPresetIdRef = useRef(selectedPresetId);
  selectedPresetIdRef.current = selectedPresetId;
  const neuralConfigRef = useRef(neuralConfig);
  neuralConfigRef.current = neuralConfig;
  const selectedOrgIdRef = useRef(selectedOrgId);
  selectedOrgIdRef.current = selectedOrgId;

  const syncAdaptiveSound = useCallback((w: WorldState) => {
    let totalFood = 0;
    for (let i = 0; i < w.pellets.length; i++) {
      totalFood += w.pellets[i].amount;
    }
    let amorousCount = 0;
    for (let i = 0; i < w.organisms.length; i++) {
      if (w.organisms[i].mood === 'amorous') {
        amorousCount++;
      }
    }
    soundEngine.updateAdaptiveContext({
      biomeId: w.biomeId,
      organismCount: w.organisms.length,
      totalFood,
      amorousCount,
      battleEnabled: w.battle.enabled,
      barrierActive: w.battle.barrierActive,
    });
  }, []);

  const triggerProgressionEval = useCallback(() => {
    const { items, newlyUnlocked } = updateTrackerAndEvaluate(
      trackerRef.current,
      worldRef.current,
      simStateRef.current,
      genomeRef.current,
      selectedPresetIdRef.current === 'custom',
    );
    setProgressionItems(items);
    if (newlyUnlocked.length > 0) {
      setToastItem(newlyUnlocked[0]);
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => {
        setToastItem(null);
      }, 4500);
    }
  }, []);

  const compileAndResetDesigner = useCallback(
    (
      nextBlueprint: Uint8Array,
      nextParams: SimParams = simParamsRef.current,
      nextNeuralConfig: NeuralBlueprintConfig = neuralConfigRef.current,
    ) => {
      const compiled = compileBlueprintToGenome(nextBlueprint, nextNeuralConfig);
      const freshSim = createSimState(compiled, nextParams);
      setGenome(compiled);
      setSimState(freshSim);
      genomeRef.current = compiled;
      simStateRef.current = freshSim;
    },
    [],
  );

  const handleNeuralConfigChange = useCallback(
    (nextCfg: NeuralBlueprintConfig) => {
      setNeuralConfig(nextCfg);
      neuralConfigRef.current = nextCfg;
      const recompiled = compileBlueprintToGenome(blueprintRef.current, nextCfg);
      setGenome(recompiled);
      genomeRef.current = recompiled;
      setSpawnSourceId('designer');
    },
    [],
  );

  // Sync audio toggles & initial biome adaptive music profile
  useEffect(() => {
    soundEngine.setSfxEnabled(sfxEnabled);
  }, [sfxEnabled]);

  useEffect(() => {
    soundEngine.setMusicEnabled(musicEnabled);
    syncAdaptiveSound(worldRef.current);
  }, [musicEnabled, syncAdaptiveSound]);

  useEffect(() => {
    soundEngine.setBattleMode(battleMode);
    syncAdaptiveSound(worldRef.current);
  }, [battleMode, syncAdaptiveSound]);

  const world = worldRef.current;
  const spawnLockedByBreach = world.battle.enabled && !world.battle.barrierActive;

  // If the battle barrier breaks while spawn tool is active, revert tool to Select cleanly
  useEffect(() => {
    if (spawnLockedByBreach && worldTool === 'spawn') {
      setWorldTool('select');
    }
  }, [spawnLockedByBreach, worldTool]);

  const bumpWorldVisuals = useCallback(
    (runProgression = false) => {
      const w = worldRef.current;
      prevBarrierActiveRef.current = w.battle.barrierActive;
      prevBattleWinnerRef.current = w.battle.winner;
      setRenderEpoch((e) => e + 1);
      setHudVersion((v) => v + 1);
      if (runProgression) {
        triggerProgressionEval();
      }
    },
    [triggerProgressionEval],
  );

  // Invoked by WorldCanvas after each 30Hz physics tick; throttles React HUD sync to ~4 Hz
  const handleWorldSimulationTicked = useCallback(() => {
    const w = worldRef.current;
    if (w.soundEvents.length > 0) {
      soundEngine.playEvents(w.soundEvents);
      w.soundEvents.length = 0;
    }

    hudTickCounterRef.current += 1;
    if (hudTickCounterRef.current % 4 === 0) {
      syncAdaptiveSound(w);
    }

    const barrierFlipped = w.battle.barrierActive !== prevBarrierActiveRef.current;
    const winnerChanged = w.battle.winner !== prevBattleWinnerRef.current;
    const inspectedMissing =
      selectedOrgIdRef.current !== null &&
      !w.organisms.some((o) => o.id === selectedOrgIdRef.current);

    if (
      barrierFlipped ||
      winnerChanged ||
      inspectedMissing ||
      hudTickCounterRef.current % 8 === 0
    ) {
      prevBarrierActiveRef.current = w.battle.barrierActive;
      prevBattleWinnerRef.current = w.battle.winner;
      setHudVersion((v) => v + 1);
      triggerProgressionEval();
    }
  }, [syncAdaptiveSound, triggerProgressionEval]);

  // Designer Standalone Simulation loop
  useEffect(() => {
    if (view !== 'designer' || !designerPlaying) return;
    const intervalMs = Math.max(16, Math.round(1000 / designerTps));
    let evalCounter = 0;
    const timer = window.setInterval(() => {
      const curr = simStateRef.current;
      stepSimulation(curr, genomeRef.current, simParamsRef.current);
      setSimState({
        ...curr,
        history: [...curr.history],
      });
      evalCounter++;
      if (evalCounter % 4 === 0) {
        triggerProgressionEval();
      }
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [view, designerPlaying, designerTps, triggerProgressionEval]);

  const selectedOrganism =
    selectedOrgId !== null ? world.organisms.find((o) => o.id === selectedOrgId) ?? null : null;

  let canMateSelected = false;
  if (!world.battle.enabled) {
    canMateSelected = world.organisms.length >= 2;
  } else {
    let playerOrgCount = 0;
    for (let i = 0; i < world.organisms.length; i++) {
      if (world.organisms[i].faction === 'player') {
        playerOrgCount++;
        if (playerOrgCount >= 2) {
          canMateSelected = true;
          break;
        }
      }
    }
  }

  const completedCount = useMemo(
    () => progressionItems.filter((i) => i.completed).length,
    [progressionItems],
  );

  const activeBiomeDef = useMemo(() => getBiomeDef(activeBiomeId), [activeBiomeId]);

  const switchBiomeOrMode = (nextBiome: BiomeId, nextBattle: boolean) => {
    setActiveBiomeId(nextBiome);
    setBattleMode(nextBattle);
    const fresh = createInitialWorld(simParamsRef.current, nextBiome, nextBattle);
    worldRef.current = fresh;
    hudTickCounterRef.current = 0;
    setSelectedOrgId(null);
    setMobileSheet('none');
    setSpawnNotice(null);
    setWorldPlaying(true);
    syncAdaptiveSound(fresh);
    soundEngine.triggerUiSound('spawn');
    bumpWorldVisuals(true);
  };

  // World Actions
  const getBlueprintForSpawn = useCallback((): {
    genome: CompiledGenome;
    name: string;
    presetId: string;
  } => {
    if (spawnSourceId === 'designer') {
      return {
        genome: genomeRef.current,
        name:
          ORGANISM_PRESETS.find((p) => p.id === selectedPresetId)?.name ?? 'Custom Organism',
        presetId: selectedPresetId,
      };
    }
    const preset = ORGANISM_PRESETS.find((p) => p.id === spawnSourceId) ?? ORGANISM_PRESETS[0];
    return {
      genome: compileBlueprintToGenome(preset.generate(BASE_DIM)),
      name: preset.name,
      presetId: preset.id,
    };
  }, [spawnSourceId, selectedPresetId]);

  const handleSpawnAt = useCallback(
    (x: number, y: number) => {
      const w = worldRef.current;
      if (w.battle.enabled && !w.battle.barrierActive) {
        showSpawnNotice('Spawning is disabled once the battle containment barrier has broken.');
        return;
      }
      const src = getBlueprintForSpawn();
      const faction = w.battle.enabled ? 'player' : 'neutral';
      const res = spawnOrganismFromFood(
        w,
        src.genome,
        src.name,
        src.presetId,
        simParamsRef.current,
        faction,
        x,
        y,
        2,
      );
      if (!res.organism) {
        showSpawnNotice(
          res.reason === 'barrier_broken'
            ? 'Spawning is disabled once the battle containment barrier has broken.'
            : 'No food pellets available on your side to fuel spawning.',
        );
        return;
      }
      setSpawnNotice(null);
      syncAdaptiveSound(w);
      soundEngine.triggerUiSound('spawn');
      bumpWorldVisuals(true);
    },
    [getBlueprintForSpawn, showSpawnNotice, syncAdaptiveSound, bumpWorldVisuals],
  );

  const handlePrimarySpawnButton = () => {
    const w = worldRef.current;
    if (w.battle.enabled && !w.battle.barrierActive) {
      showSpawnNotice('Spawning is disabled once the battle containment barrier has broken.');
      return;
    }
    const faction = w.battle.enabled ? 'player' : 'neutral';

    if (view === 'designer') {
      const name =
        selectedPresetId === 'custom'
          ? 'Custom Organism'
          : ORGANISM_PRESETS.find((p) => p.id === selectedPresetId)?.name ?? 'Custom Organism';
      const res = spawnOrganismFromFood(
        w,
        genomeRef.current,
        name,
        selectedPresetId,
        simParamsRef.current,
        faction,
        undefined,
        undefined,
        2,
      );
      setView('world');
      setMobileSheet('none');
      setWorldPlaying(true);
      if (!res.organism) {
        showSpawnNotice(
          res.reason === 'barrier_broken'
            ? 'Spawning is disabled once the battle containment barrier has broken.'
            : 'No food pellets available on your side to fuel spawning.',
        );
        return;
      }
      setSpawnNotice(null);
    } else {
      const src = getBlueprintForSpawn();
      const res = spawnOrganismFromFood(
        w,
        src.genome,
        src.name,
        src.presetId,
        simParamsRef.current,
        faction,
        undefined,
        undefined,
        2,
      );
      if (!res.organism) {
        showSpawnNotice(
          res.reason === 'barrier_broken'
            ? 'Spawning is disabled once the battle containment barrier has broken.'
            : 'No food pellets available on your side to fuel spawning.',
        );
        return;
      }
      setSpawnNotice(null);
      if (view === 'missions') {
        setView('world');
      }
    }
    syncAdaptiveSound(w);
    soundEngine.triggerUiSound('spawn');
    bumpWorldVisuals(true);
  };

  const handleDropChemical = useCallback(
    (kind: 'food' | 'toxin', x: number, y: number) => {
      const w = worldRef.current;
      if (kind === 'food') {
        depositChemical(w.foodField, x, y, 0.35, 3);
        trackerRef.current.foodDrops += 1;
      } else {
        depositChemical(w.toxinField, x, y, 0.42, 3);
      }
      setRenderEpoch((e) => e + 1);
    },
    [],
  );

  const handlePoke = useCallback((x: number, y: number, dvx: number, dvy: number) => {
    const w = worldRef.current;
    pokeWorldMesh(w, x, y, dvx, dvy, 38, w.battle.enabled);
    trackerRef.current.pokes += 1;
    setRenderEpoch((e) => e + 1);
  }, []);

  const handleInjureWorld = useCallback(
    (x: number, y: number) => {
      const w = worldRef.current;
      if (injureWorldOrganism(w, x, y, 18, w.battle.enabled)) {
        trackerRef.current.scalpelHits += 1;
        saveProgressionTracker(trackerRef.current);
        soundEngine.triggerUiSound('rupture');
        bumpWorldVisuals(true);
      }
    },
    [bumpWorldVisuals],
  );

  // Per-organism Side Tab actions
  const handleEditOrganismInDesigner = (org: WorldOrganism) => {
    setSelectedPresetId(org.presetId);
    const bp = new Uint8Array(org.genome.blueprint);
    const extractedCfg = org.genome.neuralConfig ?? extractNeuralConfigFromState(org.neuralNet);
    setNeuralConfig(extractedCfg);
    neuralConfigRef.current = extractedCfg;
    setBlueprint(bp);
    compileAndResetDesigner(bp, org.params, extractedCfg);
    setSpawnSourceId('designer');
    setMobileSheet('none');
    setView('designer');
  };

  const handleCloneOrganism = (org: WorldOrganism) => {
    const w = worldRef.current;
    if (org.energyReserve < 36) {
      showSpawnNotice('Organism needs at least 36% ATP to divide cleanly without free energy.');
      return;
    }
    const maxX = w.battle.enabled && org.faction === 'player' ? w.battle.barrierX - 42 : w.width - 70;
    const minX = w.battle.enabled && org.faction === 'ai' ? w.battle.barrierX + 42 : 70;
    const daughterEnergy = org.energyReserve * 0.48;
    org.energyReserve = org.energyReserve * 0.52;

    const cloned = spawnOrganismInWorld(
      w,
      org.genome,
      org.name,
      org.presetId,
      org.params,
      Math.min(maxX, Math.max(minX, org.mesh.comX + 65)),
      Math.min(w.height - 70, Math.max(70, org.mesh.comY + 45)),
      org.mesh.headingAngle + 0.5,
      1,
      org.generation,
      org.parentIds,
      undefined,
      org.faction,
      daughterEnergy,
    );
    setSelectedOrgId(cloned.id);
    soundEngine.triggerUiSound('spawn');
    bumpWorldVisuals(true);
  };

  const handleResetOrganismSeed = (orgId: number) => {
    const w = worldRef.current;
    const org = w.organisms.find((o) => o.id === orgId);
    if (!org) return;
    org.simState = createSimState(org.genome, org.params);
    org.mesh.lastSyncedTick = -1;
    syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
    bumpWorldVisuals(false);
  };

  const handleRemoveOrganism = (orgId: number) => {
    const w = worldRef.current;
    w.organisms = w.organisms.filter((o) => o.id !== orgId);
    if (selectedOrgId === orgId) {
      const next = w.organisms.find((o) => (!w.battle.enabled || o.faction === 'player'));
      setSelectedOrgId(next?.id ?? null);
      if (mobileSheet === 'inspector') {
        setMobileSheet('none');
      }
    }
    bumpWorldVisuals(false);
  };

  const handleInjureOrganismCell = (orgId: number, px: number, py: number) => {
    const w = worldRef.current;
    const org = w.organisms.find((o) => o.id === orgId);
    if (!org) return;
    injureSimulation(org.simState, org.genome, px, py, 7);
    syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
    trackerRef.current.scalpelHits += 1;
    saveProgressionTracker(trackerRef.current);
    soundEngine.triggerUiSound('rupture');
    bumpWorldVisuals(true);
  };

  const handleMateOrganism = (org: WorldOrganism) => {
    const w = worldRef.current;
    const candidates = w.organisms.filter(
      (o) => o.id !== org.id && (!w.battle.enabled || o.faction === org.faction),
    );
    if (candidates.length === 0) return;

    let best = candidates[0];
    let bestScore = Infinity;
    for (const c of candidates) {
      const dist = Math.hypot(c.mesh.comX - org.mesh.comX, c.mesh.comY - org.mesh.comY);
      const sameBonus = c.presetId !== org.presetId ? 0.72 : 1.0;
      const score = dist * sameBonus;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }

    const baby = mateOrganisms(w, org, best, simParamsRef.current);
    if (w.soundEvents.length > 0) {
      soundEngine.playEvents(w.soundEvents);
      w.soundEvents.length = 0;
    }
    trackerRef.current.manualMatings += 1;
    saveProgressionTracker(trackerRef.current);
    setSelectedOrgId(baby.id);
    bumpWorldVisuals(true);
  };

  // Designer Handlers
  const handleSelectPreset = (presetId: string) => {
    const preset = ORGANISM_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setSelectedPresetId(presetId);
    selectedPresetIdRef.current = presetId;
    const nextBp = preset.generate(BASE_DIM);
    setBlueprint(nextBp);
    compileAndResetDesigner(nextBp, simParamsRef.current);
    setDesignerPlaying(true);
  };

  const handleClearBlueprint = () => {
    setSelectedPresetId('custom');
    selectedPresetIdRef.current = 'custom';
    const empty = new Uint8Array(BASE_DIM * BASE_DIM);
    setBlueprint(empty);
    compileAndResetDesigner(empty, simParamsRef.current);
    setDesignerPlaying(false);
  };

  const handlePaint = useCallback(
    (points: Array<{ x: number; y: number }>, tissue: TissueType, radius: number) => {
      setSelectedPresetId('custom');
      selectedPresetIdRef.current = 'custom';
      setSpawnSourceId('designer');
      setBlueprint((prev) => {
        const next = new Uint8Array(prev);
        const r2 = radius * radius;
        for (const pt of points) {
          const minX = Math.max(0, Math.floor(pt.x - radius));
          const maxX = Math.min(BASE_DIM - 1, Math.ceil(pt.x + radius));
          const minY = Math.max(0, Math.floor(pt.y - radius));
          const maxY = Math.min(BASE_DIM - 1, Math.ceil(pt.y + radius));
          for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
              if ((x - pt.x) ** 2 + (y - pt.y) ** 2 <= r2) {
                next[y * BASE_DIM + x] = tissue;
              }
            }
          }
        }
        blueprintRef.current = next;
        return next;
      });
    },
    [],
  );

  const handleFinishStroke = useCallback(() => {
    compileAndResetDesigner(blueprintRef.current, simParamsRef.current);
    trackerRef.current.customBlueprintsCompiled += 1;
    saveProgressionTracker(trackerRef.current);
    triggerProgressionEval();
  }, [compileAndResetDesigner, triggerProgressionEval]);

  const handleInjureDesigner = useCallback(
    (px: number, py: number, radius: number) => {
      const curr = simStateRef.current;
      injureSimulation(curr, genomeRef.current, px, py, radius);
      trackerRef.current.scalpelHits += 1;
      saveProgressionTracker(trackerRef.current);
      setSimState({
        ...curr,
        history: [...curr.history],
      });
      triggerProgressionEval();
    },
    [triggerProgressionEval],
  );

  const handleModeChange = (mode: GrowthMode) => {
    const nextParams = { ...simParams, growthMode: mode };
    setSimParams(nextParams);
    setSimState(createSimState(genomeRef.current, nextParams));
    setDesignerPlaying(true);
  };

  const handleImportImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const off = document.createElement('canvas');
      off.width = BASE_DIM;
      off.height = BASE_DIM;
      const ctx = off.getContext('2d')!;
      ctx.clearRect(0, 0, BASE_DIM, BASE_DIM);
      const pad = 8;
      const avail = BASE_DIM - pad * 2;
      const scale = Math.min(avail / img.width, avail / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (BASE_DIM - dw) / 2, (BASE_DIM - dh) / 2, dw, dh);

      const data = ctx.getImageData(0, 0, BASE_DIM, BASE_DIM).data;
      const cornerLum = (data[0] + data[1] + data[2]) / 3;
      const cornerAlpha = data[3];
      const lightBg = cornerAlpha > 200 && cornerLum > 200;

      const nextBp = new Uint8Array(BASE_DIM * BASE_DIM);
      for (let i = 0; i < BASE_DIM * BASE_DIM; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const a = data[i * 4 + 3];
        if (a < 64) continue;
        const lum = (r + g + b) / 3;
        if (lightBg && lum > 220) continue;
        if (!lightBg && lum < 30 && cornerAlpha > 200) continue;

        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const sat = maxC > 0 ? (maxC - minC) / maxC : 0;

        if (sat < 0.18 && lum > 185) {
          nextBp[i] = TissueType.SPIKE;
        } else if (sat < 0.22) {
          nextBp[i] = TissueType.MESODERM;
        } else if (r > 185 && g > 85 && g < 165 && b < 90) {
          nextBp[i] = TissueType.DIGESTIVE;
        } else if (g > 140 && b > 140 && r < 95) {
          nextBp[i] = TissueType.EXCRETORY;
        } else if (r > g * 1.25 && b > g * 1.2) {
          nextBp[i] = TissueType.MUSCLE;
        } else if (r > g * 1.35 && r > b * 1.35) {
          nextBp[i] = TissueType.VASCULAR;
        } else if (g > b * 1.25 && r > 120) {
          nextBp[i] = TissueType.SENSOR;
        } else if (b > r * 1.2 && g < 150) {
          nextBp[i] = TissueType.FLAGELLA;
        } else if (b > r * 1.25 && b >= g * 0.9) {
          nextBp[i] = TissueType.NEURAL;
        } else if (g > r * 1.15 && g > b * 1.15) {
          nextBp[i] = TissueType.EPIDERMIS;
        } else {
          nextBp[i] = TissueType.MESODERM;
        }
      }

      URL.revokeObjectURL(url);
      setSelectedPresetId('custom');
      selectedPresetIdRef.current = 'custom';
      setSpawnSourceId('designer');
      setBlueprint(nextBp);
      compileAndResetDesigner(nextBp, simParamsRef.current);
      setDesignerPlaying(true);
      trackerRef.current.imagesImported += 1;
      saveProgressionTracker(trackerRef.current);
      triggerProgressionEval();
    };
    img.src = url;
    e.target.value = '';
  };

  const handleResetProgression = () => {
    trackerRef.current = createDefaultTracker();
    saveProgressionTracker(trackerRef.current);
    triggerProgressionEval();
    if (!isBiomeUnlocked(activeBiomeId, progressionItems)) {
      switchBiomeOrMode('pond', battleMode);
    }
  };

  const phaseLabel = useMemo(() => {
    if (simParams.growthMode === 'legacy') {
      return 'Legacy Single-Grid Mode · Dense L0 outward gather';
    }
    if (
      simState.layers[0].activeCount >= genome.layers[0].activeCount * 0.95 &&
      genome.layers[0].activeCount > 0
    ) {
      return 'Mature Organism · All 4 mipmap resolution levels differentiated';
    }
    switch (simState.activeWaveLevel) {
      case 3:
        return 'Phase 1 · Sparse L3 Macro-Scaffold dividing at stride 8';
      case 2:
        return 'Phase 2 · L2 Organ Domains subdividing from coarse progenitors';
      case 1:
        return 'Phase 3 · L1 Tissue Architecture refining boundaries & vessels';
      default:
        return 'Phase 4 · L0 Full Cellular Resolution completing specialized tissues';
    }
  }, [simParams.growthMode, simState.activeWaveLevel, simState.layers, genome.layers]);

  return (
    <div className="min-h-screen bg-[#090C12] text-slate-100 flex flex-col pb-16 lg:pb-0">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleImportImage}
        className="hidden"
      />

      {/* 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 sm:gap-6 border-b border-slate-800 bg-[#090C12]/95 px-3 sm:px-6 py-2.5 sm:py-3.5 backdrop-blur-sm">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setView('world');
            setMobileSheet('none');
          }}
          className="text-base sm:text-lg font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          MorphoGraph
        </a>

        <nav className="flex items-center gap-3 sm:gap-6 text-xs sm:text-sm font-medium">
          <button
            type="button"
            onClick={() => {
              setView('world');
              setMobileSheet('none');
            }}
            className={`pb-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              view === 'world'
                ? 'border-cyan-400 text-slate-100'
                : 'border-transparent text-slate-400 hover:text-slate-100'
            }`}
          >
            <span className="sm:hidden">World</span>
            <span className="hidden sm:inline">World Ecosystem</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setView('designer');
              setMobileSheet('none');
            }}
            className={`pb-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              view === 'designer'
                ? 'border-cyan-400 text-slate-100'
                : 'border-transparent text-slate-400 hover:text-slate-100'
            }`}
          >
            <span className="sm:hidden">Designer</span>
            <span className="hidden sm:inline">Blueprint Designer</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setView('missions');
              setMobileSheet('none');
            }}
            className={`flex items-center gap-1.5 pb-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              view === 'missions'
                ? 'border-cyan-400 text-slate-100'
                : 'border-transparent text-slate-400 hover:text-slate-100'
            }`}
          >
            <span>Missions</span>
            <span className="font-mono text-[11px] tabular-nums text-cyan-300">
              {completedCount}/{progressionItems.length}
            </span>
          </button>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            disabled={spawnLockedByBreach}
            onClick={handlePrimarySpawnButton}
            title={
              spawnLockedByBreach
                ? 'Spawning is locked after the battle containment barrier breaks'
                : 'Consume food on your side to spawn organism'
            }
            className="min-h-[38px] sm:min-h-0 rounded-lg bg-cyan-500 px-3 sm:px-4 py-1.5 sm:py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <span className="sm:hidden">
              {spawnLockedByBreach ? 'Locked' : 'Spawn'}
            </span>
            <span className="hidden sm:inline">
              {spawnLockedByBreach
                ? 'Spawn Locked (Breach)'
                : view === 'designer'
                  ? 'Spawn in World'
                  : 'Spawn Organism'}
            </span>
          </button>
        </div>
      </header>

      {view === 'missions' ? (
        <MissionsPanel items={progressionItems} onResetProgress={handleResetProgression} />
      ) : view === 'world' ? (
        /* WORLD ECOSYSTEM VIEW + PER-ORGANISM SIDE TAB */
        <div className="mx-auto flex w-full max-w-[1680px] flex-1 flex-col lg:flex-row">
          {/* Desktop Left World Physics & Gradient Control Column */}
          <aside className="hidden lg:block w-[290px] shrink-0 border-r border-slate-800 bg-[#0D111A] p-4">
            <WorldControlsPanel
              worldTool={worldTool}
              spawnLockedByBreach={spawnLockedByBreach}
              spawnSourceId={spawnSourceId}
              showChemFields={showChemFields}
              showGradientArrows={showGradientArrows}
              showPhysicsMesh={showPhysicsMesh}
              worldParams={worldParams}
              onSelectTool={setWorldTool}
              onChangeSpawnSource={setSpawnSourceId}
              onToggleChemFields={setShowChemFields}
              onToggleGradientArrows={setShowGradientArrows}
              onTogglePhysicsMesh={setShowPhysicsMesh}
              onChangeWorldParams={setWorldParams}
            />
          </aside>

          {/* Center Fluid World Stage */}
          <main className="order-1 lg:order-2 flex-1 min-w-0 p-3 sm:p-4 lg:p-6 space-y-3.5">
            {/* Biome Area Switcher + Audio / Battle Mode Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-800/80 pb-3">
              {/* 5 Aquatic Biomes */}
              <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-slate-800 bg-[#0D111A] p-1">
                {BIOMES.map((b) => {
                  const unlocked = isBiomeUnlocked(b.id, progressionItems);
                  const active = activeBiomeId === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      disabled={!unlocked}
                      onClick={() => switchBiomeOrMode(b.id, battleMode)}
                      title={unlocked ? b.subtitle : b.unlockHint}
                      className={`flex min-h-[36px] lg:min-h-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        active
                          ? 'bg-slate-800 text-slate-100'
                          : unlocked
                            ? 'text-slate-400 hover:text-slate-200'
                            : 'text-slate-600 cursor-not-allowed'
                      }`}
                    >
                      {!unlocked && <Lock className="h-3 w-3 text-slate-600" />}
                      <span>{b.shortName}</span>
                    </button>
                  );
                })}
              </div>

              {/* Audio + Battle vs AI Toggle */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => switchBiomeOrMode(activeBiomeId, !battleMode)}
                  className={`flex min-h-[38px] lg:min-h-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    battleMode
                      ? 'border-rose-500/70 bg-rose-500/15 text-rose-200'
                      : 'border-slate-800 bg-[#0D111A] text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <Swords className="h-3.5 w-3.5" />
                  <span>{battleMode ? 'Battle vs AI: On' : 'Battle vs AI'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSfxEnabled((s) => !s)}
                  title="Toggle procedural water & cellular SFX"
                  className={`flex min-h-[38px] lg:min-h-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    sfxEnabled
                      ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
                      : 'border-slate-800 bg-[#0D111A] text-slate-500'
                  }`}
                >
                  {sfxEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                  <span className="hidden sm:inline">SFX</span>
                </button>

                <button
                  type="button"
                  onClick={() => setMusicEnabled((m) => !m)}
                  title="Toggle generative ambient synth music"
                  className={`flex min-h-[38px] lg:min-h-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    musicEnabled
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200'
                      : 'border-slate-800 bg-[#0D111A] text-slate-500'
                  }`}
                >
                  <Music className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Music</span>
                </button>
              </div>
            </div>

            {/* Active Biome Title + Play/Step/Reset Strip */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-sm sm:text-base font-semibold text-slate-100">
                  {activeBiomeDef.name}
                  {battleMode ? ' · Arena Battle vs AI' : ''}
                </h1>
                <p className="text-[11px] sm:text-xs text-slate-400">
                  {activeBiomeDef.subtitle}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setWorldPlaying((p) => !p)}
                  className="flex min-h-[40px] lg:min-h-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
                >
                  {worldPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  <span>{worldPlaying ? 'Pause' : 'Play'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWorldPlaying(false);
                    const w = worldRef.current;
                    stepWorldSimulation(w, worldParamsRef.current, simParamsRef.current);
                    syncAdaptiveSound(w);
                    if (w.soundEvents.length > 0) {
                      soundEngine.playEvents(w.soundEvents);
                      w.soundEvents.length = 0;
                    }
                    bumpWorldVisuals(true);
                  }}
                  className="flex min-h-[40px] lg:min-h-0 items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0E131D] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
                >
                  <StepForward className="h-3.5 w-3.5" />
                  <span>Step</span>
                </button>
                <button
                  type="button"
                  onClick={() => switchBiomeOrMode(activeBiomeId, battleMode)}
                  className="flex min-h-[40px] lg:min-h-0 items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0E131D] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Reset World</span>
                  <span className="sm:hidden">Reset</span>
                </button>
              </div>
            </div>

            {/* Battle vs AI Barrier & Victory Status Bar */}
            {world.battle.enabled && (
              <div className="rounded-lg border border-slate-800 bg-[#0D111A] px-3.5 py-2.5 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="font-mono tabular-nums text-cyan-300">
                    Player: {world.battle.playerCount} orgs · {Math.round(world.battle.playerStrength).toLocaleString()}/{world.battle.breachThreshold.toLocaleString()} PWR
                  </div>
                  <div className="flex items-center gap-2 font-semibold text-slate-200">
                    {world.battle.winner === 'player' ? (
                      <span className="text-emerald-300">Victory — Player Controls Ecosystem!</span>
                    ) : world.battle.winner === 'ai' ? (
                      <span className="text-rose-400">Defeat — AI Swarm Dominated Tank</span>
                    ) : world.battle.barrierActive ? (
                      <span className="text-slate-300">
                        Containment Wall Active ({world.battle.barrierHealth}%) · Reach {world.battle.breachThreshold.toLocaleString()} PWR or 15 orgs to breach
                      </span>
                    ) : (
                      <span className="text-amber-300">Barrier Shattered — Free Combat!</span>
                    )}
                    {world.battle.winner !== null && (
                      <button
                        type="button"
                        onClick={() => switchBiomeOrMode(activeBiomeId, true)}
                        className="rounded border border-cyan-500/60 bg-cyan-500/15 px-2 py-0.5 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/25 transition-colors whitespace-nowrap"
                      >
                        Rematch
                      </button>
                    )}
                  </div>
                  <div className="font-mono tabular-nums text-rose-300">
                    AI: {world.battle.aiCount} orgs · {Math.round(world.battle.aiStrength).toLocaleString()}/{world.battle.breachThreshold.toLocaleString()} PWR
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="h-1.5 overflow-hidden rounded-sm bg-slate-800">
                    <div
                      className="h-full bg-cyan-400 transition-all duration-200"
                      style={{
                        width: `${Math.min(100, (world.battle.playerStrength / world.battle.breachThreshold) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-sm bg-slate-800 flex justify-end">
                    <div
                      className="h-full bg-rose-400 transition-all duration-200"
                      style={{
                        width: `${Math.min(100, (world.battle.aiStrength / world.battle.breachThreshold) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {spawnNotice && (
              <div className="flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <span>{spawnNotice}</span>
                <button
                  type="button"
                  onClick={() => setSpawnNotice(null)}
                  className="text-amber-300 hover:text-amber-100"
                  aria-label="Dismiss notice"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <WorldCanvas
              worldRef={worldRef}
              worldParamsRef={worldParamsRef}
              simParamsRef={simParamsRef}
              worldPlaying={worldPlaying}
              battleEnabled={battleMode}
              selectedOrgId={selectedOrgId}
              activeTool={worldTool}
              showChemFields={showChemFields}
              showGradientArrows={showGradientArrows}
              showPhysicsMesh={showPhysicsMesh}
              sunlightLevel={worldParams.sunlightLevel}
              renderEpoch={renderEpoch}
              onSimulationTicked={handleWorldSimulationTicked}
              onSelectOrganism={(org) => setSelectedOrgId(org ? org.id : null)}
              onSpawnAt={handleSpawnAt}
              onDropChemical={handleDropChemical}
              onPoke={handlePoke}
              onInjureAt={handleInjureWorld}
            />

            {/* Static Tissue Legend (no per-tick HTML roster elements) */}
            <div className="space-y-2 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                <span>
                  Click any organism on the canvas to inspect neural &amp; vascular telemetry · ATP % is blended in WebGL2
                </span>
                <span className="font-mono tabular-nums text-slate-300">
                  {world.organisms.length} active · {world.pellets.length} nutrients
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-800/80 pt-2.5 text-xs text-slate-400">
                {ACTIVE_TISSUE_TYPES.map((t) => {
                  const spec = TISSUE_SPECS[t];
                  return (
                    <span key={t} className="flex items-center gap-1.5 whitespace-nowrap">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ backgroundColor: spec.color }}
                      />
                      <span className="text-slate-300">{spec.name}</span>
                    </span>
                  );
                })}
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="inline-block h-2.5 w-2.5 rounded-full bg-lime-400" />
                  <span className="text-slate-300">Photosynthetic Algae</span>
                </span>
              </div>
            </div>
          </main>

          {/* Desktop Right Per-Organism Morphogenesis Side Tab */}
          {selectedOrganism && (
            <div className="hidden lg:flex">
              <OrganismSideTab
                organism={selectedOrganism}
                canMate={canMateSelected}
                onClose={() => setSelectedOrgId(null)}
                onEditInDesigner={handleEditOrganismInDesigner}
                onCloneOrganism={handleCloneOrganism}
                onMateOrganism={handleMateOrganism}
                onResetOrganismSeed={handleResetOrganismSeed}
                onRemoveOrganism={handleRemoveOrganism}
                onInjureOrganismCell={handleInjureOrganismCell}
              />
            </div>
          )}
        </div>
      ) : (
        /* BLUEPRINT DESIGNER & STANDALONE MORPHOGENESIS WORKBENCH */
        <div className="mx-auto flex w-full max-w-[1520px] flex-1 flex-col lg:flex-row">
          <aside className="hidden lg:block w-[330px] shrink-0 border-r border-slate-800 bg-[#0D111A] p-5">
            <DesignerControlsPanel
              selectedPresetId={selectedPresetId}
              activeTool={activeTool}
              brushSize={brushSize}
              simParams={simParams}
              onRequestImport={() => fileInputRef.current?.click()}
              onClearBlueprint={handleClearBlueprint}
              onSelectPreset={handleSelectPreset}
              onSelectTool={setActiveTool}
              onChangeBrushSize={setBrushSize}
              onChangeMode={handleModeChange}
              onChangeSimParams={(next, reset) => {
                setSimParams(next);
                if (reset) {
                  setSimState(createSimState(genome, next));
                }
              }}
            />
          </aside>

          <main className="order-1 lg:order-2 flex-1 space-y-6 p-3 sm:p-5 lg:p-7">
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-3">
                <div className="space-y-0.5">
                  <h1 className="text-sm sm:text-base font-semibold text-slate-100">
                    Organism Blueprint &amp; Morphogenetic Compiler
                  </h1>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span>{phaseLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-slate-300">
                      {simState.totalVisibleCoverage.toLocaleString()} /{' '}
                      {simState.targetCoverage.toLocaleString()} px
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDesignerPlaying((p) => !p)}
                    className="flex min-h-[40px] lg:min-h-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
                  >
                    {designerPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    <span>{designerPlaying ? 'Pause' : 'Play'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDesignerPlaying(false);
                      const curr = simStateRef.current;
                      stepSimulation(curr, genomeRef.current, simParamsRef.current);
                      setSimState({ ...curr, history: [...curr.history] });
                      triggerProgressionEval();
                    }}
                    className="flex min-h-[40px] lg:min-h-0 items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0E131D] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
                  >
                    <StepForward className="h-3.5 w-3.5" />
                    <span>Step</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSimState(createSimState(genomeRef.current, simParamsRef.current))}
                    className="flex min-h-[40px] lg:min-h-0 items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0E131D] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Reset Seed</span>
                  </button>
                  <select
                    value={designerTps}
                    onChange={(e) => setDesignerTps(Number(e.target.value))}
                    aria-label="Simulation speed"
                    className="min-h-[40px] lg:min-h-0 rounded-lg border border-slate-800 bg-[#0E131D] px-2.5 py-1.5 font-mono text-xs text-slate-300 focus:border-cyan-500 focus:outline-none"
                  >
                    <option value={4}>4 ticks/s</option>
                    <option value={12}>12 ticks/s</option>
                    <option value={24}>24 ticks/s</option>
                    <option value={45}>45 ticks/s</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200">
                      1. Target Blueprint &amp; Level-Set Map
                    </span>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showLevelSet}
                          onChange={(e) => setShowLevelSet(e.target.checked)}
                          className="accent-cyan-500 h-3.5 w-3.5"
                        />
                        <span>Level-Set φ</span>
                      </label>
                      <div className="flex items-center gap-0.5 rounded bg-slate-900 p-0.5 border border-slate-800">
                        {([0, 1, 2, 3] as MipLevel[]).map((lvl) => (
                          <button
                            key={lvl}
                            type="button"
                            onClick={() => setInspectLevel(lvl)}
                            className={`px-2 py-1 lg:px-1.5 lg:py-0.5 font-mono text-[11px] rounded transition-colors ${
                              inspectLevel === lvl
                                ? 'bg-slate-700 text-slate-100'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            L{lvl}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <BlueprintCanvas
                    blueprint={blueprint}
                    genome={genome}
                    inspectLevel={inspectLevel}
                    activeTool={activeTool}
                    brushSize={brushSize}
                    showLevelSet={showLevelSet}
                    onPaint={handlePaint}
                    onFinishStroke={handleFinishStroke}
                  />
                </div>

                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200">
                      2. Live Self-Replicating Growth
                    </span>
                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showNutrients}
                          onChange={(e) => setShowNutrients(e.target.checked)}
                          className="accent-cyan-500 h-3.5 w-3.5"
                        />
                        <span>Nutrients</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showDirectives}
                          onChange={(e) => setShowDirectives(e.target.checked)}
                          className="accent-cyan-500 h-3.5 w-3.5"
                        />
                        <span>Directives</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showTargetGhost}
                          onChange={(e) => setShowTargetGhost(e.target.checked)}
                          className="accent-cyan-500 h-3.5 w-3.5"
                        />
                        <span>Target Overlay</span>
                      </label>
                    </div>
                  </div>

                  <SimulationCanvas
                    simState={simState}
                    genome={genome}
                    activeTool={activeTool}
                    brushSize={brushSize}
                    showNutrients={showNutrients}
                    showDirectives={showDirectives}
                    showTargetGhost={showTargetGhost}
                    onInjure={handleInjureDesigner}
                    onInspectCell={setInspectedCell}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-800 bg-[#0D111A] px-4 py-2.5 text-xs">
                {inspectedCell ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono tabular-nums text-slate-300">
                    <span className="font-semibold text-cyan-300">
                      Node #{inspectedCell.nodeId} (L{inspectedCell.level})
                    </span>
                    <span>
                      Tissue:{' '}
                      <strong className="text-slate-100">
                        {TISSUE_SPECS[inspectedCell.tissue].name}
                      </strong>
                    </span>
                    <span>ATP: {(inspectedCell.energy * 100).toFixed(0)}%</span>
                    <span>Age: {inspectedCell.age}t</span>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-slate-400">
                    <span>
                      Hover or touch cells to inspect directive ID, mip level, and tissue specialization.
                    </span>
                    <span className="font-mono tabular-nums text-slate-300">
                      Divisions/tick: {simState.lastDivisions} · Fidelity IoU: {simState.iouPercent.toFixed(1)}%
                    </span>
                  </div>
                )}
              </div>
            </section>

            <section className="border-t border-slate-800/80 pt-5">
              <ResNetEditorPanel config={neuralConfig} onChange={handleNeuralConfigChange} />
            </section>

            <section className="border-t border-slate-800/80 pt-5">
              <MipmapPyramidStrip
                genome={genome}
                simState={simState}
                inspectLevel={inspectLevel}
                onSelectLevel={(lvl) => {
                  setInspectLevel(lvl);
                  setGraphFilterLevel(lvl);
                }}
              />
            </section>

            <section className="grid grid-cols-1 gap-6 border-t border-slate-800/80 pt-5 xl:grid-cols-12">
              <div className="xl:col-span-7">
                <DirectiveGraph3D
                  genome={genome}
                  simState={simState}
                  filterLevel={graphFilterLevel}
                  onFilterLevelChange={setGraphFilterLevel}
                />
              </div>
              <div className="xl:col-span-5">
                <TelemetryCharts simState={simState} />
              </div>
            </section>
          </main>
        </div>
      )}

      {/* Mobile Slide-Up Drawers (< lg only) */}
      {mobileSheet !== 'none' && view !== 'missions' && (
        <div className="fixed inset-x-0 bottom-14 z-30 max-h-[70vh] overflow-y-auto border-t border-slate-700 bg-[#0D111A] shadow-2xl lg:hidden">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-[#0D111A]/95 px-4 py-2.5 backdrop-blur-sm">
            <span className="text-xs font-semibold text-slate-200">
              {view === 'world'
                ? mobileSheet === 'tools'
                  ? 'World Tools & Layers'
                  : mobileSheet === 'physics'
                    ? 'Soft-Body, Sunlight & Fluid Physics'
                    : selectedOrganism
                      ? `Organism #${selectedOrganism.colonyId} · ${selectedOrganism.name}`
                      : 'Organism Inspector'
                : mobileSheet === 'tools'
                  ? 'Blueprint Presets & Tissue Brushes'
                  : 'Mipmap Growth Parameters'}
            </span>
            <button
              type="button"
              onClick={() => setMobileSheet('none')}
              className="flex min-h-[38px] min-w-[38px] items-center justify-center rounded-md border border-slate-800 bg-slate-900 text-slate-300"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {view === 'world' && mobileSheet === 'tools' && (
            <div className="p-4">
              <WorldControlsPanel
                section="tools"
                worldTool={worldTool}
                spawnLockedByBreach={spawnLockedByBreach}
                spawnSourceId={spawnSourceId}
                showChemFields={showChemFields}
                showGradientArrows={showGradientArrows}
                showPhysicsMesh={showPhysicsMesh}
                worldParams={worldParams}
                onSelectTool={(t) => {
                  setWorldTool(t);
                  setMobileSheet('none');
                }}
                onChangeSpawnSource={setSpawnSourceId}
                onToggleChemFields={setShowChemFields}
                onToggleGradientArrows={setShowGradientArrows}
                onTogglePhysicsMesh={setShowPhysicsMesh}
                onChangeWorldParams={setWorldParams}
              />
            </div>
          )}
          {view === 'world' && mobileSheet === 'physics' && (
            <div className="p-4">
              <WorldControlsPanel
                section="physics"
                worldTool={worldTool}
                spawnLockedByBreach={spawnLockedByBreach}
                spawnSourceId={spawnSourceId}
                showChemFields={showChemFields}
                showGradientArrows={showGradientArrows}
                showPhysicsMesh={showPhysicsMesh}
                worldParams={worldParams}
                onSelectTool={setWorldTool}
                onChangeSpawnSource={setSpawnSourceId}
                onToggleChemFields={setShowChemFields}
                onToggleGradientArrows={setShowGradientArrows}
                onTogglePhysicsMesh={setShowPhysicsMesh}
                onChangeWorldParams={setWorldParams}
              />
            </div>
          )}
          {view === 'world' && mobileSheet === 'inspector' && selectedOrganism && (
            <OrganismSideTab
              organism={selectedOrganism}
              canMate={canMateSelected}
              onClose={() => setMobileSheet('none')}
              onEditInDesigner={handleEditOrganismInDesigner}
              onCloneOrganism={handleCloneOrganism}
              onMateOrganism={handleMateOrganism}
              onResetOrganismSeed={handleResetOrganismSeed}
              onRemoveOrganism={handleRemoveOrganism}
              onInjureOrganismCell={handleInjureOrganismCell}
            />
          )}
          {view === 'designer' && mobileSheet === 'tools' && (
            <div className="p-4">
              <DesignerControlsPanel
                section="brushes"
                selectedPresetId={selectedPresetId}
                activeTool={activeTool}
                brushSize={brushSize}
                simParams={simParams}
                onRequestImport={() => fileInputRef.current?.click()}
                onClearBlueprint={handleClearBlueprint}
                onSelectPreset={handleSelectPreset}
                onSelectTool={(t) => {
                  setActiveTool(t);
                  setMobileSheet('none');
                }}
                onChangeBrushSize={setBrushSize}
                onChangeMode={handleModeChange}
                onChangeSimParams={(next, reset) => {
                  setSimParams(next);
                  if (reset) {
                    setSimState(createSimState(genome, next));
                  }
                }}
              />
            </div>
          )}
          {view === 'designer' && mobileSheet === 'physics' && (
            <div className="p-4">
              <DesignerControlsPanel
                section="growth"
                selectedPresetId={selectedPresetId}
                activeTool={activeTool}
                brushSize={brushSize}
                simParams={simParams}
                onRequestImport={() => fileInputRef.current?.click()}
                onClearBlueprint={handleClearBlueprint}
                onSelectPreset={handleSelectPreset}
                onSelectTool={setActiveTool}
                onChangeBrushSize={setBrushSize}
                onChangeMode={handleModeChange}
                onChangeSimParams={(next, reset) => {
                  setSimParams(next);
                  if (reset) {
                    setSimState(createSimState(genome, next));
                  }
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Mobile Bottom Thumb Dock (compact 56px bar, <=15% total sticky area) */}
      {view !== 'missions' && (
        <nav
          aria-label="Mobile quick controls"
          className="fixed bottom-0 inset-x-0 z-40 flex h-14 items-center justify-around border-t border-slate-800 bg-[#090C12]/95 px-2 backdrop-blur-sm lg:hidden"
        >
          <button
            type="button"
            onClick={() => setMobileSheet((s) => (s === 'tools' ? 'none' : 'tools'))}
            className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium whitespace-nowrap ${
              mobileSheet === 'tools' ? 'text-cyan-300' : 'text-slate-300'
            }`}
          >
            {view === 'world' ? (
              <Wrench className="h-4 w-4" />
            ) : (
              <Paintbrush className="h-4 w-4" />
            )}
            <span>{view === 'world' ? 'Tools' : 'Brushes'}</span>
          </button>

          <button
            type="button"
            onClick={() => setMobileSheet((s) => (s === 'physics' ? 'none' : 'physics'))}
            className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium whitespace-nowrap ${
              mobileSheet === 'physics' ? 'text-cyan-300' : 'text-slate-300'
            }`}
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span>{view === 'world' ? 'Physics' : 'Growth'}</span>
          </button>

          {view === 'world' && (
            <button
              type="button"
              disabled={!selectedOrganism}
              onClick={() =>
                setMobileSheet((s) => (s === 'inspector' ? 'none' : 'inspector'))
              }
              className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium whitespace-nowrap disabled:opacity-40 ${
                mobileSheet === 'inspector' ? 'text-cyan-300' : 'text-slate-300'
              }`}
            >
              <Target className="h-4 w-4" />
              <span>{selectedOrganism ? `#${selectedOrganism.colonyId}` : 'Inspect'}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() =>
              view === 'world'
                ? setWorldPlaying((p) => !p)
                : setDesignerPlaying((p) => !p)
            }
            className="flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium text-slate-200 whitespace-nowrap"
          >
            {(view === 'world' ? worldPlaying : designerPlaying) ? (
              <Pause className="h-4 w-4 text-cyan-400" />
            ) : (
              <Play className="h-4 w-4 text-emerald-400" />
            )}
            <span>
              {(view === 'world' ? worldPlaying : designerPlaying) ? 'Pause' : 'Play'}
            </span>
          </button>
        </nav>
      )}

      {/* Newly Unlocked Mission / Achievement Toast */}
      {toastItem && (
        <div className="fixed bottom-16 lg:bottom-4 right-3 sm:right-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-cyan-500/50 bg-[#0D111A]/95 p-3.5 shadow-2xl backdrop-blur-sm">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-cyan-500/40 bg-cyan-500/15 text-cyan-300">
            {toastItem.kind === 'mission' ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <Award className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wider text-cyan-300">
              {toastItem.kind === 'mission' ? 'Mission Complete' : 'Achievement Unlocked'}
            </div>
            <div className="text-xs font-semibold text-slate-100">{toastItem.title}</div>
            <p className="mt-0.5 text-[11px] text-slate-400">{toastItem.description}</p>
            <button
              type="button"
              onClick={() => {
                setToastItem(null);
                setView('missions');
              }}
              className="mt-1.5 text-[11px] font-medium text-cyan-300 hover:text-cyan-200"
            >
              Open Missions
            </button>
          </div>
          <button
            type="button"
            onClick={() => setToastItem(null)}
            className="text-slate-500 hover:text-slate-200"
            aria-label="Dismiss notification"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
