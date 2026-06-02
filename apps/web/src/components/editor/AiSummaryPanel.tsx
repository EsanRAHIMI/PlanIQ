'use client';

import type { AnalysisQcSummary } from '@planiq/shared';

export function AiSummaryPanel({
  summary,
  debugMode,
  onToggleDebug,
}: {
  summary: AnalysisQcSummary | null;
  debugMode: boolean;
  onToggleDebug: () => void;
}) {
  if (!summary) {
    return (
      <div className="border-t border-slate-200 bg-white p-4 text-xs text-slate-500">
        No AI summary yet. Run analysis from project upload.
      </div>
    );
  }

  return (
    <div className="border-t border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
        <span className="text-xs font-semibold text-slate-800">AI suggestion summary</span>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
          <input type="checkbox" checked={debugMode} onChange={onToggleDebug} className="rounded" />
          Debug (show rejected)
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2 p-4 text-xs">
        <Stat label="Detected spaces" value={summary.detectedSpaces} />
        <Stat label="Accepted spaces" value={summary.acceptedSpaces} accent="emerald" />
        <Stat label="Raw suggestions" value={summary.rawPlacements} />
        <Stat label="Accepted devices" value={summary.acceptedPlacements} accent="emerald" />
        <Stat label="Rejected spaces" value={summary.rejectedSpaces} accent="amber" />
        <Stat label="Rejected devices" value={summary.rejectedPlacements} accent="red" />
      </div>

      {summary.rejections?.length > 0 && (
        <div className="max-h-40 overflow-y-auto border-t border-slate-100 px-4 py-2">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">Rejections</p>
          <ul className="space-y-1">
            {summary.rejections.slice(0, 12).map((r, i) => (
              <li key={i} className="text-[11px] text-slate-600">
                <span className="font-medium text-slate-800">{r.deviceCode}</span>
                {r.nearSpace && <span className="text-slate-400"> · {r.nearSpace}</span>}
                <span className="text-slate-500"> — {r.reason}</span>
              </li>
            ))}
          </ul>
          {summary.rejections.length > 12 && (
            <p className="mt-1 text-[10px] text-slate-400">+{summary.rejections.length - 12} more</p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'emerald' | 'amber' | 'red' }) {
  const color = accent === 'emerald' ? 'text-emerald-700' : accent === 'amber' ? 'text-amber-700' : accent === 'red' ? 'text-red-600' : 'text-slate-800';
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-2">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}
