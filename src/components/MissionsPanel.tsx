import React, { useState } from 'react';
import { Award, CheckCircle2, RotateCcw, Target } from 'lucide-react';
import { ProgressionEvaluatedItem, ProgressionKind } from '../engine/progression';

interface MissionsPanelProps {
  items: ProgressionEvaluatedItem[];
  onResetProgress: () => void;
}

export const MissionsPanel: React.FC<MissionsPanelProps> = ({
  items,
  onResetProgress,
}) => {
  const [filter, setFilter] = useState<'all' | ProgressionKind>('all');

  const missions = items.filter((i) => i.kind === 'mission');
  const achievements = items.filter((i) => i.kind === 'achievement');
  const missionsDone = missions.filter((m) => m.completed).length;
  const achDone = achievements.filter((a) => a.completed).length;

  const visible =
    filter === 'all' ? items : items.filter((item) => item.kind === filter);

  return (
    <div className="mx-auto w-full max-w-[1160px] flex-1 p-4 sm:p-6 space-y-6">
      {/* Header Summary Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-base font-semibold text-slate-100">
            Research Missions &amp; Lab Achievements
          </h1>
          <p className="mt-0.5 text-xs text-slate-400">
            Progress updates continuously from the WebGL2 World Ecosystem and Blueprint Designer.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-4 rounded-lg border border-slate-800 bg-[#0D111A] px-3.5 py-2 font-mono text-xs tabular-nums">
            <span className="text-cyan-300">
              Missions {missionsDone}/{missions.length}
            </span>
            <span className="text-slate-700">|</span>
            <span className="text-amber-300">
              Achievements {achDone}/{achievements.length}
            </span>
          </div>

          <button
            type="button"
            onClick={onResetProgress}
            className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0E131D] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset Progress</span>
          </button>
        </div>
      </div>

      {/* Filter Segmented Bar */}
      <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0D111A] p-1 w-fit">
        {(
          [
            { id: 'all', label: `All (${items.length})` },
            { id: 'mission', label: `Missions (${missionsDone}/${missions.length})` },
            { id: 'achievement', label: `Achievements (${achDone}/${achievements.length})` },
          ] as Array<{ id: 'all' | ProgressionKind; label: string }>
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={`min-h-[36px] rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              filter === tab.id
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Cards Grid */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {visible.map((item) => {
          const isMission = item.kind === 'mission';
          const formattedVal =
            item.target < 10 && !Number.isInteger(item.target)
              ? item.current.toFixed(1)
              : Math.round(item.current).toString();
          const formattedTarget =
            item.target < 10 && !Number.isInteger(item.target)
              ? item.target.toFixed(1)
              : item.target.toString();

          return (
            <div
              key={item.id}
              className={`rounded-lg border p-4 transition-colors ${
                item.completed
                  ? isMission
                    ? 'border-cyan-500/45 bg-cyan-950/15'
                    : 'border-amber-500/45 bg-amber-950/15'
                  : 'border-slate-800 bg-[#0D111A]'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <div
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
                      item.completed
                        ? isMission
                          ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
                          : 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                        : 'border-slate-800 bg-[#090C12] text-slate-400'
                    }`}
                  >
                    {item.completed ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : isMission ? (
                      <Target className="h-4 w-4" />
                    ) : (
                      <Award className="h-4 w-4" />
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-slate-100 truncate">
                        {item.title}
                      </h2>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500 shrink-0">
                        {isMission ? 'Mission' : 'Achievement'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">
                      {item.description}
                    </p>
                  </div>
                </div>

                <span
                  className={`font-mono text-xs font-semibold tabular-nums shrink-0 ${
                    item.completed
                      ? isMission
                        ? 'text-cyan-300'
                        : 'text-amber-300'
                      : 'text-slate-400'
                  }`}
                >
                  {item.completed ? 'Complete' : `${item.progressPct}%`}
                </span>
              </div>

              {/* Tabular Progress Bar */}
              <div className="mt-3 space-y-1">
                <div className="h-1.5 w-full overflow-hidden rounded-sm bg-slate-800/90">
                  <div
                    className={`h-full transition-all duration-300 ${
                      item.completed
                        ? isMission
                          ? 'bg-cyan-400'
                          : 'bg-amber-400'
                        : isMission
                          ? 'bg-cyan-600/80'
                          : 'bg-slate-500'
                    }`}
                    style={{ width: `${item.progressPct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-slate-500">
                  <span>
                    {formattedVal} / {formattedTarget} {item.unitLabel}
                  </span>
                  {item.unlockedAt && (
                    <span>
                      Unlocked {new Date(item.unlockedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
