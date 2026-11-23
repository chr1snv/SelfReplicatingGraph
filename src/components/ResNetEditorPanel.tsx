import React, { useState } from 'react';
import { BrainCircuit, GitMerge, Info, RotateCcw } from 'lucide-react';
import {
  BASE_WEIGHTS,
  NEURON_DESCRIPTIONS,
  NEURON_LABELS,
  createDefaultNeuralConfig,
} from '../engine/neuralNet';
import { NeuralBlueprintConfig } from '../types/morphogenesis';

interface ResNetEditorPanelProps {
  config: NeuralBlueprintConfig;
  onChange: (next: NeuralBlueprintConfig) => void;
}

interface ControllerPreset {
  id: string;
  label: string;
  build: () => NeuralBlueprintConfig;
}

const CONTROLLER_PRESETS: ControllerPreset[] = [
  {
    id: 'balanced',
    label: 'Balanced Forager',
    build: () => createDefaultNeuralConfig(),
  },
  {
    id: 'hunter',
    label: 'Persistent Hunter',
    build: () => {
      const cfg = createDefaultNeuralConfig();
      cfg.arDecay = [0.68, 0.72, 0.86, 0.88, 0.58, 0.74];
      cfg.resGain = [0.68, 0.76, 0.65, 0.52, 0.42, 0.68];
      cfg.bias = [0.02, 0.0, 0.34, 0.0, -0.34, 0.14];
      cfg.weights[2 * 6 + 4] = -1.25; // Seek suppresses Brake more aggressively
      cfg.weights[0 * 6 + 2] = 0.68; // Food gradient drives Seek strongly
      return cfg;
    },
  },
  {
    id: 'grazer',
    label: 'Agile Grazer',
    build: () => {
      const cfg = createDefaultNeuralConfig();
      cfg.arDecay = [0.56, 0.62, 0.74, 0.72, 0.68, 0.68];
      cfg.resGain = [0.74, 0.82, 0.54, 0.48, 0.55, 0.62];
      cfg.bias = [0.0, 0.0, 0.16, 0.0, -0.16, 0.06];
      return cfg;
    },
  },
  {
    id: 'sprint',
    label: 'High-Gait Swimmer',
    build: () => {
      const cfg = createDefaultNeuralConfig();
      cfg.arDecay = [0.64, 0.68, 0.90, 0.86, 0.52, 0.76];
      cfg.resGain = [0.64, 0.72, 0.72, 0.55, 0.36, 0.70];
      cfg.bias = [0.04, 0.0, 0.42, 0.0, -0.45, 0.16];
      cfg.weights[5 * 6 + 2] = 0.62;
      return cfg;
    },
  },
];

const MOTIF_EDGES: Array<{ from: number; to: number; label: string; hint: string }> = [
  {
    from: 0,
    to: 2,
    label: 'Sense → Seek',
    hint: 'Forward scent strength amplifying forward flagella cruise.',
  },
  {
    from: 2,
    to: 4,
    label: 'Seek ⊣ Brake',
    hint: 'Mutual inhibition keeping forward flagella locked on during foraging.',
  },
  {
    from: 4,
    to: 2,
    label: 'Brake ⊣ Seek',
    hint: 'Reverse-flagella latch suppression against sudden jitter.',
  },
  {
    from: 3,
    to: 1,
    label: 'Commit → Turn',
    hint: 'Latched turning persistence carrying smoothly around obstacles.',
  },
  {
    from: 5,
    to: 2,
    label: 'Drive → Seek',
    hint: 'Metabolic hunger urgency scaling overall swim speed.',
  },
];

export const ResNetEditorPanel: React.FC<ResNetEditorPanelProps> = ({ config, onChange }) => {
  const [showCrossoverGuide, setShowCrossoverGuide] = useState<boolean>(true);

  const updateNeuronArray = (
    key: 'arDecay' | 'resGain' | 'bias',
    idx: number,
    val: number,
  ) => {
    const next: NeuralBlueprintConfig = {
      arDecay: [...config.arDecay],
      resGain: [...config.resGain],
      bias: [...config.bias],
      weights: [...config.weights],
    };
    next[key][idx] = val;
    onChange(next);
  };

  const updateEdgeWeight = (from: number, to: number, val: number) => {
    const next: NeuralBlueprintConfig = {
      arDecay: [...config.arDecay],
      resGain: [...config.resGain],
      bias: [...config.bias],
      weights: [...config.weights],
    };
    next.weights[from * 6 + to] = val;
    onChange(next);
  };

  return (
    <section className="space-y-4 rounded-xl border border-slate-800 bg-[#0D111A] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <BrainCircuit className="h-4 w-4 text-cyan-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              AR-ResNet Neural Controller Editor
            </h3>
          </div>
          <p className="text-xs text-slate-400">
            Tune auto-regressive persistence, residual skip gain, and inhibitory weights compiled into spawned organisms.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {CONTROLLER_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(p.build())}
              className="rounded-md border border-slate-800 bg-[#090C12] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 transition-colors whitespace-nowrap"
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onChange(createDefaultNeuralConfig())}
            title="Reset weights & decay parameters"
            className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* 6 Neuron Auto-Regressive & Residual Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {NEURON_LABELS.map((label, idx) => (
          <div
            key={label}
            className="space-y-2.5 rounded-lg border border-slate-800/90 bg-[#090C12] p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-cyan-300">
                N{idx} · {label}
              </span>
              <span className="text-[10px] text-slate-400 truncate">
                {NEURON_DESCRIPTIONS[idx]}
              </span>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>AR Persistence (α)</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {config.arDecay[idx].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.25}
                max={0.94}
                step={0.02}
                value={config.arDecay[idx]}
                onChange={(e) => updateNeuronArray('arDecay', idx, Number(e.target.value))}
                className="lab-slider w-full"
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Residual Skip (ρ)</span>
                <span className="font-mono tabular-nums text-emerald-300">
                  {config.resGain[idx].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.1}
                max={0.95}
                step={0.02}
                value={config.resGain[idx]}
                onChange={(e) => updateNeuronArray('resGain', idx, Number(e.target.value))}
                className="lab-slider w-full"
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Bias (b)</span>
                <span className="font-mono tabular-nums text-amber-300">
                  {config.bias[idx] >= 0 ? `+${config.bias[idx].toFixed(2)}` : config.bias[idx].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={-0.6}
                max={0.6}
                step={0.02}
                value={config.bias[idx]}
                onChange={(e) => updateNeuronArray('bias', idx, Number(e.target.value))}
                className="lab-slider w-full"
              />
            </div>
          </div>
        ))}
      </div>

      {/* Synaptic Latch & Coupling Motifs */}
      <div className="space-y-2.5 rounded-lg border border-slate-800/90 bg-[#090C12] p-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-200">
            Key Synaptic Couplings (W[from → to])
          </span>
          <span className="font-mono text-[10px] text-slate-500">
            6×6 recurrent matrix ({config.weights.length} weights)
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          {MOTIF_EDGES.map((edge) => {
            const wIdx = edge.from * 6 + edge.to;
            const val = config.weights[wIdx] ?? BASE_WEIGHTS[wIdx];
            return (
              <div key={edge.label} className="space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-mono text-slate-300">{edge.label}</span>
                  <span
                    className={`font-mono tabular-nums ${
                      val < 0 ? 'text-rose-300' : 'text-cyan-300'
                    }`}
                  >
                    {val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={-1.5}
                  max={1.2}
                  step={0.05}
                  value={val}
                  onChange={(e) => updateEdgeWeight(edge.from, edge.to, Number(e.target.value))}
                  className="lab-slider w-full"
                />
                <p className="text-[10px] leading-snug text-slate-500">{edge.hint}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Crossover & Mating Explanation */}
      <div className="rounded-lg border border-slate-800/90 bg-[#090C12] p-3.5 space-y-2">
        <button
          type="button"
          onClick={() => setShowCrossoverGuide((s) => !s)}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            <GitMerge className="h-3.5 w-3.5 text-cyan-400" />
            <span>How Neurons &amp; Directive Graphs Recombine During Mating</span>
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-cyan-300">
            <Info className="h-3 w-3" />
            {showCrossoverGuide ? 'Hide' : 'Show'}
          </span>
        </button>

        {showCrossoverGuide && (
          <div className="grid grid-cols-1 gap-3 pt-1 text-[11px] leading-relaxed text-slate-400 md:grid-cols-2">
            <div className="space-y-1.5 rounded border border-slate-800/80 bg-[#0D111A] p-2.5">
              <div className="font-semibold text-slate-200">
                1. Directive Graph Mipmap Recombination
              </div>
              <p>
                When two organisms mate, a stochastic anatomical cleave plane (horizontal or vertical around midline) slices the 128×128 blueprints of Parent A and Parent B. Parent A contributes coarse L3/L2 organ domains on one side and Parent B on the other; morphological closing heals thin seam gaps, somatic mutations diversify ~1.5% of interior cells (including Digestive, Excretory, Vascular, Neural, and Spike domains), and the compiler extracts a seamless unified L3→L0 parent-child directive graph.
              </p>
            </div>
            <div className="space-y-1.5 rounded border border-slate-800/80 bg-[#0D111A] p-2.5">
              <div className="font-semibold text-slate-200">
                2. AR-ResNet Neural Controller Inheritance
              </div>
              <p>
                Each neuron computes{' '}
                <code className="font-mono text-cyan-300">
                  h = α·h_prev + (1−α)[ρ·residual + (1−ρ)·tanh(b + W·h_prev + u)]
                </code>
                . During mating, every neuron&apos;s persistence <code className="font-mono text-slate-200">α</code>, residual gain <code className="font-mono text-slate-200">ρ</code>, bias <code className="font-mono text-slate-200">b</code>, and all 36 synaptic weights <code className="font-mono text-slate-200">W</code> undergo allele-level uniform crossover between Parent A and Parent B plus ±0.03 evolutionary jitter—inheriting both swimming instincts and morphological traits together.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
