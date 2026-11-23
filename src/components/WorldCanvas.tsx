import React, { useEffect, useMemo, useRef, useState } from 'react';
import { WorldOrganism, WorldState, WorldTool } from '../types/morphogenesis';
import { WorldGLRenderer } from '../webgl/WorldGLRenderer';

interface WorldCanvasProps {
  world: WorldState;
  selectedOrgId: number | null;
  activeTool: WorldTool;
  showChemFields: boolean;
  showGradientArrows: boolean;
  showPhysicsMesh: boolean;
  onSelectOrganism: (org: WorldOrganism | null) => void;
  onSpawnAt: (x: number, y: number) => void;
  onDropChemical: (kind: 'food' | 'toxin', x: number, y: number) => void;
  onPoke: (x: number, y: number, dvx: number, dvy: number) => void;
  onInjureAt: (x: number, y: number) => void;
}

export const WorldCanvas: React.FC<WorldCanvasProps> = ({
  world,
  selectedOrgId,
  activeTool,
  showChemFields,
  showGradientArrows,
  showPhysicsMesh,
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
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [webglReady, setWebglReady] = useState<boolean>(true);

  const selectedOrg = useMemo(
    () => world.organisms.find((o) => o.id === selectedOrgId) ?? null,
    [world.organisms, selectedOrgId],
  );

  // Initialize WebGL2 3D Canvas context & shader renderer once
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

    const renderer = new WorldGLRenderer(gl, world.chemCols, world.chemRows);
    rendererRef.current = renderer;
    setWebglReady(true);

    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [world.chemCols, world.chemRows]);

  // Render every world state update via WebGL2 GPU shaders
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const timeSec = (performance.now() - startTimeRef.current) * 0.001;

    renderer.render(world, {
      selectedOrgId,
      showChemFields,
      showGradientArrows,
      showPhysicsMesh,
      dpr,
      timeSec,
    });
  }, [world, selectedOrgId, showChemFields, showGradientArrows, showPhysicsMesh]);

  const toWorldCoords = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * world.width;
    const y = ((e.clientY - rect.top) / rect.height) * world.height;
    return {
      x: Math.max(0, Math.min(world.width, x)),
      y: Math.max(0, Math.min(world.height, y)),
    };
  };

  const hitTestOrganism = (
    wx: number,
    wy: number,
    isTouch: boolean,
  ): WorldOrganism | null => {
    let best: WorldOrganism | null = null;
    let bestDist = isTouch ? 62 : 42;
    const cellHitTol = isTouch ? 24 : 16;

    for (let i = world.organisms.length - 1; i >= 0; i--) {
      const org = world.organisms[i];
      const d = Math.hypot(wx - org.mesh.comX, wy - org.mesh.comY);
      if (d <= org.mesh.boundRadius + (isTouch ? 22 : 12)) {
        const verts = org.mesh.vertices;
        for (const cell of org.mesh.cells) {
          const cx =
            (verts[cell.vTL].x + verts[cell.vTR].x + verts[cell.vBR].x + verts[cell.vBL].x) * 0.25;
          const cy =
            (verts[cell.vTL].y + verts[cell.vTR].y + verts[cell.vBR].y + verts[cell.vBL].y) * 0.25;
          if (Math.hypot(wx - cx, wy - cy) < cellHitTol) {
            return org;
          }
        }
        if (d < bestDist) {
          bestDist = d;
          best = org;
        }
      }
    }
    return best;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isPointerDownRef.current = true;
    const pt = toWorldCoords(e);
    lastWorldPtRef.current = pt;
    setHoverPos(pt);

    const isTouch = e.pointerType === 'touch';

    if (activeTool === 'select') {
      const hit = hitTestOrganism(pt.x, pt.y, isTouch);
      onSelectOrganism(hit);
    } else if (activeTool === 'spawn') {
      onSpawnAt(pt.x, pt.y);
    } else if (activeTool === 'food') {
      onDropChemical('food', pt.x, pt.y);
    } else if (activeTool === 'toxin') {
      onDropChemical('toxin', pt.x, pt.y);
    } else if (activeTool === 'scalpel') {
      onInjureAt(pt.x, pt.y);
    } else if (activeTool === 'poke') {
      onPoke(pt.x, pt.y, 0.2, -0.35);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toWorldCoords(e);
    setHoverPos(pt);
    if (!isPointerDownRef.current) return;

    const prev = lastWorldPtRef.current ?? pt;
    const dx = pt.x - prev.x;
    const dy = pt.y - prev.y;
    lastWorldPtRef.current = pt;

    if (activeTool === 'poke') {
      onPoke(pt.x, pt.y, dx * 0.14, dy * 0.14);
    } else if (activeTool === 'food') {
      onDropChemical('food', pt.x, pt.y);
    } else if (activeTool === 'toxin') {
      onDropChemical('toxin', pt.x, pt.y);
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

  const selectedLabelLeftPct = selectedOrg
    ? Math.max(8, Math.min(92, (selectedOrg.mesh.comX / world.width) * 100))
    : 50;
  const selectedLabelTopPct = selectedOrg
    ? Math.max(
        6,
        Math.min(
          92,
          ((selectedOrg.mesh.comY - selectedOrg.mesh.boundRadius - 20) / world.height) * 100,
        ),
      )
    : 50;

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
            setHoverPos(null);
          }}
          style={{ touchAction: 'none' }}
          className={`h-full w-full block ${cursorStyle}`}
        />

        {!webglReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#070B12]/90 p-6 text-center text-xs text-slate-300">
            WebGL2 context unavailable in this browser environment.
          </div>
        )}

        {/* Selected organism tactical label overlaid above WebGL scene */}
        {selectedOrg && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded border border-cyan-500/60 bg-[#090C12]/90 px-2 py-0.5 font-mono text-[11px] font-semibold text-cyan-200 whitespace-nowrap"
            style={{
              left: `${selectedLabelLeftPct}%`,
              top: `${selectedLabelTopPct}%`,
            }}
          >
            #{selectedOrg.colonyId}
            {selectedOrg.isFragment ? ' (frag)' : ''} {selectedOrg.name}
          </div>
        )}

        {/* Subtle WebGL shader HUD coordinate readout */}
        <div className="pointer-events-none absolute bottom-2 left-2.5 flex items-center gap-3 rounded bg-[#090C12]/80 px-2 py-1 font-mono text-[10px] tabular-nums text-slate-400 border border-slate-800/80">
          <span>WebGL2 · {world.width}×{world.height}</span>
          <span>Tick {world.worldTick}</span>
          {hoverPos && (
            <span className="hidden sm:inline">
              ({Math.round(hoverPos.x)}, {Math.round(hoverPos.y)})
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
