import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Award,
  CheckCircle2,
  Droplets,
  Eraser,
  FlaskConical,
  Hand,
  MousePointer2,
  Paintbrush,
  Pause,
  Play,
  PlusCircle,
  RotateCcw,
  Scissors,
  SlidersHorizontal,
  StepForward,
  Target,
  Trash2,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import { BlueprintCanvas } from './components/BlueprintCanvas';
import { DirectiveGraph3D } from './components/DirectiveGraph3D';
import { MipmapPyramidStrip } from './components/MipmapPyramidStrip';
import { MissionsPanel } from './components/MissionsPanel';
import { OrganismSideTab } from './components/OrganismSideTab';
import { SimulationCanvas } from './components/SimulationCanvas';
import { TelemetryCharts } from './components/TelemetryCharts';
import { WorldCanvas } from './components/WorldCanvas';
import { compileBlueprintToGenome } from './engine/compiler';
import { ORGANISM_PRESETS } from './engine/presets';
import {
  ProgressionEntryDef,
  ProgressionEvaluatedItem,
  ProgressionTracker,
  createDefaultTracker,
  loadProgressionTracker,
  saveProgressionTracker,
  updateTrackerAndEvaluate,
} from './engine/progression';
import { createSimState, injureSimulation, stepSimulation } from './engine/simulator';
import { syncOrganismMeshFromSimState } from './engine/softBodyPhysics';
import {
  DEFAULT_WORLD_PARAMS,
  createInitialWorld,
  depositChemical,
  injureWorldOrganism,
  mateOrganisms,
  pokeWorldMesh,
  spawnOrganismInWorld,
  stepWorldSimulation,
} from './engine/worldSim';
import {
  ACTIVE_TISSUE_TYPES,
  BASE_DIM,
  BrushTool,
  CompiledGenome,
  GrowthMode,
  InspectedCell,
  MipLevel,
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

  // Designer / Standalone Morphogenesis state
  const [selectedPresetId, setSelectedPresetId] = useState<string>(ORGANISM_PRESETS[0].id);
  const [blueprint, setBlueprint] = useState<Uint8Array>(() =>
    ORGANISM_PRESETS[0].generate(BASE_DIM),
  );
  const [genome, setGenome] = useState<CompiledGenome>(() =>
    compileBlueprintToGenome(ORGANISM_PRESETS[0].generate(BASE_DIM)),
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

  // World Simulation state
  const [worldState, setWorldState] = useState<WorldState>(() =>
    createInitialWorld(DEFAULT_SIM_PARAMS),
  );
  const [worldParams, setWorldParams] = useState<WorldParams>(DEFAULT_WORLD_PARAMS);
  const [worldPlaying, setWorldPlaying] = useState<boolean>(true);
  const [worldTool, setWorldTool] = useState<WorldTool>('select');
  const [selectedOrgId, setSelectedOrgId] = useState<number | null>(1);
  const [showChemFields, setShowChemFields] = useState<boolean>(true);
  const [showGradientArrows, setShowGradientArrows] = useState<boolean>(false);
  const [showPhysicsMesh, setShowPhysicsMesh] = useState<boolean>(false);
  const [spawnSourceId, setSpawnSourceId] = useState<string>(ORGANISM_PRESETS[0].id);

  // Progression (Missions & Achievements)
  const trackerRef = useRef<ProgressionTracker>(loadProgressionTracker());
  const [progressionItems, setProgressionItems] = useState<ProgressionEvaluatedItem[]>(() => {
    const initial = updateTrackerAndEvaluate(
      trackerRef.current,
      worldState,
      simState,
      genome,
      false,
    );
    return initial.items;
  });
  const [toastItem, setToastItem] = useState<ProgressionEntryDef | null>(null);
  const toastTimerRef = useRef<number | null>(null);

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

  const worldRef = useRef(worldState);
  worldRef.current = worldState;
  const worldParamsRef = useRef(worldParams);
  worldParamsRef.current = worldParams;
  const selectedPresetIdRef = useRef(selectedPresetId);
  selectedPresetIdRef.current = selectedPresetId;

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
    (nextBlueprint: Uint8Array, nextParams: SimParams = simParamsRef.current) => {
      const compiled = compileBlueprintToGenome(nextBlueprint);
      const freshSim = createSimState(compiled, nextParams);
      setGenome(compiled);
      setSimState(freshSim);
      genomeRef.current = compiled;
      simStateRef.current = freshSim;
    },
    [],
  );

  // World Ecosystem 30Hz physics + morphogenesis loop
  useEffect(() => {
    if (view !== 'world' || !worldPlaying) return;
    let rafId = 0;
    let lastTime = 0;
    let evalCounter = 0;
    const stepMs = 30;

    const loop = (ts: number) => {
      rafId = requestAnimationFrame(loop);
      if (ts - lastTime < stepMs) return;
      lastTime = ts;

      const w = worldRef.current;
      stepWorldSimulation(w, worldParamsRef.current, simParamsRef.current);
      setWorldState({
        ...w,
        organisms: [...w.organisms],
        pellets: [...w.pellets],
      });

      evalCounter++;
      if (evalCounter % 8 === 0) {
        triggerProgressionEval();
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [view, worldPlaying, triggerProgressionEval]);

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

  const selectedOrganism = useMemo(
    () => worldState.organisms.find((o) => o.id === selectedOrgId) ?? null,
    [worldState.organisms, selectedOrgId],
  );

  const completedCount = useMemo(
    () => progressionItems.filter((i) => i.completed).length,
    [progressionItems],
  );

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
      const src = getBlueprintForSpawn();
      const org = spawnOrganismInWorld(
        w,
        src.genome,
        src.name,
        src.presetId,
        simParamsRef.current,
        x,
        y,
        Math.random() * Math.PI * 2 - Math.PI,
        1,
      );
      setSelectedOrgId(org.id);
      setWorldState({ ...w, organisms: [...w.organisms] });
      triggerProgressionEval();
    },
    [getBlueprintForSpawn, triggerProgressionEval],
  );

  const handlePrimarySpawnButton = () => {
    if (view === 'designer') {
      const w = worldRef.current;
      const name =
        selectedPresetId === 'custom'
          ? 'Custom Organism'
          : ORGANISM_PRESETS.find((p) => p.id === selectedPresetId)?.name ?? 'Custom Organism';
      const org = spawnOrganismInWorld(
        w,
        genomeRef.current,
        name,
        selectedPresetId,
        simParamsRef.current,
        280 + Math.random() * 720,
        160 + Math.random() * 480,
        Math.random() * Math.PI * 2 - Math.PI,
        2,
      );
      setSelectedOrgId(org.id);
      setWorldState({ ...w, organisms: [...w.organisms] });
      setView('world');
      setMobileSheet('none');
      setWorldPlaying(true);
      triggerProgressionEval();
    } else {
      const w = worldRef.current;
      const src = getBlueprintForSpawn();
      const org = spawnOrganismInWorld(
        w,
        src.genome,
        src.name,
        src.presetId,
        simParamsRef.current,
        200 + Math.random() * 880,
        140 + Math.random() * 520,
        Math.random() * Math.PI * 2 - Math.PI,
        1,
      );
      setSelectedOrgId(org.id);
      setWorldState({ ...w, organisms: [...w.organisms] });
      if (view === 'missions') {
        setView('world');
      }
      triggerProgressionEval();
    }
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
      setWorldState({ ...w });
    },
    [],
  );

  const handlePoke = useCallback((x: number, y: number, dvx: number, dvy: number) => {
    const w = worldRef.current;
    pokeWorldMesh(w, x, y, dvx, dvy, 38);
    trackerRef.current.pokes += 1;
    setWorldState({ ...w });
  }, []);

  const handleInjureWorld = useCallback(
    (x: number, y: number) => {
      const w = worldRef.current;
      if (injureWorldOrganism(w, x, y, 18)) {
        trackerRef.current.scalpelHits += 1;
        saveProgressionTracker(trackerRef.current);
        setWorldState({ ...w, organisms: [...w.organisms] });
        triggerProgressionEval();
      }
    },
    [triggerProgressionEval],
  );

  // Per-organism Side Tab actions
  const handleEditOrganismInDesigner = (org: WorldOrganism) => {
    setSelectedPresetId(org.presetId);
    const bp = new Uint8Array(org.genome.blueprint);
    setBlueprint(bp);
    compileAndResetDesigner(bp, org.params);
    setSpawnSourceId('designer');
    setMobileSheet('none');
    setView('designer');
  };

  const handleCloneOrganism = (org: WorldOrganism) => {
    const w = worldRef.current;
    const cloned = spawnOrganismInWorld(
      w,
      org.genome,
      org.name,
      org.presetId,
      org.params,
      Math.min(w.width - 70, Math.max(70, org.mesh.comX + 65)),
      Math.min(w.height - 70, Math.max(70, org.mesh.comY + 45)),
      org.mesh.headingAngle + 0.5,
      1,
    );
    setSelectedOrgId(cloned.id);
    setWorldState({ ...w, organisms: [...w.organisms] });
    triggerProgressionEval();
  };

  const handleResetOrganismSeed = (orgId: number) => {
    const w = worldRef.current;
    const org = w.organisms.find((o) => o.id === orgId);
    if (!org) return;
    org.simState = createSimState(org.genome, org.params);
    org.mesh.lastSyncedTick = -1;
    syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
    setWorldState({ ...w, organisms: [...w.organisms] });
  };

  const handleRemoveOrganism = (orgId: number) => {
    const w = worldRef.current;
    w.organisms = w.organisms.filter((o) => o.id !== orgId);
    if (selectedOrgId === orgId) {
      setSelectedOrgId(w.organisms[0]?.id ?? null);
      if (mobileSheet === 'inspector') {
        setMobileSheet('none');
      }
    }
    setWorldState({ ...w, organisms: [...w.organisms] });
  };

  const handleInjureOrganismCell = (orgId: number, px: number, py: number) => {
    const w = worldRef.current;
    const org = w.organisms.find((o) => o.id === orgId);
    if (!org) return;
    injureSimulation(org.simState, org.genome, px, py, 7);
    syncOrganismMeshFromSimState(org.mesh, org.simState, org.genome);
    trackerRef.current.scalpelHits += 1;
    saveProgressionTracker(trackerRef.current);
    setWorldState({ ...w, organisms: [...w.organisms] });
    triggerProgressionEval();
  };

  const handleMateOrganism = (org: WorldOrganism) => {
    const w = worldRef.current;
    const candidates = w.organisms.filter((o) => o.id !== org.id);
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
    trackerRef.current.manualMatings += 1;
    saveProgressionTracker(trackerRef.current);
    setSelectedOrgId(baby.id);
    setWorldState({ ...w, organisms: [...w.organisms] });
    triggerProgressionEval();
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

        if (sat < 0.22) {
          nextBp[i] = TissueType.MESODERM;
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
  };

  const brushTools: Array<{ id: BrushTool; label: string; color?: string; icon?: React.ReactNode }> = [
    { id: 'epidermis', label: 'Epidermis', color: TISSUE_SPECS[TissueType.EPIDERMIS].color },
    { id: 'mesoderm', label: 'Mesoderm', color: TISSUE_SPECS[TissueType.MESODERM].color },
    { id: 'vascular', label: 'Vascular', color: TISSUE_SPECS[TissueType.VASCULAR].color },
    { id: 'neural', label: 'Neural', color: TISSUE_SPECS[TissueType.NEURAL].color },
    { id: 'sensor', label: 'Sensor', color: TISSUE_SPECS[TissueType.SENSOR].color },
    { id: 'muscle', label: 'Muscle', color: TISSUE_SPECS[TissueType.MUSCLE].color },
    { id: 'flagella', label: 'Flagella', color: TISSUE_SPECS[TissueType.FLAGELLA].color },
    { id: 'eraser', label: 'Eraser', icon: <Eraser className="h-3.5 w-3.5" /> },
    { id: 'scalpel', label: 'Scalpel', icon: <Scissors className="h-3.5 w-3.5 text-rose-400" /> },
  ];

  const worldTools: Array<{ id: WorldTool; label: string; icon: React.ReactNode }> = [
    { id: 'select', label: 'Select', icon: <MousePointer2 className="h-3.5 w-3.5" /> },
    { id: 'poke', label: 'Squish / Drag', icon: <Hand className="h-3.5 w-3.5" /> },
    { id: 'food', label: 'Drop Scent', icon: <Droplets className="h-3.5 w-3.5 text-emerald-400" /> },
    { id: 'toxin', label: 'Drop Toxin', icon: <FlaskConical className="h-3.5 w-3.5 text-rose-400" /> },
    { id: 'spawn', label: 'Spawn Click', icon: <PlusCircle className="h-3.5 w-3.5 text-cyan-400" /> },
    { id: 'scalpel', label: 'Scalpel', icon: <Scissors className="h-3.5 w-3.5 text-rose-400" /> },
  ];

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

  // Reusable inner control blocks (shared cleanly between Desktop sidebars & Mobile bottom sheets)
  const renderWorldToolsControls = () => (
    <div className="space-y-4">
      <section className="space-y-2.5">
        <h2 className="text-xs font-semibold tracking-wide text-slate-300">World Tools</h2>
        <div className="grid grid-cols-2 gap-1.5">
          {worldTools.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setWorldTool(t.id);
                if (mobileSheet === 'tools') setMobileSheet('none');
              }}
              className={`flex min-h-[44px] lg:min-h-0 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                worldTool === t.id
                  ? 'border-cyan-500/80 bg-slate-800/90 text-slate-100'
                  : 'border-slate-800 bg-[#090C12] text-slate-400 hover:border-slate-700 hover:text-slate-200'
              }`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </section>

      <hr className="border-slate-800/80" />

      <section className="space-y-2">
        <h2 className="text-xs font-semibold tracking-wide text-slate-300">
          Species Blueprint to Spawn
        </h2>
        <select
          value={spawnSourceId}
          onChange={(e) => setSpawnSourceId(e.target.value)}
          aria-label="Species to spawn"
          className="min-h-[42px] lg:min-h-0 w-full rounded-lg border border-slate-800 bg-[#090C12] px-2.5 py-2 text-xs font-medium text-slate-100 focus:border-cyan-500 focus:outline-none"
        >
          {ORGANISM_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="designer">Custom Designer Blueprint</option>
        </select>
      </section>

      <hr className="border-slate-800/80" />

      <section className="space-y-2">
        <h2 className="text-xs font-semibold tracking-wide text-slate-300">Viewport Layers</h2>
        <div className="space-y-2 text-xs text-slate-300">
          <label className="flex items-center justify-between cursor-pointer py-0.5">
            <span>Chemical Scent Gradients</span>
            <input
              type="checkbox"
              checked={showChemFields}
              onChange={(e) => setShowChemFields(e.target.checked)}
              className="accent-cyan-500 h-4 w-4 lg:h-3.5 lg:w-3.5"
            />
          </label>
          <label className="flex items-center justify-between cursor-pointer py-0.5">
            <span>Gradient Vector Field</span>
            <input
              type="checkbox"
              checked={showGradientArrows}
              onChange={(e) => setShowGradientArrows(e.target.checked)}
              className="accent-cyan-500 h-4 w-4 lg:h-3.5 lg:w-3.5"
            />
          </label>
          <label className="flex items-center justify-between cursor-pointer py-0.5">
            <span>Soft-Mesh Springs &amp; Muscles</span>
            <input
              type="checkbox"
              checked={showPhysicsMesh}
              onChange={(e) => setShowPhysicsMesh(e.target.checked)}
              className="accent-cyan-500 h-4 w-4 lg:h-3.5 lg:w-3.5"
            />
          </label>
        </div>
      </section>
    </div>
  );

  const renderWorldPhysicsControls = () => (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold tracking-wide text-slate-300">
        Soft-Body &amp; Fluid Physics
      </h2>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Internal Gas Pressure</span>
          <span className="font-mono tabular-nums text-slate-200">
            {worldParams.internalPressure.toFixed(2)} atm
          </span>
        </div>
        <input
          type="range"
          min={0.4}
          max={2.2}
          step={0.05}
          value={worldParams.internalPressure}
          onChange={(e) =>
            setWorldParams({ ...worldParams, internalPressure: Number(e.target.value) })
          }
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Muscle Contraction</span>
          <span className="font-mono tabular-nums text-slate-200">
            {Math.round(worldParams.muscleStrength * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0.0}
          max={0.5}
          step={0.02}
          value={worldParams.muscleStrength}
          onChange={(e) =>
            setWorldParams({ ...worldParams, muscleStrength: Number(e.target.value) })
          }
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Flagella Thrust</span>
          <span className="font-mono tabular-nums text-slate-200">
            {worldParams.flagellaThrust.toFixed(2)}×
          </span>
        </div>
        <input
          type="range"
          min={0.2}
          max={3.0}
          step={0.05}
          value={worldParams.flagellaThrust}
          onChange={(e) =>
            setWorldParams({ ...worldParams, flagellaThrust: Number(e.target.value) })
          }
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Muscle Beat Frequency</span>
          <span className="font-mono tabular-nums text-slate-200">
            {worldParams.muscleFrequency.toFixed(2)} Hz
          </span>
        </div>
        <input
          type="range"
          min={0.08}
          max={0.42}
          step={0.02}
          value={worldParams.muscleFrequency}
          onChange={(e) =>
            setWorldParams({ ...worldParams, muscleFrequency: Number(e.target.value) })
          }
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Sensor Chemotaxis Gain</span>
          <span className="font-mono tabular-nums text-slate-200">
            {worldParams.gradientSensitivity.toFixed(1)}×
          </span>
        </div>
        <input
          type="range"
          min={0.0}
          max={3.0}
          step={0.1}
          value={worldParams.gradientSensitivity}
          onChange={(e) =>
            setWorldParams({
              ...worldParams,
              gradientSensitivity: Number(e.target.value),
            })
          }
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Fluid Viscosity Drag</span>
          <span className="font-mono tabular-nums text-slate-200">
            {Math.round(worldParams.fluidDrag * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0.01}
          max={0.2}
          step={0.005}
          value={worldParams.fluidDrag}
          onChange={(e) =>
            setWorldParams({ ...worldParams, fluidDrag: Number(e.target.value) })
          }
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Metabolic Burn Rate</span>
          <span className="font-mono tabular-nums text-slate-200">
            {worldParams.metabolismRate.toFixed(2)}×
          </span>
        </div>
        <input
          type="range"
          min={0.2}
          max={2.5}
          step={0.1}
          value={worldParams.metabolismRate}
          onChange={(e) =>
            setWorldParams({ ...worldParams, metabolismRate: Number(e.target.value) })
          }
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Morphogenesis Cadence</span>
          <span className="font-mono tabular-nums text-slate-200">
            {worldParams.growthRate.toFixed(1)}×
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={3.0}
          step={0.25}
          value={worldParams.growthRate}
          onChange={(e) =>
            setWorldParams({ ...worldParams, growthRate: Number(e.target.value) })
          }
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Max Population Cap</span>
          <span className="font-mono tabular-nums text-slate-200">
            {worldParams.maxOrganisms} max
          </span>
        </div>
        <input
          type="range"
          min={4}
          max={36}
          step={1}
          value={worldParams.maxOrganisms}
          onChange={(e) =>
            setWorldParams({ ...worldParams, maxOrganisms: Number(e.target.value) })
          }
          className="lab-slider w-full"
        />
      </div>

      <label className="flex items-center justify-between pt-1 text-xs text-slate-300 cursor-pointer">
        <span>Auto-Mating (DNA Crossover)</span>
        <input
          type="checkbox"
          checked={worldParams.autoMating}
          onChange={(e) =>
            setWorldParams({ ...worldParams, autoMating: e.target.checked })
          }
          className="accent-cyan-500 h-4 w-4 lg:h-3.5 lg:w-3.5"
        />
      </label>
    </section>
  );

  const renderDesignerBrushesControls = () => (
    <div className="space-y-5">
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold tracking-wide text-slate-300">
            Organism Blueprint
          </h2>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex min-h-[36px] lg:min-h-0 items-center gap-1 rounded border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap"
            >
              <Upload className="h-3 w-3" /> Import
            </button>
            <button
              type="button"
              onClick={handleClearBlueprint}
              className="flex min-h-[36px] lg:min-h-0 items-center gap-1 rounded border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-300 hover:border-slate-700 hover:text-rose-300 transition-colors whitespace-nowrap"
            >
              <Trash2 className="h-3 w-3" /> Clear
            </button>
          </div>
        </div>

        <select
          value={selectedPresetId}
          onChange={(e) => handleSelectPreset(e.target.value)}
          aria-label="Organism Blueprint Preset"
          className="min-h-[42px] lg:min-h-0 w-full rounded-lg border border-slate-800 bg-[#090C12] px-3 py-2 text-xs font-medium text-slate-100 focus:border-cyan-500 focus:outline-none"
        >
          {ORGANISM_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {selectedPresetId === 'custom' && (
            <option value="custom">Custom Painted Blueprint</option>
          )}
        </select>

        <p className="text-[11px] leading-relaxed text-slate-400">
          {ORGANISM_PRESETS.find((p) => p.id === selectedPresetId)?.subtitle ??
            'Custom multi-tissue target geometry drawn on 128×128 blueprint.'}
        </p>
      </section>

      <hr className="border-slate-800/80" />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold tracking-wide text-slate-300">
            Specialized Cell Brushes
          </h2>
          <span className="font-mono text-[11px] tabular-nums text-slate-400">
            r = {brushSize} px
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {brushTools.map((tool) => {
            const active = activeTool === tool.id;
            return (
              <button
                key={tool.id}
                type="button"
                onClick={() => {
                  setActiveTool(tool.id);
                  if (mobileSheet === 'tools') setMobileSheet('none');
                }}
                className={`flex min-h-[44px] lg:min-h-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'border-cyan-500/80 bg-slate-800/90 text-slate-100'
                    : 'border-slate-800 bg-[#090C12] text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                {tool.color ? (
                  <span
                    className="h-2.5 w-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: tool.color }}
                  />
                ) : (
                  tool.icon
                )}
                <span>{tool.label}</span>
              </button>
            );
          })}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>Tool Radius</span>
            <span className="font-mono tabular-nums text-slate-300">{brushSize} px</span>
          </div>
          <input
            type="range"
            min={1}
            max={7}
            step={1}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="lab-slider w-full"
          />
        </div>

        <p className="text-[11px] leading-relaxed text-slate-400">
          {activeTool === 'scalpel'
            ? 'Drag across the Simulation canvas to excise tissue and observe regeneration.'
            : activeTool === 'eraser'
              ? 'Paint on Blueprint canvas to carve empty extracellular cavities.'
              : TISSUE_SPECS[
                  activeTool === 'epidermis'
                    ? TissueType.EPIDERMIS
                    : activeTool === 'mesoderm'
                      ? TissueType.MESODERM
                      : activeTool === 'vascular'
                        ? TissueType.VASCULAR
                        : activeTool === 'neural'
                          ? TissueType.NEURAL
                          : activeTool === 'sensor'
                            ? TissueType.SENSOR
                            : activeTool === 'muscle'
                              ? TissueType.MUSCLE
                              : TissueType.FLAGELLA
                ].role}
        </p>
      </section>
    </div>
  );

  const renderDesignerGrowthControls = () => (
    <div className="space-y-5">
      <section className="space-y-3">
        <h2 className="text-xs font-semibold tracking-wide text-slate-300">
          Morphogenesis Algorithm
        </h2>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#090C12] p-1 border border-slate-800">
          <button
            type="button"
            onClick={() => handleModeChange('mipmap')}
            className={`min-h-[40px] lg:min-h-0 rounded-md px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              simParams.growthMode === 'mipmap'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Mipmap L3→L0
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('legacy')}
            className={`min-h-[40px] lg:min-h-0 rounded-md px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              simParams.growthMode === 'legacy'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Legacy 2D Grid
          </button>
        </div>

        {simParams.growthMode === 'mipmap' ? (
          <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#090C12] px-3 py-2 text-xs text-slate-300 cursor-pointer">
            <span>Coarse-First Wave Gating</span>
            <input
              type="checkbox"
              checked={simParams.stagedWaves}
              onChange={(e) => {
                const next = { ...simParams, stagedWaves: e.target.checked };
                setSimParams(next);
                setSimState(createSimState(genome, next));
              }}
              className="accent-cyan-500 h-4 w-4 lg:h-3.5 lg:w-3.5"
            />
          </label>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>Legacy Node Limit</span>
              <span className="font-mono tabular-nums text-amber-300">
                {simParams.legacyNodeCap === 0 ? 'Uncapped' : `${simParams.legacyNodeCap} nodes`}
              </span>
            </div>
            <select
              value={simParams.legacyNodeCap}
              onChange={(e) => {
                const next = { ...simParams, legacyNodeCap: Number(e.target.value) };
                setSimParams(next);
                setSimState(createSimState(genome, next));
              }}
              className="min-h-[42px] lg:min-h-0 w-full rounded border border-slate-800 bg-[#090C12] px-2.5 py-1.5 text-xs text-slate-200"
            >
              <option value={0}>Uncapped (Dense L0 BFS)</option>
              <option value={256}>256 Nodes (Original Repo Cap)</option>
              <option value={1024}>1,024 Nodes</option>
            </select>
          </div>
        )}
      </section>

      <hr className="border-slate-800/80" />

      <section className="space-y-3.5">
        <h2 className="text-xs font-semibold tracking-wide text-slate-300">
          Cellular Parameters
        </h2>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>Subdivision Maturation</span>
            <span className="font-mono tabular-nums text-slate-200">
              {simParams.subdivisionDelay} ticks
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={simParams.subdivisionDelay}
            onChange={(e) =>
              setSimParams({ ...simParams, subdivisionDelay: Number(e.target.value) })
            }
            className="lab-slider w-full"
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>Division ATP Cost</span>
            <span className="font-mono tabular-nums text-slate-200">
              {simParams.divisionCost.toFixed(2)} ATP
            </span>
          </div>
          <input
            type="range"
            min={0.05}
            max={0.65}
            step={0.05}
            value={simParams.divisionCost}
            onChange={(e) =>
              setSimParams({ ...simParams, divisionCost: Number(e.target.value) })
            }
            className="lab-slider w-full"
          />
        </div>
      </section>
    </div>
  );

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
            onClick={handlePrimarySpawnButton}
            className="min-h-[38px] sm:min-h-0 rounded-lg bg-cyan-500 px-3 sm:px-4 py-1.5 sm:py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <span className="sm:hidden">Spawn</span>
            <span className="hidden sm:inline">
              {view === 'designer' ? 'Spawn in World' : 'Spawn Organism'}
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
            <div className="space-y-5">
              {renderWorldToolsControls()}
              <hr className="border-slate-800/80" />
              {renderWorldPhysicsControls()}
            </div>
          </aside>

          {/* Center Fluid World Stage (ordered first on mobile!) */}
          <main className="order-1 lg:order-2 flex-1 min-w-0 p-3 sm:p-4 lg:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <h1 className="text-sm sm:text-base font-semibold text-slate-100">
                  Fluid Chemotaxis &amp; Soft-Body Ecosystem
                </h1>
                <p className="text-[11px] sm:text-xs text-slate-400">
                  Tap any organism to inspect its morphogenesis dashboard · WebGL2 chemical fields &amp; GPU flagella
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
                    setWorldState({
                      ...w,
                      organisms: [...w.organisms],
                      pellets: [...w.pellets],
                    });
                    triggerProgressionEval();
                  }}
                  className="flex min-h-[40px] lg:min-h-0 items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0E131D] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
                >
                  <StepForward className="h-3.5 w-3.5" />
                  <span>Step</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const fresh = createInitialWorld(simParamsRef.current);
                    setWorldState(fresh);
                    setSelectedOrgId(fresh.organisms[0]?.id ?? null);
                  }}
                  className="flex min-h-[40px] lg:min-h-0 items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0E131D] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Reset World</span>
                  <span className="sm:hidden">Reset</span>
                </button>
              </div>
            </div>

            <WorldCanvas
              world={worldState}
              selectedOrgId={selectedOrgId}
              activeTool={worldTool}
              showChemFields={showChemFields}
              showGradientArrows={showGradientArrows}
              showPhysicsMesh={showPhysicsMesh}
              onSelectOrganism={(org) => {
                setSelectedOrgId(org ? org.id : null);
              }}
              onSpawnAt={handleSpawnAt}
              onDropChemical={handleDropChemical}
              onPoke={handlePoke}
              onInjureAt={handleInjureWorld}
            />

            {/* Active Organism Roster + Tissue Legend */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-slate-400 mr-1">Active Organisms:</span>
                {worldState.organisms.length === 0 ? (
                  <span className="font-mono text-xs text-slate-500">
                    No living organisms · Spawn one or Reset World
                  </span>
                ) : (
                  worldState.organisms.map((org) => (
                    <button
                      key={org.id}
                      type="button"
                      onClick={() => {
                        setSelectedOrgId(org.id);
                        if (window.innerWidth < 1024) {
                          setMobileSheet('inspector');
                        }
                      }}
                      className={`min-h-[38px] lg:min-h-0 rounded-md border px-2.5 py-1 font-mono text-xs transition-colors whitespace-nowrap ${
                        selectedOrgId === org.id
                          ? 'border-cyan-500/80 bg-cyan-500/15 text-cyan-200'
                          : org.energyReserve < 25
                            ? 'border-rose-500/50 bg-rose-500/10 text-rose-200 hover:border-rose-400'
                            : 'border-slate-800 bg-[#0E131D] text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      #{org.colonyId}
                      {org.isFragment ? ' (frag)' : ''} {org.name} · {org.energyReserve.toFixed(0)}% ATP
                    </button>
                  ))
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-800/80 pt-3 text-xs text-slate-400">
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
              </div>
            </div>
          </main>

          {/* Desktop Right Per-Organism Morphogenesis Side Tab */}
          {selectedOrganism && (
            <div className="hidden lg:flex">
              <OrganismSideTab
                organism={selectedOrganism}
                canMate={worldState.organisms.length >= 2}
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
          {/* Desktop Left Designer Sidebar */}
          <aside className="hidden lg:block w-[330px] shrink-0 border-r border-slate-800 bg-[#0D111A] p-5">
            <div className="space-y-6">
              {renderDesignerBrushesControls()}
              <hr className="border-slate-800/80" />
              {renderDesignerGrowthControls()}
            </div>
          </aside>

          {/* Main Designer Workbench */}
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
                    ? 'Soft-Body & Fluid Physics'
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
            <div className="p-4">{renderWorldToolsControls()}</div>
          )}
          {view === 'world' && mobileSheet === 'physics' && (
            <div className="p-4">{renderWorldPhysicsControls()}</div>
          )}
          {view === 'world' && mobileSheet === 'inspector' && selectedOrganism && (
            <OrganismSideTab
              organism={selectedOrganism}
              canMate={worldState.organisms.length >= 2}
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
            <div className="p-4">{renderDesignerBrushesControls()}</div>
          )}
          {view === 'designer' && mobileSheet === 'physics' && (
            <div className="p-4">{renderDesignerGrowthControls()}</div>
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
