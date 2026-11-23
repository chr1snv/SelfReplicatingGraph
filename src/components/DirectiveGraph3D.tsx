import React, { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  BASE_DIM,
  CompiledGenome,
  MipLevel,
  SimState,
  TISSUE_SPECS,
  TissueType,
} from '../types/morphogenesis';

interface DirectiveGraph3DProps {
  genome: CompiledGenome;
  simState: SimState;
  filterLevel: MipLevel | 'all';
  onFilterLevelChange: (lvl: MipLevel | 'all') => void;
}

export const DirectiveGraph3D: React.FC<DirectiveGraph3DProps> = ({
  genome,
  simState,
  filterLevel,
  onFilterLevelChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [yaw, setYaw] = useState(-0.62);
  const [pitch, setPitch] = useState(0.58);
  const [zoom, setZoom] = useState(1.0);
  const dragRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    // Map 3D coordinates (nx in -1..1, ny in -1..1, nz in -1..1) to 2D screen
    const scale = Math.min(w, h) * 0.36 * zoom;
    const cx = w * 0.5;
    const cy = h * 0.5;

    const project = (x: number, y: number, z: number): [number, number, number] => {
      // Rotate around Y (vertical stack axis is Z-up -> let Y be vertical in 3D before pitch)
      const rx = x * cosY - z * sinY;
      const rz = x * sinY + z * cosY;
      const ry = y * cosP - rz * sinP;
      const depth = y * sinP + rz * cosP;
      const persp = 3.2 / (3.2 + depth * 0.75);
      return [cx + rx * scale * persp, cy + ry * scale * persp, depth];
    };

    const levelYPos: Record<MipLevel, number> = {
      3: -0.78, // Top sparse scaffold
      2: -0.26,
      1: 0.26,
      0: 0.78, // Bottom full cellular grid
    };

    const visibleLevels: MipLevel[] =
      filterLevel === 'all' ? [0, 1, 2, 3] : [filterLevel];

    // Draw bounding planes bottom-to-top
    for (const lvl of visibleLevels) {
      const py = filterLevel === 'all' ? levelYPos[lvl] : 0;
      const corners: [number, number, number][] = [
        [-1, py, -1],
        [1, py, -1],
        [1, py, 1],
        [-1, py, 1],
      ];
      const pCorners = corners.map(([x, y, z]) => project(x, y, z));

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pCorners[0][0], pCorners[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(pCorners[i][0], pCorners[i][1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
      ctx.fill();
      ctx.strokeStyle = lvl === 3 ? 'rgba(56, 189, 248, 0.35)' : 'rgba(51, 65, 85, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
      ctx.font = '11px "IBM Plex Mono", monospace';
      ctx.fillText(`L${lvl} (${genome.layers[lvl].dim}²)`, pCorners[0][0] + 6, pCorners[0][1] - 4);
      ctx.restore();
    }

    // Helper to get normalized plane coord
    const nodePos3D = (physX: number, physY: number, lvl: MipLevel): [number, number, number] => {
      const nx = (physX / BASE_DIM) * 2 - 1;
      const nz = (physY / BASE_DIM) * 2 - 1;
      const ny = filterLevel === 'all' ? levelYPos[lvl] : 0;
      return [nx, ny, nz];
    };

    // Draw cross-scale vertical subdivision edges (L3 -> L2 -> L1) when showing all stack
    if (filterLevel === 'all') {
      ctx.save();
      ctx.lineWidth = 0.7;
      for (const parentLevel of [3, 2] as MipLevel[]) {
        const pLayer = simState.layers[parentLevel];
        for (const node of genome.nodes) {
          if (node.level !== parentLevel) continue;
          const pAlive = pLayer.alive[node.gy * pLayer.dim + node.gx] === 1;
          const [px, py, pz] = nodePos3D(node.physX, node.physY, parentLevel);
          const [sx, sy] = project(px, py, pz);

          for (const cid of node.subdivisionChildren) {
            if (cid <= 0) continue;
            const cNode = genome.nodeById.get(cid);
            if (!cNode) continue;
            const cLayer = simState.layers[cNode.level];
            const cAlive = cLayer.alive[cNode.gy * cLayer.dim + cNode.gx] === 1;
            const [cx3, cy3, cz3] = nodePos3D(cNode.physX, cNode.physY, cNode.level);
            const [ex, ey] = project(cx3, cy3, cz3);

            ctx.strokeStyle =
              pAlive && cAlive
                ? 'rgba(56, 189, 248, 0.34)'
                : 'rgba(71, 85, 105, 0.16)';
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(ex, ey);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    // Draw lateral edges and nodes per visible level
    for (const lvl of visibleLevels) {
      const layer = simState.layers[lvl];
      // For L0 in "All Stack" mode, sample every 2nd cell for clean 60fps legibility unless filtered specifically to L0
      const stepFilter = lvl === 0 && filterLevel === 'all' ? 2 : 1;

      ctx.save();
      ctx.lineWidth = lvl === 3 ? 1.3 : 0.75;

      // Lateral edges (only E & S to avoid duplicates)
      if (lvl >= 1 || filterLevel === 0) {
        for (const node of genome.nodes) {
          if (node.level !== lvl) continue;
          if (stepFilter > 1 && (node.gx % stepFilter !== 0 || node.gy % stepFilter !== 0)) continue;
          const aliveA = layer.alive[node.gy * layer.dim + node.gx] === 1;
          const [ax, ay, az] = nodePos3D(node.physX, node.physY, lvl);
          const [sax, say] = project(ax, ay, az);

          for (const d of [1, 2]) {
            const nId = node.lateralNeighbors[d];
            if (nId <= 0) continue;
            const nNode = genome.nodeById.get(nId);
            if (!nNode) continue;
            const aliveB = layer.alive[nNode.gy * layer.dim + nNode.gx] === 1;
            const [bx, by, bz] = nodePos3D(nNode.physX, nNode.physY, lvl);
            const [sbx, sby] = project(bx, by, bz);

            ctx.strokeStyle =
              aliveA && aliveB
                ? 'rgba(226, 232, 240, 0.36)'
                : 'rgba(71, 85, 105, 0.14)';
            ctx.beginPath();
            ctx.moveTo(sax, say);
            ctx.lineTo(sbx, sby);
            ctx.stroke();
          }

          // Pioneer bridges at L3
          for (const bId of node.bridgeTargetIds) {
            const bNode = genome.nodeById.get(bId);
            if (!bNode) continue;
            const [bx, by, bz] = nodePos3D(bNode.physX, bNode.physY, lvl);
            const [sbx, sby] = project(bx, by, bz);
            ctx.strokeStyle = 'rgba(244, 114, 182, 0.55)';
            ctx.setLineDash([3, 2]);
            ctx.beginPath();
            ctx.moveTo(sax, say);
            ctx.lineTo(sbx, sby);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      // Nodes
      const radius = lvl === 3 ? 3.2 : lvl === 2 ? 2.1 : lvl === 1 ? 1.4 : 1.1;
      for (const node of genome.nodes) {
        if (node.level !== lvl) continue;
        if (stepFilter > 1 && (node.gx % stepFilter !== 0 || node.gy % stepFilter !== 0)) continue;
        const isAlive = layer.alive[node.gy * layer.dim + node.gx] === 1;
        const [nx, ny, nz] = nodePos3D(node.physX, node.physY, lvl);
        const [sx, sy] = project(nx, ny, nz);

        const spec = TISSUE_SPECS[node.tissue as TissueType];
        ctx.fillStyle = isAlive ? spec.color : 'rgba(100, 116, 139, 0.25)';
        ctx.beginPath();
        ctx.arc(sx, sy, isAlive ? radius : radius * 0.7, 0, Math.PI * 2);
        ctx.fill();

        if (node.id === genome.seedNodeId) {
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(sx, sy, radius + 2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }, [genome, simState, yaw, pitch, zoom, filterLevel]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Directive Connectivity Graph
          </h3>
          <p className="text-xs text-slate-400">
            Drag to orbit multi-resolution planes · Bright nodes indicate grown cells
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-lg bg-slate-900 p-0.5 border border-slate-800">
            {(['all', 3, 2, 1, 0] as const).map((lvl) => (
              <button
                key={String(lvl)}
                type="button"
                onClick={() => onFilterLevelChange(lvl)}
                className={`px-2 py-1 font-mono text-[11px] rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  filterLevel === lvl
                    ? 'bg-slate-700 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lvl === 'all' ? 'All Stack' : `L${lvl}`}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setYaw(-0.62);
              setPitch(0.58);
              setZoom(1.0);
            }}
            title="Reset graph camera"
            className="rounded-lg border border-slate-800 bg-slate-900 p-1.5 text-slate-400 hover:text-slate-100 transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative h-[300px] w-full overflow-hidden rounded-lg border border-slate-800 bg-[#090C12]">
        <canvas
          ref={canvasRef}
          width={560}
          height={300}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { active: true, x: e.clientX, y: e.clientY };
          }}
          onPointerMove={(e) => {
            if (!dragRef.current.active) return;
            const dx = e.clientX - dragRef.current.x;
            const dy = e.clientY - dragRef.current.y;
            dragRef.current.x = e.clientX;
            dragRef.current.y = e.clientY;
            setYaw((prev) => prev + dx * 0.01);
            setPitch((prev) => Math.max(-1.2, Math.min(1.35, prev + dy * 0.01)));
          }}
          onPointerUp={() => {
            dragRef.current.active = false;
          }}
          onPointerCancel={() => {
            dragRef.current.active = false;
          }}
          onWheel={(e) => {
            e.preventDefault();
            setZoom((z) => Math.max(0.65, Math.min(2.1, z - e.deltaY * 0.001)));
          }}
          className="h-full w-full cursor-grab active:cursor-grabbing touch-none"
        />
        <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-[#090C12]/85 px-2 py-1 font-mono text-[11px] tabular-nums text-slate-400 border border-slate-800/80">
          Seed #1 · {genome.nodes.length.toLocaleString()} directives · Zoom {zoom.toFixed(1)}×
        </div>
      </div>
    </div>
  );
};
