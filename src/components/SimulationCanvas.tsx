import React, { useEffect, useRef, useState } from 'react';
import {
  BASE_DIM,
  BrushTool,
  CompiledGenome,
  InspectedCell,
  MipLevel,
  SimState,
  TissueType,
} from '../types/morphogenesis';
import { MorphGLRenderer } from '../webgl/MorphGLRenderer';

interface SimulationCanvasProps {
  simState: SimState;
  genome: CompiledGenome;
  activeTool: BrushTool;
  brushSize: number;
  showNutrients: boolean;
  showDirectives: boolean;
  showTargetGhost: boolean;
  onInjure: (px: number, py: number, radius: number) => void;
  onInspectCell: (info: InspectedCell | null) => void;
}

export const SimulationCanvas: React.FC<SimulationCanvasProps> = ({
  simState,
  genome,
  activeTool,
  brushSize,
  showNutrients,
  showDirectives,
  showTargetGhost,
  onInjure,
  onInspectCell,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<MorphGLRenderer | null>(null);
  const startTimeRef = useRef<number>(performance.now());
  const isInjuringRef = useRef<boolean>(false);
  const [cursorCell, setCursorCell] = useState<{ x: number; y: number } | null>(null);
  const [webglReady, setWebglReady] = useState<boolean>(true);

  const canvasPx = 512;

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
    const renderer = new MorphGLRenderer(gl);
    rendererRef.current = renderer;
    setWebglReady(true);
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const timeSec = (performance.now() - startTimeRef.current) * 0.001;

    renderer.render(simState, genome, {
      sizePx: canvasPx,
      dpr,
      showNutrients,
      showDirectives,
      showTargetGhost,
      cursorCell,
      scalpelRadius: activeTool === 'scalpel' ? brushSize * 2 : 0,
      timeSec,
    });
  }, [simState, genome, showNutrients, showDirectives, showTargetGhost, cursorCell, activeTool, brushSize]);

  const toSimCoords = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * BASE_DIM);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * BASE_DIM);
    return {
      x: Math.max(0, Math.min(BASE_DIM - 1, x)),
      y: Math.max(0, Math.min(BASE_DIM - 1, y)),
    };
  };

  const inspectAt = (px: number, py: number) => {
    const idx = py * BASE_DIM + px;
    const level = simState.compositeLevel[idx];
    if (level < 0) {
      onInspectCell({
        physX: px,
        physY: py,
        level: 0,
        gx: px,
        gy: py,
        nodeId: -1,
        tissue: TissueType.EMPTY,
        age: 0,
        energy: 0,
        signal: 0,
        nutrientHere: simState.nutrients[idx],
        directive: null,
      });
      return;
    }
    const mip = level as MipLevel;
    const layer = simState.layers[mip];
    const gx = px >> mip;
    const gy = py >> mip;
    const lIdx = gy * layer.dim + gx;
    const nodeId = layer.nodeId[lIdx];
    onInspectCell({
      physX: px,
      physY: py,
      level: mip,
      gx,
      gy,
      nodeId,
      tissue: layer.tissue[lIdx] as TissueType,
      age: layer.age[lIdx],
      energy: layer.energy[lIdx],
      signal: layer.signal[lIdx],
      nutrientHere: simState.nutrients[idx],
      directive: genome.nodeById.get(nodeId) ?? null,
    });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toSimCoords(e);
    setCursorCell(pt);
    inspectAt(pt.x, pt.y);
    if (activeTool === 'scalpel') {
      e.currentTarget.setPointerCapture(e.pointerId);
      isInjuringRef.current = true;
      onInjure(pt.x, pt.y, Math.max(3, brushSize * 2));
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toSimCoords(e);
    setCursorCell(pt);
    inspectAt(pt.x, pt.y);
    if (isInjuringRef.current && activeTool === 'scalpel') {
      onInjure(pt.x, pt.y, Math.max(3, brushSize * 2));
    }
  };

  const handlePointerUp = () => {
    isInjuringRef.current = false;
  };

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-slate-800 bg-[#070A0F]">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => {
          isInjuringRef.current = false;
          setCursorCell(null);
          onInspectCell(null);
        }}
        style={{ touchAction: activeTool === 'scalpel' ? 'none' : 'auto' }}
        className={`h-full w-full block ${activeTool === 'scalpel' ? 'cursor-crosshair' : 'cursor-pointer'}`}
      />
      {!webglReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#070A0F]/90 p-4 text-center text-xs text-slate-300">
          WebGL2 context unavailable.
        </div>
      )}
    </div>
  );
};
