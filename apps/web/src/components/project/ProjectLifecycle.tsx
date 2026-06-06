'use client';
import { useMemo } from 'react';
import Link from 'next/link';
import { Check, AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import { StatusPill, type StatusTone } from '@/components/StatusPill';
import { ActionButton } from '@/components/ActionButton';

type StageState = 'done' | 'active' | 'pending' | 'attention' | 'optional';
const STATE_TONE: Record<StageState, StatusTone> = {
  done: 'success', active: 'progress', pending: 'neutral', attention: 'warn', optional: 'neutral',
};

interface Floor { _id: string; name: string; analysis?: { status?: string }; counts?: { rooms?: number; placements?: number } }
interface Project { _id: string; status?: string; delivery?: { status?: string }; stats?: { lastExportAt?: string }; floors?: Floor[] }

/**
 * The project lifecycle spine. Computes each of the 10 stages' status purely from data
 * the project already returns (project.status, delivery, floors.analysis, counts) — no
 * new endpoints. Surfaces "where am I", the single next action, and what needs attention.
 */
export function ProjectLifecycle({
  project, onExport, onUpload, onPatchStatus, busy, hideAttention,
}: {
  project: Project;
  onExport: () => void;
  onUpload: () => void;
  onPatchStatus: (status: string) => Promise<void> | void;
  busy?: { upload?: boolean; export?: boolean };
  hideAttention?: boolean;
}) {
  const model = useMemo(() => computeLifecycle(project), [project]);
  const firstFloor = project.floors?.[0]?._id;
  const floors = project.floors ?? [];
  const activeAnalysis = floors.filter((f) => ['queued', 'processing'].includes(f.analysis?.status ?? '')).length;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      {/* Stepper */}
      <div className="flex flex-wrap items-center gap-1.5">
        {model.stages.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
              s.state === 'done' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : s.state === 'attention' ? 'border-amber-300 bg-amber-50 text-amber-800'
              : s.key === model.currentKey ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-200 bg-white text-slate-500'}`}>
              <span className={`grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold ${
                s.state === 'done' ? 'bg-emerald-500 text-white'
                : s.key === model.currentKey ? 'bg-white text-slate-900'
                : 'bg-slate-200 text-slate-600'}`}>
                {s.state === 'done' ? <Check className="h-2.5 w-2.5" /> : i + 1}
              </span>
              {s.label}
            </div>
            {i < model.stages.length - 1 && <ArrowRight className="h-3 w-3 text-slate-300" />}
          </div>
        ))}
      </div>

      {/* Where am I + next action */}
      <div className="mt-4 flex flex-col gap-3 rounded-lg bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Current stage</span>
            <StatusPill status={model.current.state} label={model.current.label} tone={STATE_TONE[model.current.state]} />
          </div>
          <p className="mt-1 text-sm text-slate-600">{model.current.hint}</p>
        </div>
        <NextAction action={model.next} firstFloor={firstFloor} onExport={onExport} onUpload={onUpload}
          onPatchStatus={onPatchStatus} busy={busy} />
      </div>

      {/* Background activity (derived from live floor/job state) */}
      {(activeAnalysis > 0 || busy?.export) && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-700">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {activeAnalysis > 0 && <span>Analyzing {activeAnalysis} floor{activeAnalysis === 1 ? '' : 's'} in the background…</span>}
          {busy?.export && <span>{activeAnalysis > 0 ? ' · ' : ''}Rendering client PDF…</span>}
        </div>
      )}

      {/* Needs attention */}
      {!hideAttention && model.attention.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" /> Needs attention ({model.attention.length})
          </div>
          <ul className="space-y-1">
            {model.attention.map((a, i) => (
              <li key={i} className="flex items-center justify-between text-xs text-amber-900">
                <span>{a.message}</span>
                {a.floorId && <Link href={`/editor/${a.floorId}`} className="font-medium text-amber-700 hover:underline">Open →</Link>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function NextAction({ action, firstFloor, onExport, onUpload, onPatchStatus, busy }: any) {
  if (!action) return null;
  const base = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium';
  switch (action.kind) {
    case 'upload':
      return <button className={`${base} bg-slate-900 text-white disabled:opacity-50`} onClick={onUpload} disabled={busy?.upload}>{busy?.upload ? 'Processing…' : 'Upload plan'}</button>;
    case 'editor':
      return firstFloor ? <Link className={`${base} bg-slate-900 text-white`} href={`/editor/${firstFloor}`}>{action.label}</Link> : null;
    case 'approve':
      return <ActionButton onRun={() => Promise.resolve(onPatchStatus('review'))} idle="Approve design" busy="Approving…" success="Approved" stage="Approve design" />;
    case 'export':
      return <button className={`${base} bg-slate-900 text-white disabled:opacity-50`} onClick={onExport} disabled={busy?.export}>{busy?.export ? 'Exporting…' : 'Export client PDF'}</button>;
    case 'deliver':
      return <ActionButton onRun={() => Promise.resolve(onPatchStatus('delivered'))} idle="Mark delivered" busy="Updating…" success="Delivered" variant="primary" stage="Mark delivered" />;
    default:
      return <span className="text-sm text-slate-400">{action.label}</span>;
  }
}

// ── Lifecycle computation (pure, from existing project data) ─────────────────────
function computeLifecycle(p: Project) {
  const floors = p.floors ?? [];
  const status = p.status ?? 'draft';
  const delivery = p.delivery?.status ?? 'draft';
  const hasFloors = floors.length > 0;
  const aStatuses = floors.map((f) => f.analysis?.status ?? 'none');
  const anyFailed = aStatuses.includes('failed');
  const anyRunning = aStatuses.some((s) => s === 'queued' || s === 'processing');
  const allAnalyzed = hasFloors && aStatuses.every((s) => s === 'done');
  const placementsTotal = floors.reduce((n, f) => n + (f.counts?.placements ?? 0), 0);
  const beyondReview = ['review', 'delivered', 'archived'].includes(status);
  const archived = status === 'archived';
  const delivered = status === 'delivered' || delivery === 'delivered';

  const st = (state: StageState) => state;
  const stages: { key: string; label: string; state: StageState }[] = [
    { key: 'create', label: 'Project', state: 'done' },
    { key: 'upload', label: 'Upload', state: hasFloors ? 'done' : 'active' },
    { key: 'analysis', label: 'Analysis', state: !hasFloors ? 'pending' : anyFailed ? 'attention' : anyRunning ? 'active' : allAnalyzed ? 'done' : 'active' },
    { key: 'spaces', label: 'Space Review', state: !allAnalyzed ? 'pending' : beyondReview ? 'done' : 'active' },
    { key: 'devices', label: 'Devices', state: placementsTotal > 0 ? (beyondReview ? 'done' : 'active') : allAnalyzed ? 'active' : 'pending' },
    { key: 'engineer', label: 'Engineer Review', state: beyondReview ? 'done' : placementsTotal > 0 ? 'active' : 'pending' },
    { key: 'optimize', label: 'Optimize', state: 'optional' },
    { key: 'delivery', label: 'Delivery', state: delivered ? 'done' : ['ready', 'exported'].includes(delivery) || p.stats?.lastExportAt ? 'active' : placementsTotal > 0 ? 'active' : 'pending' },
    { key: 'training', label: 'Training', state: 'optional' },
    { key: 'archive', label: 'Archive', state: archived ? 'done' : 'optional' },
  ];

  // Current = first attention, else first active, else last.
  const current = stages.find((s) => s.state === 'attention')
    ?? stages.find((s) => s.state === 'active')
    ?? stages[stages.length - 1];

  const HINTS: Record<string, string> = {
    upload: 'Upload a PDF or image plan — each page becomes a floor and is analyzed automatically.',
    analysis: anyFailed ? 'One or more floors failed analysis. Open the floor to retry.' : anyRunning ? 'The AI is analyzing your floors. This streams live in each floor.' : 'Open a floor and run analysis to detect spaces and devices.',
    spaces: 'Review the detected spaces in the editor — fix types, accept or reject, add missed spaces.',
    devices: 'Review the suggested devices in the editor; every suggestion is editable.',
    engineer: 'Approve the design when the placements look right for the client.',
    delivery: 'Export a client-ready PDF, then mark the project delivered.',
    archive: 'Archive the project to keep a read-only snapshot.',
    create: 'Project created.',
  };
  const cur = { ...current, label: stageLabel(current.key), hint: HINTS[current.key] ?? '' };

  // Next action for the current stage.
  let next: { kind: string; label: string } | null = null;
  if (current.key === 'upload') next = { kind: 'upload', label: 'Upload plan' };
  else if (current.key === 'analysis') next = anyRunning ? { kind: 'info', label: 'Analysis running…' } : { kind: 'editor', label: 'Open floor to analyze' };
  else if (current.key === 'spaces') next = { kind: 'editor', label: 'Review spaces' };
  else if (current.key === 'devices') next = { kind: 'editor', label: 'Review devices' };
  else if (current.key === 'engineer') next = { kind: 'approve', label: 'Approve design' };
  else if (current.key === 'delivery') next = delivered ? { kind: 'info', label: 'Delivered' } : { kind: 'export', label: 'Export PDF' };
  else if (current.key === 'archive' && !archived) next = delivered ? { kind: 'deliver', label: 'Delivered' } : null;

  // Needs attention.
  const attention: { message: string; floorId?: string }[] = [];
  for (const f of floors) {
    if ((f.analysis?.status ?? 'none') === 'failed') attention.push({ message: `${f.name}: analysis failed — open to retry`, floorId: f._id });
    else if ((f.analysis?.status ?? 'none') === 'done' && (f.counts?.placements ?? 0) === 0) attention.push({ message: `${f.name}: analyzed but no devices yet`, floorId: f._id });
  }
  if (hasFloors && allAnalyzed && placementsTotal > 0 && !beyondReview) {
    attention.push({ message: 'Design ready for engineer review — approve when correct' });
  }

  return { stages, currentKey: current.key, current: cur, next, attention };
}

function stageLabel(key: string): string {
  return ({ create: 'Project Creation', upload: 'Plan Upload', analysis: 'AI Analysis', spaces: 'Space Review',
    devices: 'Device Placement', engineer: 'Engineer Review', optimize: 'Optimization', delivery: 'Client Delivery',
    training: 'Training & Feedback', archive: 'Archive' } as Record<string, string>)[key] ?? key;
}
