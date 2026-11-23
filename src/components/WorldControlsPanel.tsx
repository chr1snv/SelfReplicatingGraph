import React from 'react';
import {
  Droplets,
  FlaskConical,
  Hand,
  MousePointer2,
  PlusCircle,
  Scissors,
  Sun,
} from 'lucide-react';
import { ORGANISM_PRESETS } from '../engine/presets';
import { WorldParams, WorldTool } from '../types/morphogenesis';

interface WorldControlsPanelProps {
  section?: 'all' | 'tools' | 'physics';
  worldTool: WorldTool;
  spawnLockedByBreach: boolean;
  spawnSourceId: string;
  showChemFields: boolean;
  showGradientArrows: boolean;
  showPhysicsMesh: boolean;
  worldParams: WorldParams;
  onSelectTool: (tool: WorldTool) => void;
  onChangeSpawnSource: (sourceId: string) => void;
  onToggleChemFields: (v: boolean) => void;
  onToggleGradientArrows: (v: boolean) => void;
  onTogglePhysicsMesh: (v: boolean) => void;
  onChangeWorldParams: (next: WorldParams) => void;
}

const WORLD_TOOLS: Array<{ id: WorldTool; label: string; icon: React.ReactNode }> = [
  { id: 'select', label: 'Select', icon: <MousePointer2 className="h-3.5 w-3.5" /> },
  { id: 'poke', label: 'Squish / Drag', icon: <Hand className="h-3.5 w-3.5" /> },
  { id: 'food', label: 'Drop Scent', icon: <Droplets className="h-3.5 w-3.5 text-emerald-400" /> },
  { id: 'toxin', label: 'Drop Toxin', icon: <FlaskConical className="h-3.5 w-3.5 text-rose-400" /> },
  { id: 'spawn', label: 'Spawn Click', icon: <PlusCircle className="h-3.5 w-3.5 text-cyan-400" /> },
  { id: 'scalpel', label: 'Scalpel', icon: <Scissors className="h-3.5 w-3.5 text-rose-400" /> },
];

/**
 * World Tools, Viewport Shader Layer Toggles, and Soft-Body/Fluid Physics Sliders.
 * Used inside the Desktop Left Sidebar and Mobile Slide-Up Drawers.
 */
export const WorldControlsPanel: React.FC<WorldControlsPanelProps> = ({
  section = 'all',
  worldTool,
  spawnLockedByBreach,
  spawnSourceId,
  showChemFields,
  showGradientArrows,
  showPhysicsMesh,
  worldParams,
  onSelectTool,
  onChangeSpawnSource,
  onToggleChemFields,
  onToggleGradientArrows,
  onTogglePhysicsMesh,
  onChangeWorldParams,
}) => {
  const showTools = section === 'all' || section === 'tools';
  const showPhysics = section === 'all' || section === 'physics';

  return (
    <div className="space-y-5">
      {showTools && (
        <>
          <section className="space-y-2.5">
            <h2 className="text-xs font-semibold tracking-wide text-slate-300">World Tools</h2>
            <div className="grid grid-cols-2 gap-1.5">
              {WORLD_TOOLS.map((t) => {
                const disabled = t.id === 'spawn' && spawnLockedByBreach;
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={disabled}
                    title={disabled ? 'Spawning locked after barrier shatters' : undefined}
                    onClick={() => !disabled && onSelectTool(t.id)}
                    className={`flex min-h-[44px] lg:min-h-0 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-35 disabled:cursor-not-allowed ${
                      worldTool === t.id
                        ? 'border-cyan-500/80 bg-slate-800/90 text-slate-100'
                        : 'border-slate-800 bg-[#090C12] text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    {t.icon}
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <hr className="border-slate-800/80" />

          <section className="space-y-2">
            <h2 className="text-xs font-semibold tracking-wide text-slate-300">Species Blueprint to Spawn</h2>
            <select
              value={spawnSourceId}
              onChange={(e) => onChangeSpawnSource(e.target.value)}
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
                  onChange={(e) => onToggleChemFields(e.target.checked)}
                  className="accent-cyan-500 h-4 w-4 lg:h-3.5 lg:w-3.5"
                />
              </label>
              <label className="flex items-center justify-between cursor-pointer py-0.5">
                <span>Gradient Vector Field</span>
                <input
                  type="checkbox"
                  checked={showGradientArrows}
                  onChange={(e) => onToggleGradientArrows(e.target.checked)}
                  className="accent-cyan-500 h-4 w-4 lg:h-3.5 lg:w-3.5"
                />
              </label>
              <label className="flex items-center justify-between cursor-pointer py-0.5">
                <span>Soft-Mesh Springs &amp; Muscles</span>
                <input
                  type="checkbox"
                  checked={showPhysicsMesh}
                  onChange={(e) => onTogglePhysicsMesh(e.target.checked)}
                  className="accent-cyan-500 h-4 w-4 lg:h-3.5 lg:w-3.5"
                />
              </label>
            </div>
          </section>
        </>
      )}

      {showTools && showPhysics && <hr className="border-slate-800/80" />}

      {showPhysics && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold tracking-wide text-slate-300">
            Soft-Body, Sunlight &amp; Fluid Physics
          </h2>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span className="flex items-center gap-1">
            <Sun className="h-3 w-3 text-amber-300" />
            Sunlight &amp; Photosynthesis
          </span>
          <span className="font-mono tabular-nums text-amber-200">
            {Math.round(worldParams.sunlightLevel * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1.8}
          step={0.1}
          value={worldParams.sunlightLevel}
          onChange={(e) => onChangeWorldParams({ ...worldParams, sunlightLevel: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Internal Gas Pressure</span>
          <span className="font-mono tabular-nums text-slate-200">{worldParams.internalPressure.toFixed(2)} atm</span>
        </div>
        <input
          type="range"
          min={0.4}
          max={2.2}
          step={0.05}
          value={worldParams.internalPressure}
          onChange={(e) => onChangeWorldParams({ ...worldParams, internalPressure: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Muscle Contraction</span>
          <span className="font-mono tabular-nums text-slate-200">{Math.round(worldParams.muscleStrength * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={0.5}
          step={0.02}
          value={worldParams.muscleStrength}
          onChange={(e) => onChangeWorldParams({ ...worldParams, muscleStrength: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Flagella Thrust</span>
          <span className="font-mono tabular-nums text-slate-200">{worldParams.flagellaThrust.toFixed(2)}×</span>
        </div>
        <input
          type="range"
          min={0.2}
          max={4.0}
          step={0.05}
          value={worldParams.flagellaThrust}
          onChange={(e) => onChangeWorldParams({ ...worldParams, flagellaThrust: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Muscle Beat Frequency</span>
          <span className="font-mono tabular-nums text-slate-200">{worldParams.muscleFrequency.toFixed(2)} Hz</span>
        </div>
        <input
          type="range"
          min={0.08}
          max={0.42}
          step={0.02}
          value={worldParams.muscleFrequency}
          onChange={(e) => onChangeWorldParams({ ...worldParams, muscleFrequency: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Sensor Chemotaxis Gain</span>
          <span className="font-mono tabular-nums text-slate-200">{worldParams.gradientSensitivity.toFixed(1)}×</span>
        </div>
        <input
          type="range"
          min={0}
          max={3.5}
          step={0.1}
          value={worldParams.gradientSensitivity}
          onChange={(e) => onChangeWorldParams({ ...worldParams, gradientSensitivity: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Fluid Viscosity Drag</span>
          <span className="font-mono tabular-nums text-slate-200">{Math.round(worldParams.fluidDrag * 100)}%</span>
        </div>
        <input
          type="range"
          min={0.01}
          max={0.2}
          step={0.005}
          value={worldParams.fluidDrag}
          onChange={(e) => onChangeWorldParams({ ...worldParams, fluidDrag: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Metabolic Burn Rate</span>
          <span className="font-mono tabular-nums text-slate-200">{worldParams.metabolismRate.toFixed(2)}×</span>
        </div>
        <input
          type="range"
          min={0.2}
          max={2.5}
          step={0.1}
          value={worldParams.metabolismRate}
          onChange={(e) => onChangeWorldParams({ ...worldParams, metabolismRate: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Morphogenesis Cadence</span>
          <span className="font-mono tabular-nums text-slate-200">{worldParams.growthRate.toFixed(1)}×</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={3.0}
          step={0.25}
          value={worldParams.growthRate}
          onChange={(e) => onChangeWorldParams({ ...worldParams, growthRate: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Max Population Cap</span>
          <span className="font-mono tabular-nums text-slate-200">{worldParams.maxOrganisms} max</span>
        </div>
        <input
          type="range"
          min={6}
          max={48}
          step={1}
          value={worldParams.maxOrganisms}
          onChange={(e) => onChangeWorldParams({ ...worldParams, maxOrganisms: Number(e.target.value) })}
          className="lab-slider w-full"
        />
      </div>

          <label className="flex items-center justify-between pt-1 text-xs text-slate-300 cursor-pointer">
            <span>Auto-Mating (DNA Crossover)</span>
            <input
              type="checkbox"
              checked={worldParams.autoMating}
              onChange={(e) => onChangeWorldParams({ ...worldParams, autoMating: e.target.checked })}
              className="accent-cyan-500 h-4 w-4 lg:h-3.5 lg:w-3.5"
            />
          </label>
        </section>
      )}
    </div>
  );
};
