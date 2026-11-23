import React from 'react';
import { Eraser, Scissors, Trash2, Upload } from 'lucide-react';
import { ORGANISM_PRESETS } from '../engine/presets';
import {
  BrushTool,
  GrowthMode,
  SimParams,
  TISSUE_SPECS,
  TissueType,
} from '../types/morphogenesis';

interface DesignerControlsPanelProps {
  section?: 'all' | 'brushes' | 'growth';
  selectedPresetId: string;
  activeTool: BrushTool;
  brushSize: number;
  simParams: SimParams;
  onRequestImport: () => void;
  onClearBlueprint: () => void;
  onSelectPreset: (id: string) => void;
  onSelectTool: (tool: BrushTool) => void;
  onChangeBrushSize: (size: number) => void;
  onChangeMode: (mode: GrowthMode) => void;
  onChangeSimParams: (next: SimParams, resetSim?: boolean) => void;
}

const BRUSH_TOOLS: Array<{ id: BrushTool; label: string; color?: string; icon?: React.ReactNode }> = [
  { id: 'epidermis', label: 'Epidermis', color: TISSUE_SPECS[TissueType.EPIDERMIS].color },
  { id: 'mesoderm', label: 'Mesoderm', color: TISSUE_SPECS[TissueType.MESODERM].color },
  { id: 'vascular', label: 'Vascular', color: TISSUE_SPECS[TissueType.VASCULAR].color },
  { id: 'neural', label: 'Neural', color: TISSUE_SPECS[TissueType.NEURAL].color },
  { id: 'sensor', label: 'Sensor', color: TISSUE_SPECS[TissueType.SENSOR].color },
  { id: 'muscle', label: 'Muscle', color: TISSUE_SPECS[TissueType.MUSCLE].color },
  { id: 'flagella', label: 'Flagella', color: TISSUE_SPECS[TissueType.FLAGELLA].color },
  { id: 'digestive', label: 'Digestive', color: TISSUE_SPECS[TissueType.DIGESTIVE].color },
  { id: 'excretory', label: 'Excretory', color: TISSUE_SPECS[TissueType.EXCRETORY].color },
  { id: 'spike', label: 'Chitin Spike', color: TISSUE_SPECS[TissueType.SPIKE].color },
  { id: 'eraser', label: 'Eraser', icon: <Eraser className="h-3.5 w-3.5" /> },
  { id: 'scalpel', label: 'Scalpel', icon: <Scissors className="h-3.5 w-3.5 text-rose-400" /> },
];

function toolToTissue(tool: BrushTool): TissueType {
  switch (tool) {
    case 'epidermis': return TissueType.EPIDERMIS;
    case 'mesoderm': return TissueType.MESODERM;
    case 'vascular': return TissueType.VASCULAR;
    case 'neural': return TissueType.NEURAL;
    case 'sensor': return TissueType.SENSOR;
    case 'muscle': return TissueType.MUSCLE;
    case 'flagella': return TissueType.FLAGELLA;
    case 'digestive': return TissueType.DIGESTIVE;
    case 'excretory': return TissueType.EXCRETORY;
    default: return TissueType.SPIKE;
  }
}

/**
 * Blueprint Preset Selector, Specialized Cell Paint Brushes & Mipmap Growth Controls.
 */
export const DesignerControlsPanel: React.FC<DesignerControlsPanelProps> = ({
  section = 'all',
  selectedPresetId,
  activeTool,
  brushSize,
  simParams,
  onRequestImport,
  onClearBlueprint,
  onSelectPreset,
  onSelectTool,
  onChangeBrushSize,
  onChangeMode,
  onChangeSimParams,
}) => {
  const showBrushes = section === 'all' || section === 'brushes';
  const showGrowth = section === 'all' || section === 'growth';

  return (
    <div className="space-y-5">
      {showBrushes && (
        <>
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold tracking-wide text-slate-300">Organism Blueprint</h2>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onRequestImport}
                  className="flex min-h-[36px] lg:min-h-0 items-center gap-1 rounded border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap"
                >
                  <Upload className="h-3 w-3" /> Import
                </button>
                <button
                  type="button"
                  onClick={onClearBlueprint}
                  className="flex min-h-[36px] lg:min-h-0 items-center gap-1 rounded border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-300 hover:border-slate-700 hover:text-rose-300 transition-colors whitespace-nowrap"
                >
                  <Trash2 className="h-3 w-3" /> Clear
                </button>
              </div>
            </div>

            <select
              value={selectedPresetId}
              onChange={(e) => onSelectPreset(e.target.value)}
              aria-label="Organism Blueprint Preset"
              className="min-h-[42px] lg:min-h-0 w-full rounded-lg border border-slate-800 bg-[#090C12] px-3 py-2 text-xs font-medium text-slate-100 focus:border-cyan-500 focus:outline-none"
            >
              {ORGANISM_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {selectedPresetId === 'custom' && <option value="custom">Custom Painted Blueprint</option>}
            </select>

            <p className="text-[11px] leading-relaxed text-slate-400">
              {ORGANISM_PRESETS.find((p) => p.id === selectedPresetId)?.subtitle ??
                'Custom multi-tissue target geometry drawn on 128×128 blueprint.'}
            </p>
          </section>

          <hr className="border-slate-800/80" />

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold tracking-wide text-slate-300">Specialized Cell Brushes</h2>
              <span className="font-mono text-[11px] tabular-nums text-slate-400">r = {brushSize} px</span>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {BRUSH_TOOLS.map((tool) => {
                const active = activeTool === tool.id;
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => onSelectTool(tool.id)}
                    className={`flex min-h-[44px] lg:min-h-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'border-cyan-500/80 bg-slate-800/90 text-slate-100'
                        : 'border-slate-800 bg-[#090C12] text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    {tool.color ? (
                      <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: tool.color }} />
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
                onChange={(e) => onChangeBrushSize(Number(e.target.value))}
                className="lab-slider w-full"
              />
            </div>

            <p className="text-[11px] leading-relaxed text-slate-400">
              {activeTool === 'scalpel'
                ? 'Drag across the Simulation canvas to excise tissue and observe regeneration.'
                : activeTool === 'eraser'
                  ? 'Paint on Blueprint canvas to carve empty extracellular cavities.'
                  : TISSUE_SPECS[toolToTissue(activeTool)].role}
            </p>
          </section>
        </>
      )}

      {showBrushes && showGrowth && <hr className="border-slate-800/80" />}

      {showGrowth && (
        <>
          <section className="space-y-3">
            <h2 className="text-xs font-semibold tracking-wide text-slate-300">Morphogenesis Algorithm</h2>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#090C12] p-1 border border-slate-800">
              <button
                type="button"
                onClick={() => onChangeMode('mipmap')}
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
                onClick={() => onChangeMode('legacy')}
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
                  onChange={(e) => onChangeSimParams({ ...simParams, stagedWaves: e.target.checked }, true)}
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
                  onChange={(e) => onChangeSimParams({ ...simParams, legacyNodeCap: Number(e.target.value) }, true)}
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
            <h2 className="text-xs font-semibold tracking-wide text-slate-300">Cellular Parameters</h2>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Subdivision Maturation</span>
                <span className="font-mono tabular-nums text-slate-200">{simParams.subdivisionDelay} ticks</span>
              </div>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={simParams.subdivisionDelay}
                onChange={(e) => onChangeSimParams({ ...simParams, subdivisionDelay: Number(e.target.value) })}
                className="lab-slider w-full"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Division ATP Cost</span>
                <span className="font-mono tabular-nums text-slate-200">{simParams.divisionCost.toFixed(2)} ATP</span>
              </div>
              <input
                type="range"
                min={0.05}
                max={0.65}
                step={0.05}
                value={simParams.divisionCost}
                onChange={(e) => onChangeSimParams({ ...simParams, divisionCost: Number(e.target.value) })}
                className="lab-slider w-full"
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
};
