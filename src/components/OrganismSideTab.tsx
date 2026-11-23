import React, { useState } from 'react';
import { Copy, Edit3, GitMerge, RotateCcw, Scissors, Trash2, X } from 'lucide-react';
import {
  BrushTool,
  MipLevel,
  WorldOrganism,
} from '../types/morphogenesis';
import { DirectiveGraph3D } from './DirectiveGraph3D';
import { MipmapPyramidStrip } from './MipmapPyramidStrip';
import { SimulationCanvas } from './SimulationCanvas';
import { TelemetryCharts } from './TelemetryCharts';

interface OrganismSideTabProps {
  organism: WorldOrganism;
  canMate: boolean;
  onClose: () => void;
  onEditInDesigner: (organism: WorldOrganism) => void;
  onCloneOrganism: (organism: WorldOrganism) => void;
  onMateOrganism: (organism: WorldOrganism) => void;
  onResetOrganismSeed: (orgId: number) => void;
  onRemoveOrganism: (orgId: number) => void;
  onInjureOrganismCell: (orgId: number, px: number, py: number) => void;
}

type SideSubTab = 'growth' | 'mipmap' | 'telemetry';

export const OrganismSideTab: React.FC<OrganismSideTabProps> = ({
  organism,
  canMate,
  onClose,
  onEditInDesigner,
  onCloneOrganism,
  onMateOrganism,
  onResetOrganismSeed,
  onRemoveOrganism,
  onInjureOrganismCell,
}) => {
  const [subTab, setSubTab] = useState<SideSubTab>('growth');
  const [inspectLevel, setInspectLevel] = useState<MipLevel>(0);
  const [graphFilter, setGraphFilter] = useState<MipLevel | 'all'>('all');
  const [localScalpel, setLocalScalpel] = useState<boolean>(false);
  const [showNutrients, setShowNutrients] = useState<boolean>(true);
  const [showDirectives, setShowDirectives] = useState<boolean>(false);
  const [showTargetGhost, setShowTargetGhost] = useState<boolean>(false);

  const areaRatio =
    organism.mesh.targetTotalArea > 0
      ? (organism.mesh.totalArea / organism.mesh.targetTotalArea) * 100
      : 100;

  const activeTool: BrushTool = localScalpel ? 'scalpel' : 'mesoderm';

  return (
    <aside className="flex w-full shrink-0 flex-col border-t border-slate-800 bg-[#0D111A] lg:w-[440px] xl:w-[480px] lg:border-t-0 lg:border-l">
      {/* Side Tab Header */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-slate-100">
              #{organism.colonyId}
              {organism.isFragment ? ' (fragment)' : ''} · {organism.name}
            </h2>
          </div>
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-400">
            Gen {organism.generation}
            {organism.parentIds ? ` (#${organism.parentIds[0]}×#${organism.parentIds[1]})` : ''} ·{' '}
            IoU {organism.simState.iouPercent.toFixed(1)}% · {organism.mesh.cells.length} cells ·{' '}
            <span
              className={
                organism.mood === 'aggressive'
                  ? 'text-rose-400 font-semibold'
                  : organism.mood === 'amorous'
                    ? 'text-rose-300'
                    : organism.mood === 'threatened'
                      ? 'text-amber-300'
                      : 'text-cyan-300'
              }
            >
              Mood: {organism.mood}
            </span>
            {organism.rupturedCells > 0 ? ` · ${organism.rupturedCells} ruptured` : ''}
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          title="Close organism inspector"
          className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md border border-slate-800 bg-slate-900 p-2 text-slate-400 hover:text-slate-100 transition-colors shrink-0 lg:min-h-0 lg:min-w-0 lg:p-1.5"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Live Soft-Body & Chemotaxis Readout Strip */}
      <div className="grid grid-cols-5 gap-px border-b border-slate-800 bg-slate-800/80 text-center">
        <div className="bg-[#0B0F17] px-1.5 py-2">
          <div className="text-[10px] text-slate-400">ATP</div>
          <div
            className={`font-mono text-xs font-semibold tabular-nums ${
              organism.energyReserve < 25 ? 'text-rose-400' : 'text-emerald-400'
            }`}
          >
            {organism.energyReserve.toFixed(0)}%
          </div>
        </div>
        <div className="bg-[#0B0F17] px-1.5 py-2">
          <div className="text-[10px] text-slate-400">Waste</div>
          <div
            className={`font-mono text-xs font-semibold tabular-nums ${
              organism.wasteLevel > 60 ? 'text-amber-300' : 'text-teal-300'
            }`}
          >
            {organism.wasteLevel.toFixed(0)}%
          </div>
        </div>
        <div className="bg-[#0B0F17] px-1.5 py-2">
          <div className="text-[10px] text-slate-400">Speed</div>
          <div className="font-mono text-xs font-semibold tabular-nums text-slate-200">
            {organism.speed.toFixed(2)}
          </div>
        </div>
        <div className="bg-[#0B0F17] px-1.5 py-2">
          <div className="text-[10px] text-slate-400">Burn</div>
          <div className="font-mono text-xs font-semibold tabular-nums text-amber-400">
            -{(organism.lastMetabolicDrain * 10).toFixed(2)}
          </div>
        </div>
        <div className="bg-[#0B0F17] px-1.5 py-2">
          <div className="text-[10px] text-slate-400">Area</div>
          <div className="font-mono text-xs font-semibold tabular-nums text-cyan-400">
            {areaRatio.toFixed(0)}%
          </div>
        </div>
      </div>

      {/* Organ Physiology & Vascular/Neural Connectivity Readout */}
      <div className="grid grid-cols-5 gap-px border-b border-slate-800 bg-slate-800/60 text-center font-mono text-[10px] tabular-nums">
        <div className="bg-[#090D14] px-1.5 py-1 text-slate-400">
          Vasc <span className="text-rose-300">{Math.round(organism.mesh.vascularEfficiency * 100)}%</span>
        </div>
        <div className="bg-[#090D14] px-1.5 py-1 text-slate-400">
          Neur <span className="text-indigo-300">{Math.round(organism.mesh.neuralEfficiency * 100)}%</span>
        </div>
        <div className="bg-[#090D14] px-1.5 py-1 text-slate-400">
          Gut <span className="text-orange-300">{Math.round(organism.mesh.digestiveEfficiency * 100)}%</span>
        </div>
        <div className="bg-[#090D14] px-1.5 py-1 text-slate-400">
          Renal <span className="text-teal-300">{Math.round(organism.mesh.excretoryEfficiency * 100)}%</span>
        </div>
        <div className="bg-[#090D14] px-1.5 py-1 text-slate-400">
          Spikes <span className="text-slate-200">{organism.mesh.spikeCount}</span>
        </div>
      </div>

      {/* Sub-Tab Selector */}
      <div className="flex items-center gap-1 border-b border-slate-800 bg-[#090C12] px-4 py-2 overflow-x-auto">
        {(
          [
            { id: 'growth', label: 'Cell Growth' },
            { id: 'mipmap', label: 'Mipmap & Graph' },
            { id: 'telemetry', label: 'Tissue Telemetry' },
          ] as Array<{ id: SideSubTab; label: string }>
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setSubTab(tab.id)}
            className={`min-h-[38px] lg:min-h-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              subTab === tab.id
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Sub-Tab Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {subTab === 'growth' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setLocalScalpel((s) => !s)}
                className={`flex min-h-[40px] lg:min-h-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  localScalpel
                    ? 'border-rose-500/70 bg-rose-500/15 text-rose-300'
                    : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700'
                }`}
              >
                <Scissors className="h-3.5 w-3.5" />
                <span>{localScalpel ? 'Scalpel Active' : 'Injure Cells'}</span>
              </button>

              <div className="flex items-center gap-3 text-[11px] text-slate-400">
                <label className="flex items-center gap-1.5 cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={showNutrients}
                    onChange={(e) => setShowNutrients(e.target.checked)}
                    className="accent-cyan-500 h-3.5 w-3.5"
                  />
                  <span>Nutrients</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={showDirectives}
                    onChange={(e) => setShowDirectives(e.target.checked)}
                    className="accent-cyan-500 h-3.5 w-3.5"
                  />
                  <span>Directives</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={showTargetGhost}
                    onChange={(e) => setShowTargetGhost(e.target.checked)}
                    className="accent-cyan-500 h-3.5 w-3.5"
                  />
                  <span>Target</span>
                </label>
              </div>
            </div>

            <SimulationCanvas
              simState={organism.simState}
              genome={organism.genome}
              activeTool={activeTool}
              brushSize={3}
              showNutrients={showNutrients}
              showDirectives={showDirectives}
              showTargetGhost={showTargetGhost}
              onInjure={(px, py) => onInjureOrganismCell(organism.id, px, py)}
              onInspectCell={() => {}}
            />

            {/* Live AR-ResNet Neural Controller Strip */}
            <div className="rounded-lg border border-slate-800/90 bg-[#090C12] px-3 py-2.5">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="font-medium text-slate-300">
                  AR-ResNet Controller (6 Neurons)
                </span>
                <span className="font-mono uppercase text-[10px] tracking-wider text-cyan-300">
                  {organism.neuralNet.isAggressive && (
                    <span className="mr-1.5 rounded bg-rose-500/20 px-1 py-0.5 text-[9px] font-semibold text-rose-300">
                      SPIKES ARMED
                    </span>
                  )}
                  {organism.neuralNet.mode} · C {Math.round(organism.neuralNet.cruiseOut * 100)}% / B{' '}
                  {Math.round(organism.neuralNet.brakeOut * 100)}%
                </span>
              </div>
              <div className="grid grid-cols-6 gap-1.5">
                {organism.neuralNet.neurons.map((n) => {
                  const pct = Math.min(100, Math.round(Math.abs(n.state) * 100));
                  const pos = n.state >= 0;
                  return (
                    <div key={n.id} className="space-y-1">
                      <div className="h-1.5 w-full overflow-hidden rounded-sm bg-slate-800">
                        <div
                          className={`h-full ${
                            n.id === 2 && pos
                              ? 'bg-cyan-400'
                              : n.id === 4 && pos
                                ? 'bg-rose-400'
                                : pos
                                  ? 'bg-emerald-400'
                                  : 'bg-amber-400/70'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between font-mono text-[9px] tabular-nums text-slate-400">
                        <span>{n.label}</span>
                        <span>{n.state.toFixed(1)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-slate-400">
              {organism.parentIds
                ? `Hybrid offspring bred from #${organism.parentIds[0]} and #${organism.parentIds[1]} by recombining their directive connectivity graphs.`
                : 'Independent L3→L0 morphogenesis engine synced to this organism’s soft-body mesh.'}
              {localScalpel
                ? ' Drag over cells to wound and trigger local regeneration.'
                : ' Auto-regressive residual neurons keep propulsion smooth without alternating against brakes.'}
            </p>
          </div>
        )}

        {subTab === 'mipmap' && (
          <div className="space-y-5">
            <MipmapPyramidStrip
              genome={organism.genome}
              simState={organism.simState}
              inspectLevel={inspectLevel}
              onSelectLevel={(lvl) => {
                setInspectLevel(lvl);
                setGraphFilter(lvl);
              }}
            />
            <DirectiveGraph3D
              genome={organism.genome}
              simState={organism.simState}
              filterLevel={graphFilter}
              onFilterLevelChange={setGraphFilter}
            />
          </div>
        )}

        {subTab === 'telemetry' && <TelemetryCharts simState={organism.simState} />}
      </div>

      {/* Footer Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 bg-[#090C12] px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!canMate}
            onClick={() => onMateOrganism(organism)}
            title="Crossbreed directive graph DNA with nearest neighbor"
            className="flex min-h-[42px] lg:min-h-0 items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40 disabled:pointer-events-none transition-colors whitespace-nowrap"
          >
            <GitMerge className="h-3.5 w-3.5" />
            <span>Mate</span>
          </button>
          <button
            type="button"
            onClick={() => onEditInDesigner(organism)}
            className="flex min-h-[42px] lg:min-h-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700 transition-colors whitespace-nowrap"
          >
            <Edit3 className="h-3.5 w-3.5" />
            <span>Edit</span>
          </button>
          <button
            type="button"
            onClick={() => onCloneOrganism(organism)}
            className="flex min-h-[42px] lg:min-h-0 items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap"
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Clone</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onResetOrganismSeed(organism.id)}
            title="Regrow this organism from 1 seed cell"
            className="flex min-h-[42px] lg:min-h-0 items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Re-seed</span>
          </button>
          <button
            type="button"
            onClick={() => onRemoveOrganism(organism.id)}
            title="Remove organism from world"
            className="flex min-h-[42px] min-w-[42px] lg:min-h-0 lg:min-w-0 items-center justify-center rounded-md border border-slate-800 bg-slate-900 p-2 lg:p-1.5 text-slate-400 hover:border-rose-500/50 hover:text-rose-400 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
};

