import React, { useState } from 'react';
import { SimState, TISSUE_SPECS, TissueType } from '../types/morphogenesis';

interface TelemetryChartsProps {
  simState: SimState;
}

export const TelemetryCharts: React.FC<TelemetryChartsProps> = ({ simState }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const history = simState.history;

  const width = 480;
  const height = 160;
  const padL = 36;
  const padR = 36;
  const padT = 14;
  const padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxTick = Math.max(10, history[history.length - 1]?.tick ?? 10);
  const maxPop = Math.max(
    10,
    ...history.map((p) => Math.max(p.l3Count, p.l2Count, p.l1Count, p.l0Count)),
  );

  const toX = (tick: number) => padL + (tick / maxTick) * plotW;
  const toYIou = (iou: number) => padT + plotH - (Math.min(100, Math.max(0, iou)) / 100) * plotH;
  const toYPop = (pop: number) => padT + plotH - (pop / maxPop) * plotH;

  const buildPath = (getY: (idx: number) => number) => {
    if (history.length === 0) return '';
    return history
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${toX(pt.tick).toFixed(1)} ${getY(i).toFixed(1)}`)
      .join(' ');
  };

  const iouPath = buildPath((i) => toYIou(history[i].iouPercent));
  const l3Path = buildPath((i) => toYPop(history[i].l3Count));
  const l0Path = buildPath((i) => toYPop(history[i].l0Count));

  const latest = history[history.length - 1];
  const inspected = hoverIdx !== null && history[hoverIdx] ? history[hoverIdx] : latest;

  const tissueList: TissueType[] = [
    TissueType.EPIDERMIS,
    TissueType.MESODERM,
    TissueType.VASCULAR,
    TissueType.NEURAL,
    TissueType.SENSOR,
    TissueType.MUSCLE,
    TissueType.FLAGELLA,
    TissueType.DIGESTIVE,
    TissueType.EXCRETORY,
    TissueType.SPIKE,
  ];
  const totalTissueCells = Math.max(1, simState.totalVisibleCoverage);

  return (
    <div className="space-y-4">
      {/* Growth & IoU Fidelity Curve */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100">
            Morphogenesis Dynamics
          </h3>
          {inspected && (
            <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-slate-400">
              <span>t={inspected.tick}</span>
              <span className="text-cyan-400">IoU {inspected.iouPercent.toFixed(1)}%</span>
              <span className="text-slate-300">L3:{inspected.l3Count}</span>
              <span className="text-emerald-400">L0:{inspected.l0Count}</span>
            </div>
          )}
        </div>

        <div className="relative rounded-lg border border-slate-800 bg-[#090C12] p-2">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-40 w-full overflow-visible"
            onMouseMove={(e) => {
              if (history.length === 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / rect.width) * width;
              const targetTick = ((relX - padL) / plotW) * maxTick;
              let bestI = 0;
              let bestDist = Infinity;
              for (let i = 0; i < history.length; i++) {
                const d = Math.abs(history[i].tick - targetTick);
                if (d < bestDist) {
                  bestDist = d;
                  bestI = i;
                }
              }
              setHoverIdx(bestI);
            }}
            onMouseLeave={() => setHoverIdx(null)}
          >
            {/* Horizontal gridlines */}
            {[0, 25, 50, 75, 100].map((v) => {
              const y = toYIou(v);
              return (
                <g key={v}>
                  <line
                    x1={padL}
                    x2={width - padR}
                    y1={y}
                    y2={y}
                    stroke="#1E293B"
                    strokeWidth={1}
                    strokeDasharray="2 3"
                  />
                  <text
                    x={padL - 5}
                    y={y + 3}
                    textAnchor="end"
                    fill="#64748B"
                    fontSize="9"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {v}%
                  </text>
                </g>
              );
            })}

            {/* Right axis pop scale */}
            <text
              x={width - padR + 5}
              y={padT + 4}
              fill="#64748B"
              fontSize="9"
              fontFamily="IBM Plex Mono, monospace"
            >
              {maxPop}
            </text>
            <text
              x={width - padR + 5}
              y={padT + plotH}
              fill="#64748B"
              fontSize="9"
              fontFamily="IBM Plex Mono, monospace"
            >
              0
            </text>

            {/* Curves */}
            {l3Path && (
              <path
                d={l3Path}
                fill="none"
                stroke="#F59E0B"
                strokeWidth={1.5}
                strokeDasharray="4 2"
              />
            )}
            {l0Path && (
              <path d={l0Path} fill="none" stroke="#10B981" strokeWidth={1.5} />
            )}
            {iouPath && (
              <path d={iouPath} fill="none" stroke="#06B6D4" strokeWidth={2} />
            )}

            {/* Hover crosshair */}
            {inspected && hoverIdx !== null && (
              <g>
                <line
                  x1={toX(inspected.tick)}
                  x2={toX(inspected.tick)}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="#94A3B8"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
                <circle
                  cx={toX(inspected.tick)}
                  cy={toYIou(inspected.iouPercent)}
                  r={3.5}
                  fill="#06B6D4"
                  stroke="#090C12"
                  strokeWidth={1.5}
                />
              </g>
            )}
          </svg>

          <div className="mt-1 flex flex-wrap items-center gap-4 px-2 text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 bg-cyan-500" /> Target IoU %
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 bg-amber-500" /> L3 Coarse Scaffold
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 bg-emerald-500" /> L0 Cellular Grid
            </span>
          </div>
        </div>
      </div>

      {/* Specialized Tissue Composition */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-slate-200">
            Tissue Differentiation Breakdown
          </h4>
          <span className="font-mono text-[11px] tabular-nums text-slate-400">
            {simState.totalVisibleCoverage.toLocaleString()} / {simState.targetCoverage.toLocaleString()} px
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {tissueList.map((t) => {
            const spec = TISSUE_SPECS[t];
            const count =
              t === TissueType.EPIDERMIS
                ? latest?.epidermis ?? 0
                : t === TissueType.MESODERM
                  ? latest?.mesoderm ?? 0
                  : t === TissueType.VASCULAR
                    ? latest?.vascular ?? 0
                    : t === TissueType.NEURAL
                      ? latest?.neural ?? 0
                      : t === TissueType.SENSOR
                        ? latest?.sensor ?? 0
                        : t === TissueType.MUSCLE
                          ? latest?.muscle ?? 0
                          : t === TissueType.FLAGELLA
                            ? latest?.flagella ?? 0
                            : t === TissueType.DIGESTIVE
                              ? latest?.digestive ?? 0
                              : t === TissueType.EXCRETORY
                                ? latest?.excretory ?? 0
                                : latest?.spike ?? 0;
            const share = (count / totalTissueCells) * 100;

            return (
              <div
                key={t}
                className="flex flex-col gap-1.5 rounded-lg border border-slate-800/90 bg-[#0E131D] px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-xs font-medium text-slate-200">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm shrink-0"
                      style={{ backgroundColor: spec.color }}
                    />
                    {spec.name}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-slate-300">
                    {count.toLocaleString()} <span className="text-slate-500">({share.toFixed(0)}%)</span>
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded bg-slate-800">
                  <div
                    className="h-full transition-all duration-150"
                    style={{ width: `${Math.min(100, share)}%`, backgroundColor: spec.color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
