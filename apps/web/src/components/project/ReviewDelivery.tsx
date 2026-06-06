'use client';
import Link from 'next/link';
import { Check, AlertTriangle, X, Download, FileText } from 'lucide-react';
import { StatusPill } from '@/components/StatusPill';
import { ActionButton } from '@/components/ActionButton';
import {
  computeReadiness, buildAttention, formatBytes,
  type DeliveryOverview, type ChecklistItem, type AttentionItem,
} from '@/lib/readiness';

// ── Readiness score ──────────────────────────────────────────────────────────
export function ReadinessCard({ overview }: { overview?: DeliveryOverview | null }) {
  const { score, blockers, passed, total } = computeReadiness(overview);
  const tone = score >= 90 ? 'text-emerald-600' : score >= 60 ? 'text-amber-600' : 'text-red-600';
  const ring = score >= 90 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-4">
        <div className="relative grid h-20 w-20 place-items-center">
          <svg viewBox="0 0 36 36" className="h-20 w-20 -rotate-90">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="#e2e8f0" strokeWidth="3" />
            <circle cx="18" cy="18" r="15.5" fill="none" stroke={ring} strokeWidth="3" strokeLinecap="round"
              strokeDasharray={`${(score / 100) * 97.4} 97.4`} />
          </svg>
          <span className={`absolute text-lg font-bold ${tone}`}>{score}%</span>
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-800">Customer readiness</div>
          <div className="text-xs text-slate-500">{passed} of {total} checks passing</div>
          {blockers.length > 0 && <div className="mt-1 text-xs text-amber-600">{blockers.length} item{blockers.length === 1 ? '' : 's'} blocking 100%</div>}
          {blockers.length === 0 && total > 0 && <div className="mt-1 text-xs text-emerald-600">Ready for delivery</div>}
        </div>
      </div>
      {blockers.length > 0 && (
        <ul className="mt-3 space-y-1">
          {blockers.map((b) => (
            <li key={b.id} className="text-xs text-slate-600">
              <span className={b.status === 'fail' ? 'text-red-500' : 'text-amber-500'}>●</span> {b.label}{b.detail ? ` — ${b.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Review checklist ─────────────────────────────────────────────────────────
const CHECK_ICON: Record<ChecklistItem['status'], React.ReactNode> = {
  pass: <Check className="h-4 w-4 text-emerald-500" />,
  warn: <AlertTriangle className="h-4 w-4 text-amber-500" />,
  fail: <X className="h-4 w-4 text-red-500" />,
};

export function ReviewPanel({ overview, onSetDelivery }: {
  overview?: DeliveryOverview | null;
  onSetDelivery: (status: string) => Promise<unknown>;
}) {
  const items = overview?.checklist ?? [];
  const hasFail = items.some((i) => i.status === 'fail');
  const approved = overview?.deliveryStatus && overview.deliveryStatus !== 'draft';
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-1"><ReadinessCard overview={overview} /></div>
      <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Engineer review checklist</h2>
          <StatusPill status={approved ? 'reviewed' : 'needs_review'} label={approved ? 'Approved' : 'Awaiting approval'} />
        </div>
        {items.length === 0 && <p className="text-xs text-slate-400">Run analysis and place devices to populate the review checklist.</p>}
        <ul className="divide-y divide-slate-100">
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-2 py-2">
              <span className="mt-0.5">{CHECK_ICON[i.status]}</span>
              <div>
                <div className="text-sm text-slate-800">{i.label}</div>
                {i.detail && <div className="text-xs text-slate-500">{i.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center gap-3">
          <ActionButton
            onRun={() => onSetDelivery('ready')}
            idle={approved ? 'Re-approve design' : 'Approve design'}
            busy="Approving…" success="Approved"
            disabled={hasFail || items.length === 0}
            stage="Approve design"
          />
          {hasFail && <span className="text-xs text-red-500">Resolve failing checks before approval.</span>}
        </div>
      </div>
    </div>
  );
}

// ── Delivery ─────────────────────────────────────────────────────────────────
export function DeliveryPanel({ overview, onExport, onSetDelivery }: {
  overview?: DeliveryOverview | null;
  onExport: () => void;
  onSetDelivery: (status: string) => Promise<unknown>;
}) {
  const status = overview?.deliveryStatus ?? 'draft';
  const history = overview?.history ?? [];
  const latestDone = history.find((h) => h.status === 'done');
  const STATUS_LABEL: Record<string, string> = { draft: 'Draft', ready: 'Ready for review', exported: 'Exported', delivered: 'Delivered' };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Client delivery</h2>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-xs text-slate-500">Status</span>
              <StatusPill status={status} label={STATUS_LABEL[status]} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status === 'draft' && <ActionButton variant="ghost" onRun={() => onSetDelivery('ready')} idle="Mark ready for review" busy="…" success="Ready" stage="Mark ready" />}
            <button onClick={onExport} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800">
              <FileText className="h-4 w-4" /> Export client PDF
            </button>
            {(status === 'exported' || latestDone) && <ActionButton variant="primary" onRun={() => onSetDelivery('delivered')} idle="Mark delivered" busy="…" success="Delivered" stage="Mark delivered" />}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-center">
          <Stat label="Floors" value={overview?.summary.floors ?? 0} />
          <Stat label="Devices" value={overview?.summary.devices ?? 0} />
          <Stat label="Avg confidence" value={overview?.ai.avgConfidence != null ? `${Math.round(overview.ai.avgConfidence * 100)}%` : '—'} />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Client-ready package: {latestDone
            ? <span className="text-emerald-600">PDF generated{latestDone.pages ? ` · ${latestDone.pages} pages` : ''}{latestDone.exportedBy ? ` · by ${latestDone.exportedBy}` : ''}</span>
            : <span className="text-slate-400">no export yet — generate the PDF above</span>}
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Export history</h2>
        {history.length === 0 ? <p className="text-xs text-slate-400">No exports yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <tr><th className="py-1 pr-3">When</th><th className="pr-3">Version</th><th className="pr-3">Floors</th><th className="pr-3">Pages</th><th className="pr-3">Size</th><th className="pr-3">By</th><th className="pr-3">Status</th><th>PDF</th></tr>
              </thead>
              <tbody className="text-slate-600">
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-slate-100">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{h.finishedAt ? new Date(h.finishedAt).toLocaleString() : h.createdAt ? new Date(h.createdAt).toLocaleString() : '—'}</td>
                    <td className="pr-3">{h.versionName ?? `${h.style ?? 'standard'}`}</td>
                    <td className="pr-3">{h.floors ?? '—'}</td>
                    <td className="pr-3">{h.pages ?? '—'}</td>
                    <td className="pr-3">{formatBytes(h.sizeBytes)}</td>
                    <td className="pr-3">{h.exportedBy ?? '—'}</td>
                    <td className="pr-3"><StatusPill status={h.status} /></td>
                    <td>{h.downloadUrl ? <a href={h.downloadUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-brand hover:underline"><Download className="h-3 w-3" />PDF</a> : (h.error ? <span className="text-red-500" title={h.error}>failed</span> : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-lg border border-slate-100 bg-slate-50 py-2"><div className="text-lg font-bold text-slate-900">{value}</div><div className="text-[11px] text-slate-500">{label}</div></div>;
}

// ── Attention queue ──────────────────────────────────────────────────────────
export function AttentionQueue({ overview, onTab }: { overview?: DeliveryOverview | null; onTab?: (tab: string) => void }) {
  const items = buildAttention(overview);
  if (items.length === 0) {
    return <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">✓ Nothing needs attention — the project is on track.</div>;
  }
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-800">
        <AlertTriangle className="h-3.5 w-3.5" /> Needs attention ({items.length})
      </div>
      <ul className="space-y-1">
        {items.map((a: AttentionItem, i) => (
          <li key={i} className="flex items-center justify-between text-xs text-amber-900">
            <span>{a.message}</span>
            {a.href ? <Link href={a.href} className="font-medium text-amber-700 hover:underline">Open →</Link>
              : a.tab && onTab ? <button onClick={() => onTab(a.tab!)} className="font-medium text-amber-700 hover:underline">Go →</button> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
