import React, { useEffect, useRef } from 'react';
import {
  BASE_DIM,
  CompiledGenome,
  MipLevel,
  SimState,
  TISSUE_SPECS,
  TissueType,
} from '../types/morphogenesis';

interface MipmapPyramidStripProps {
  genome: CompiledGenome;
  simState: SimState;
  inspectLevel: MipLevel;
  onSelectLevel: (level: MipLevel) => void;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const TISSUE_RGB: Record<TissueType, [number, number, number]> = {
  [TissueType.EMPTY]: [13, 17, 25],
  [TissueType.EPIDERMIS]: hexToRgb(TISSUE_SPECS[TissueType.EPIDERMIS].color),
  [TissueType.MESODERM]: hexToRgb(TISSUE_SPECS[TissueType.MESODERM].color),
  [TissueType.VASCULAR]: hexToRgb(TISSUE_SPECS[TissueType.VASCULAR].color),
  [TissueType.NEURAL]: hexToRgb(TISSUE_SPECS[TissueType.NEURAL].color),
  [TissueType.SENSOR]: hexToRgb(TISSUE_SPECS[TissueType.SENSOR].color),
  [TissueType.MUSCLE]: hexToRgb(TISSUE_SPECS[TissueType.MUSCLE].color),
  [TissueType.FLAGELLA]: hexToRgb(TISSUE_SPECS[TissueType.FLAGELLA].color),
  [TissueType.DIGESTIVE]: hexToRgb(TISSUE_SPECS[TissueType.DIGESTIVE].color),
  [TissueType.EXCRETORY]: hexToRgb(TISSUE_SPECS[TissueType.EXCRETORY].color),
  [TissueType.SPIKE]: hexToRgb(TISSUE_SPECS[TissueType.SPIKE].color),
};

const MipMiniCanvas: React.FC<{
  genome: CompiledGenome;
  simState: SimState;
  level: MipLevel;
}> = ({ genome, simState, level }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const compiled = genome.layers[level];
    const sim = simState.layers[level];
    const dim = compiled.dim;
    const stride = compiled.stride;

    const img = ctx.createImageData(BASE_DIM, BASE_DIM);
    const data = img.data;

    for (let gy = 0; gy < dim; gy++) {
      for (let gx = 0; gx < dim; gx++) {
        const idx = gy * dim + gx;
        const t = compiled.tissueGrid[idx] as TissueType;
        const isAlive = sim.alive[idx] === 1;
        const phi = compiled.phiGrid[idx];

        let [r, g, b] = TISSUE_RGB[t] ?? TISSUE_RGB[TissueType.EMPTY];
        if (t !== TissueType.EMPTY && !isAlive) {
          // Compiled directive exists but cell hasn't divided here yet: dim target silhouette
          r = Math.round(r * 0.34);
          g = Math.round(g * 0.34);
          b = Math.round(b * 0.34);
        } else if (t === TissueType.EMPTY && phi < 4) {
          // Faint exterior level-set ring
          r += 8;
          g += 14;
          b += 22;
        }

        const sx = gx * stride;
        const sy = gy * stride;
        for (let dy = 0; dy < stride; dy++) {
          for (let dx = 0; dx < stride; dx++) {
            const p = ((sy + dy) * BASE_DIM + (sx + dx)) * 4;
            const edge = stride >= 4 && (dx === 0 || dy === 0);
            data[p] = edge ? Math.max(0, r - 12) : r;
            data[p + 1] = edge ? Math.max(0, g - 12) : g;
            data[p + 2] = edge ? Math.max(0, b - 12) : b;
            data[p + 3] = 255;
          }
        }
      }
    }

    ctx.putImageData(img, 0, 0);
  }, [genome, simState, level]);

  return (
    <canvas
      ref={canvasRef}
      width={BASE_DIM}
      height={BASE_DIM}
      style={{ imageRendering: 'pixelated' }}
      className="aspect-square w-full rounded border border-slate-800/90 bg-[#090C12]"
    />
  );
};

export const MipmapPyramidStrip: React.FC<MipmapPyramidStripProps> = ({
  genome,
  simState,
  inspectLevel,
  onSelectLevel,
}) => {
  const levels: Array<{ level: MipLevel; title: string; role: string }> = [
    { level: 3, title: 'L3 · 16×16', role: 'Sparse macro-scaffold' },
    { level: 2, title: 'L2 · 32×32', role: 'Organ domains' },
    { level: 1, title: 'L1 · 64×64', role: 'Tissue architecture' },
    { level: 0, title: 'L0 · 128×128', role: 'Full cellular grid' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Level-Set Mipmap Hierarchy
          </h3>
          <p className="text-xs text-slate-400">
            Reverse compiled L0 → L3 · Forward morphogenesis L3 → L0
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-slate-400">
          Compile {genome.compileTimeMs.toFixed(1)} ms · {genome.nodes.length.toLocaleString()} total nodes
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {levels.map(({ level, title, role }) => {
          const targetCount = genome.layers[level].activeCount;
          const activeCount = simState.layers[level].activeCount;
          const pct = targetCount > 0 ? Math.min(100, (activeCount / targetCount) * 100) : 0;
          const selected = inspectLevel === level;

          return (
            <button
              key={level}
              type="button"
              onClick={() => onSelectLevel(level)}
              className={`group flex flex-col gap-2 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                selected
                  ? 'border-cyan-500/70 bg-slate-900/90'
                  : 'border-slate-800 bg-[#0E131D] hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-medium text-slate-100 whitespace-nowrap">
                  {title}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-cyan-400 whitespace-nowrap">
                  {pct.toFixed(0)}%
                </span>
              </div>

              <MipMiniCanvas genome={genome} simState={simState} level={level} />

              <div className="space-y-1">
                <div className="h-1 w-full overflow-hidden rounded bg-slate-800">
                  <div
                    className="h-full bg-cyan-500 transition-all duration-150"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="truncate">{role}</span>
                  <span className="font-mono tabular-nums text-slate-300 shrink-0 ml-1">
                    {activeCount}/{targetCount}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
