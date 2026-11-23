import React, { useEffect, useRef, useState } from 'react';
import { stepWorldSimulation } from '../engine/worldSim';
import {
  SimParams,
  WorldOrganism,
  WorldParams,
  WorldState,
  WorldTool,
} from '../types/morphogenesis';
import { WorldGLRenderer } from '../webgl/WorldGLRenderer';

interface WorldCanvasProps {
  worldRef: React.MutableRefObject<WorldState>;
  worldParamsRef: React.MutableRefObject<WorldParams>;
  simParamsRef: React.MutableRefObject<SimParams>;
  worldPlaying: boolean;
  battleEnabled: boolean;
  selectedOrgId: number | null;
  activeTool: WorldTool;
  showChemFields: boolean;
  showGradientArrows: boolean;
  showPhysicsMesh: boolean;
  sunlightLevel: number;
  renderEpoch: number;
  onSimulationTicked: () => void;
  onSelectOrganism: (org: WorldOrganism | null) => void;
  onSpawnAt: (x: number, y: number) => void;
  onDropChemical: (kind: 'food' | 'toxin', x: number, y: number) => void;
  onPoke: (x: number, y: number, dvx: number, dvy: number) => void;
  onInjureAt: (x: number, y: number) => void;
}

/**
 * Interactive WebGL2 Ecosystem Viewport:
 * Drives the fixed-30Hz physics accumulator and smooth WebGL2 shader pipeline directly via
 * mutable refs so continuous frames render without React reconciliation or HTML churn.
 */
export const WorldCanvas: React.FC<WorldCanvasProps> = ({
  worldRef,
  worldParamsRef,
  simParamsRef,
  worldPlaying,
  battleEnabled,
  selectedOrgId,
  activeTool,
  showChemFields,
  showGradientArrows,
  showPhysicsMesh,
  sunlightLevel,
  renderEpoch,
  onSimulationTicked,
  onSelectOrganism,
  onSpawnAt,
  onDropChemical,
  onPoke,
  onInjureAt,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<WorldGLRenderer | null>(null);
  const startTimeRef = useRef<number>(performance.now());
  const isPointerDownRef = useRef(false);
  const lastWorldPtRef = useRef<{ x: number; y: number } | null>(null);
  const coordHudRef = useRef<HTMLSpanElement | null>(null);
  const [webglReady, setWebglReady] = useState<boolean>(true);

  // Mirror React view toggles in refs so the RAF loop runs continuously without re-subscribing
  const playingRef = useRef(worldPlaying);
  playingRef.current = worldPlaying;
  const selectedOrgIdRef = useRef(selectedOrgId);
  selectedOrgIdRef.current = selectedOrgId;
  const showChemRef = useRef(showChemFields);
  showChemRef.current = showChemFields;
  const showArrowsRef = useRef(showGradientArrows);
  showArrowsRef.current = showGradientArrows;
  const showMeshRef = useRef(showPhysicsMesh);
  showMeshRef.current = showPhysicsMesh;
  const sunlightRef = useRef(sunlightLevel);
  sunlightRef.current = sunlightLevel;
  const onTickRef = useRef(onSimulationTicked);
  onTickRef.current = onSimulationTicked;

  const chemCols = worldRef.current.chemCols;
  const chemRows = worldRef.current.chemRows;
  const worldW = worldRef.current.width;
  const worldH = worldRef.current.height;

  // Initialize WebGL2 3D Canvas context & RAF physics/render loop once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      setWebglReady(false);
      return;
    }

    const renderer = new WorldGLRenderer(gl, chemCols, chemRows, worldW, worldH);
    rendererRef.current = renderer;
    setWebglReady(true);

    let rafId = 0;
    let lastSimTs = performance.now();
    const stepMs = 30;

    const frame = (ts: number) => {
      rafId = requestAnimationFrame(frame);

      if (playingRef.current && ts - lastSimTs >= stepMs) {
        // Step max 2 catch-up ticks on tab focus resume so physics stays responsive
        const ticksToRun = Math.min(2, Math.floor((ts - lastSimTs) / stepMs));
        lastSimTs += ticksToRun * stepMs;
        if (ts - lastSimTs > stepMs * 4) lastSimTs = ts;

        for (let i = 0; i < ticksToRun; i++) {
          stepWorldSimulation(worldRef.current, worldParamsRef.current, simParamsRef.current);
          onTickRef.current();
        }
      } else if (!playingRef.current) {
        lastSimTs = ts;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const timeSec = (ts - startTimeRef.current) * 0.001;

      renderer.render(worldRef.current, {
        selectedOrgId: selectedOrgIdRef.current,
        showChemFields: showChemRef.current,
        showGradientArrows: showArrowsRef.current,
        showPhysicsMesh: showMeshRef.current,
        sunlightLevel: sunlightRef.current,
        dpr,
        timeSec,
        paused: !playingRef.current,
      });
    };

    rafId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(rafId);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [chemCols, chemRows, worldW, worldH, worldRef, worldParamsRef, simParamsRef]);

  // Immediate redraw when paused and discrete user action changed state
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || worldPlaying) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const timeSec = (performance.now() - startTimeRef.current) * 0.001;
    renderer.render(worldRef.current, {
      selectedOrgId,
      showChemFields,
      showGradientArrows,
      showPhysicsMesh,
      sunlightLevel,
      dpr,
      timeSec,
      paused: true,
    });
  }, [
    renderEpoch,
    worldPlaying,
    selectedOrgId,
    showChemFields,
    showGradientArrows,
    showPhysicsMesh,
    sunlightLevel,
    worldRef,
  ]);

  const toWorldCoords = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const w = worldRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * w.width;
    const y = ((e.clientY - rect.top) / rect.height) * w.height;
    return {
      x: Math.max(0, Math.min(w.width, x)),
      y: Math.max(0, Math.min(w.height, y)),
    };
  };

  const hitTestOrganism = (wx: number, wy: number, isTouch: boolean): WorldOrganism | null => {
    const w = worldRef.current;
    let best: WorldOrganism | null = null;
    let bestDist = isTouch ? 62 : 42;
    const cellHitTol = isTouch ? 24 : 16;

    for (let i = w.organisms.length - 1; i >= 0; i--) {
      const org = w.organisms[i];
      if (w.battle.enabled && org.faction !== 'player') continue;
      const d = Math.hypot(wx - org.mesh.comX, wy - org.mesh.comY);
      if (d <= org.mesh.boundRadius + (isTouch ? 22 : 12)) {
        const verts = org.mesh.vertices;
        for (const cell of org.mesh.cells) {
          const cx =
            (verts[cell.vTL].x + verts[cell.vTR].x + verts[cell.vBR].x + verts[cell.vBL].x) * 0.25;
          const cy =
            (verts[cell.vTL].y + verts[cell.vTR].y + verts[cell.vBR].y + verts[cell.vBL].y) * 0.25;
          if (Math.hypot(wx - cx, wy - cy) < cellHitTol) return org;
        }
        if (d < bestDist) {
          bestDist = d;
          best = org;
        }
      }
    }
    return best;
  };

  const clampPlayerSide = (x: number, isSpawn = false): number => {
    const w = worldRef.current;
    if (w.battle.enabled && (isSpawn || w.battle.barrierActive)) {
      return Math.min(w.battle.barrierX - 28, Math.max(45, x));
    }
    return x;
  };

  const updateCoordReadout = (pt: { x: number; y: number } | null) => {
    if (!coordHudRef.current) return;
    coordHudRef.current.textContent = pt ? `(${Math.round(pt.x)}, ${Math.round(pt.y)})` : '';
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isPointerDownRef.current = true;
    const pt = toWorldCoords(e);
    lastWorldPtRef.current = pt;
    updateCoordReadout(pt);

    const isTouch = e.pointerType === 'touch';
    if (activeTool === 'select') {
      onSelectOrganism(hitTestOrganism(pt.x, pt.y, isTouch));
    } else if (activeTool === 'spawn') {
      onSpawnAt(clampPlayerSide(pt.x, true), pt.y);
    } else if (activeTool === 'food') {
      onDropChemical('food', clampPlayerSide(pt.x), pt.y);
    } else if (activeTool === 'toxin') {
      onDropChemical('toxin', clampPlayerSide(pt.x), pt.y);
    } else if (activeTool === 'scalpel') {
      onInjureAt(pt.x, pt.y);
    } else if (activeTool === 'poke') {
      onPoke(pt.x, pt.y, 0.2, -0.35);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toWorldCoords(e);
    updateCoordReadout(pt);
    if (!isPointerDownRef.current) return;

    const prev = lastWorldPtRef.current ?? pt;
    const dx = pt.x - prev.x;
    const dy = pt.y - prev.y;
    lastWorldPtRef.current = pt;

    if (activeTool === 'poke') {
      onPoke(pt.x, pt.y, dx * 0.14, dy * 0.14);
    } else if (activeTool === 'food') {
      onDropChemical('food', clampPlayerSide(pt.x), pt.y);
    } else if (activeTool === 'toxin') {
      onDropChemical('toxin', clampPlayerSide(pt.x), pt.y);
    } else if (activeTool === 'scalpel') {
      onInjureAt(pt.x, pt.y);
    }
  };

  const endPointer = () => {
    isPointerDownRef.current = false;
    lastWorldPtRef.current = null;
  };

  const cursorStyle =
    activeTool === 'select'
      ? 'cursor-pointer'
      : activeTool === 'poke'
        ? 'cursor-grab'
        : 'cursor-crosshair';

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-slate-800 bg-[#070B12] select-none">
      <div className="relative aspect-[16/10] w-full">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onPointerLeave={() => {
            endPointer();
            updateCoordReadout(null);
          }}
          style={{ touchAction: 'none' }}
          className={`h-full w-full block ${cursorStyle}`}
        />

        {!webglReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#070B12]/90 p-6 text-center text-xs text-slate-300">
            WebGL2 context unavailable in this browser environment.
          </div>
        )}

        {battleEnabled && (
          <>
            <div className="pointer-events-none absolute top-2 left-2.5 flex items-center gap-1.5 rounded border border-cyan-500/45 bg-[#090C12]/80 px-2 py-0.5 font-mono text-[10px] font-medium text-cyan-200">
              <span className="inline-block h-2 w-2 border border-cyan-300 bg-cyan-400/30" />
              <span>PLAYER</span>
            </div>
            <div className="pointer-events-none absolute top-2 right-2.5 flex items-center gap-1.5 rounded border border-rose-500/45 bg-[#090C12]/80 px-2 py-0.5 font-mono text-[10px] font-medium text-rose-200">
              <span className="inline-block h-2 w-2 rotate-45 border border-rose-300 bg-rose-500/35" />
              <span>AI SWARM</span>
            </div>
          </>
        )}

        <div className="pointer-events-none absolute bottom-2 left-2.5 flex items-center gap-2.5 rounded bg-[#090C12]/80 px-2 py-1 font-mono text-[10px] tabular-nums text-slate-400 border border-slate-800/80">
          <span>WebGL2 · {worldW}×{worldH}</span>
          <span ref={coordHudRef} className="hidden sm:inline text-slate-300" />
        </div>
      </div>
    </div>
  );
};
