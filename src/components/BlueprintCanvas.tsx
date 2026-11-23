import React, { useEffect, useRef, useState } from 'react';
import {
  BASE_DIM,
  BrushTool,
  CompiledGenome,
  MipLevel,
  TISSUE_SPECS,
  TissueType,
} from '../types/morphogenesis';
import { BlueprintGLRenderer } from '../webgl/BlueprintGLRenderer';
import { hexToRgbNorm } from '../webgl/glUtils';

interface BlueprintCanvasProps {
  blueprint: Uint8Array;
  genome: CompiledGenome;
  inspectLevel: MipLevel;
  activeTool: BrushTool;
  brushSize: number;
  showLevelSet: boolean;
  onPaint: (points: Array<{ x: number; y: number }>, tissue: TissueType, radius: number) => void;
  onFinishStroke: () => void;
}

function toolToTissue(tool: BrushTool): TissueType {
  switch (tool) {
    case 'epidermis':
      return TissueType.EPIDERMIS;
    case 'mesoderm':
      return TissueType.MESODERM;
    case 'vascular':
      return TissueType.VASCULAR;
    case 'neural':
      return TissueType.NEURAL;
    case 'sensor':
      return TissueType.SENSOR;
    case 'muscle':
      return TissueType.MUSCLE;
    case 'flagella':
      return TissueType.FLAGELLA;
    default:
      return TissueType.EMPTY;
  }
}

export const BlueprintCanvas: React.FC<BlueprintCanvasProps> = ({
  blueprint,
  genome,
  inspectLevel,
  activeTool,
  brushSize,
  showLevelSet,
  onPaint,
  onFinishStroke,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<BlueprintGLRenderer | null>(null);
  const isDrawingRef = useRef<boolean>(false);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);
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
    const renderer = new BlueprintGLRenderer(gl);
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
    const tissue = toolToTissue(activeTool);
    const brushColor =
      activeTool === 'eraser'
        ? ([0.957, 0.247, 0.369] as [number, number, number])
        : hexToRgbNorm(TISSUE_SPECS[tissue].borderColor);

    renderer.render(blueprint, genome, {
      sizePx: canvasPx,
      dpr,
      inspectLevel,
      showLevelSet,
      cursorCell,
      brushRadius: brushSize,
      brushColor,
    });
  }, [blueprint, genome, inspectLevel, showLevelSet, cursorCell, brushSize, activeTool]);

  const toGridCoords = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * BASE_DIM);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * BASE_DIM);
    return {
      x: Math.max(0, Math.min(BASE_DIM - 1, x)),
      y: Math.max(0, Math.min(BASE_DIM - 1, y)),
    };
  };

  const interpolateLine = (
    p0: { x: number; y: number },
    p1: { x: number; y: number },
  ): Array<{ x: number; y: number }> => {
    const pts: Array<{ x: number; y: number }> = [];
    const steps = Math.max(Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({
        x: Math.round(p0.x + (p1.x - p0.x) * t),
        y: Math.round(p0.y + (p1.y - p0.y) * t),
      });
    }
    return pts;
  };

  const canPaint = activeTool !== 'scalpel';

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canPaint) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = toGridCoords(e);
    isDrawingRef.current = true;
    lastCellRef.current = pt;
    setCursorCell(pt);
    onPaint([pt], toolToTissue(activeTool), brushSize);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toGridCoords(e);
    setCursorCell(pt);
    if (!isDrawingRef.current || !canPaint) return;
    const prev = lastCellRef.current ?? pt;
    const pts = interpolateLine(prev, pt);
    lastCellRef.current = pt;
    onPaint(pts, toolToTissue(activeTool), brushSize);
  };

  const finishStroke = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastCellRef.current = null;
    onFinishStroke();
  };

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-slate-800 bg-[#090C12]">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onPointerLeave={() => {
          finishStroke();
          setCursorCell(null);
        }}
        style={{ touchAction: canPaint ? 'none' : 'auto' }}
        className={`h-full w-full block ${canPaint ? 'cursor-crosshair' : 'cursor-default'}`}
      />
      {!webglReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#090C12]/90 p-4 text-center text-xs text-slate-300">
          WebGL2 context unavailable.
        </div>
      )}
    </div>
  );
};
