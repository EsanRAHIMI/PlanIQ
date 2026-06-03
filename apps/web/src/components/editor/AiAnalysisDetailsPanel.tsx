'use client';

import { useMemo } from 'react';
import type { AnalysisQcSummary, AnalysisRunTrace } from '@planiq/shared';
import { PROVIDER_LABELS, lastRunSummaryLabel, runCompletionSummary, usedFallback } from '@planiq/shared';

export function AiAnalysisDetailsPanel({
  runs,
  activeRun,
  onSelectRun,
  liveRun,
  qcSummary,
  debugMode,
  onToggleDebug,
}: {
  runs: AnalysisRunTrace[];
  activeRun: AnalysisRunTrace | null;
  onSelectRun: (id: string) => void;
  liveRun?: AnalysisRunTrace | null;
  qcSummary?: AnalysisQcSummary | null;
  debugMode: boolean;
  onToggleDebug: () => void;
}) {
  const display = liveRun ?? activeRun;
  const summary = display?.qcSummary ?? qcSummary;
  const lastRunLabel = useMemo(() => lastRunSummaryLabel(display ?? activeRun), [display, activeRun]);

  const statusColor = useMemo(() => {
    if (!display) return 'text-slate-500';
    if (display.status === 'running') return 'text-sky-600';
    if (display.status === 'failed') return 'text-red-600';
    return 'text-emerald-700';
  }, [display]);

  return (
    <div className="border-t border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
        <span className="text-xs font-semibold text-slate-800">AI Analysis Details</span>
        <div className="flex items-center gap-2">
          {runs.length > 1 && (
            <select
              className="input max-w-[260px] py-1 text-[11px]"
              value={activeRun?.id ?? ''}
              onChange={(e) => onSelectRun(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id!}>
                  {formatRunOption(r)}
                </option>
              ))}
            </select>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
            <input type="checkbox" checked={debugMode} onChange={onToggleDebug} className="rounded" />
            Debug (show rejected)
          </label>
        </div>
      </div>

      <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
        <p className="text-xs font-semibold text-slate-800">{lastRunLabel}</p>
        {display && display.status !== 'running' && (
          <p className="mt-0.5 text-[11px] text-slate-500">
            {runCompletionSummary(display)}
            {usedFallback(display) ? ' · Fallback was used' : ' · No LLM fallback'}
          </p>
        )}
        {display?.status === 'running' && (
          <p className="mt-0.5 text-[11px] text-sky-600">Run in progress…</p>
        )}
      </div>

      {!display && !summary && (
        <p className="px-4 py-3 text-xs text-slate-500">
          No analysis run recorded yet. Use <strong>Re-run Rule Suggestions</strong> (internal rules only) or{' '}
          <strong>Run Full AI Analysis</strong> (CV pipeline) above.
        </p>
      )}

      {display && (
        <div className="space-y-3 px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 font-medium capitalize ${statusColor} border-current/20 bg-slate-50`}>
              {display.status === 'running' ? 'Running…' : display.status}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
              {display.kind === 'rules_resuggest' ? 'Rule suggestions (no CV)' : 'Full plan analysis (CV pipeline)'}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Row label="Engine" value={PROVIDER_LABELS[display.provider] ?? display.provider} />
            <Row label="Model" value={display.modelName ?? '—'} />
            <Row label="Started" value={formatTime(display.startedAt)} />
            <Row label="Duration" value={display.durationMs != null ? `${(display.durationMs / 1000).toFixed(1)}s` : display.status === 'running' ? '…' : '—'} />
            <Row label="Finished" value={display.finishedAt ? formatTime(display.finishedAt) : '—'} />
            <Row label="Fallback used" value={usedFallback(display) ? 'Yes' : 'No'} />
          </dl>

          {display.fallbackChain.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">Pipeline chain</p>
              <p className="font-mono text-[11px] text-slate-600">{display.fallbackChain.join(' → ')}</p>
            </div>
          )}

          <div>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">QC settings applied</p>
            <pre className="max-h-24 overflow-auto rounded-lg border border-slate-100 bg-slate-50 p-2 font-mono text-[10px] text-slate-600">
              {JSON.stringify(display.qcSettings ?? {}, null, 2)}
            </pre>
          </div>

          {summary && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Detected spaces" value={display.detectedSpaces ?? summary.detectedSpaces} />
              <Stat label="Accepted spaces" value={display.acceptedSpaces ?? summary.acceptedSpaces} accent="emerald" />
              <Stat label="Rejected spaces" value={display.rejectedSpaces ?? summary.rejectedSpaces} accent="amber" />
              <Stat label="Accepted devices" value={display.acceptedDevices ?? summary.acceptedPlacements} accent="emerald" />
              <Stat label="Rejected devices" value={display.rejectedDevices ?? summary.rejectedPlacements} accent="red" />
              <Stat label="Raw suggestions" value={summary.rawPlacements} />
            </div>
          )}

          {display.errors.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-2">
              <p className="mb-1 text-[10px] font-semibold uppercase text-red-700">Errors</p>
              <ul className="list-inside list-disc text-[11px] text-red-800">
                {display.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          {display.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
              <p className="mb-1 text-[10px] font-semibold uppercase text-amber-800">Warnings</p>
              <ul className="list-inside list-disc text-[11px] text-amber-900">
                {display.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {summary?.rejections?.length ? (
            <div className="max-h-32 overflow-y-auto border-t border-slate-100 pt-2">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">QC rejections</p>
              <ul className="space-y-1">
                {summary.rejections.slice(0, 12).map((r, i) => (
                  <li key={i} className="text-[11px] text-slate-600">
                    <span className="font-medium text-slate-800">{r.deviceCode}</span>
                    {r.nearSpace && <span className="text-slate-400"> · {r.nearSpace}</span>}
                    <span className="text-slate-500"> — {r.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function formatRunOption(r: AnalysisRunTrace) {
  const t = new Date(r.startedAt).toLocaleString();
  const kind = r.kind === 'rules_resuggest' ? 'Internal Rules' : 'Full CV';
  const engine = r.kind === 'rules_resuggest' ? 'Rules + QC' : (r.provider === 'cv' ? 'CV Pipeline' : `${r.provider} fallback`);
  return `${t} · ${kind} · ${engine} · ${r.status}`;
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
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
