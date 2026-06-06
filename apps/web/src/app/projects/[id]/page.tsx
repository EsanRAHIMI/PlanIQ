'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Upload, ArrowRight } from 'lucide-react';
import { api, formatApiError } from '@/lib/api';
import { toast } from '@/lib/toast';
import { ProcessingTimeline } from '@/components/upload/ProcessingTimeline';
import { AppHeader } from '@/components/AppHeader';
import { StatusPill } from '@/components/StatusPill';
import { ProjectLifecycle } from '@/components/project/ProjectLifecycle';
import { ReviewPanel, DeliveryPanel, AttentionQueue } from '@/components/project/ReviewDelivery';
import { ExportOptionsModal } from '@/components/delivery/ExportOptionsModal';
import { computeReadiness, type DeliveryOverview } from '@/lib/readiness';
import { usePlanUpload } from '@/hooks/usePlanUpload';
import type { ExportOptions } from '@planiq/shared';

const TABS = ['Overview', 'Floors', 'Editor', 'Review', 'Delivery', 'Activity'] as const;
type Tab = (typeof TABS)[number];

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<any>(null);
  const [delivery, setDelivery] = useState<DeliveryOverview | null>(null);
  const [tab, setTab] = useState<Tab>('Overview');
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [p, d] = await Promise.all([
      api.get<any>(`/projects/${id}`),
      api.get<DeliveryOverview>(`/projects/${id}/delivery`).catch(() => null),
    ]);
    setProject(p); if (d) setDelivery(d);
  }, [id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const { session, upload, clearPolling } = usePlanUpload(id, refresh);
  useEffect(() => () => clearPolling(), [clearPolling]);

  const uploading = session.status === 'uploading' || session.status === 'processing';
  const floorCount = project?.floors?.length ?? 0;
  const firstFloor = project?.floors?.[0]?._id;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try { await upload(file); } finally { if (fileRef.current) fileRef.current.value = ''; }
  }

  /** Single canonical lifecycle writer — every status change goes here (project.status SSOT). */
  async function setStatus(status: string) {
    await api.patch(`/projects/${id}/status`, { status });
    const msg: Record<string, string> = {
      review: 'Submitted for review', approved: 'Design approved',
      delivered: 'Marked delivered', archived: 'Project archived', in_progress: 'Reopened',
    };
    toast.success(msg[status] ?? 'Updated');
    await refresh();
  }

  async function runExport(opts: ExportOptions) {
    setExportOpen(false); setExporting(true);
    const toastId = toast.loading('Preparing PDF export…');
    try {
      const { exportId } = await api.post<any>(`/projects/${id}/export`, opts);
      toast.loading('Rendering floors & device schedule…', { id: toastId });
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts += 1;
        try {
          const exp = await api.get<any>(`/exports/${exportId}`);
          if (exp.status === 'done' && exp.downloadUrl) {
            clearInterval(poll); setExporting(false);
            toast.success(`PDF ready · ${exp.pages ?? ''} page${exp.pages === 1 ? '' : 's'}`.trim(), { id: toastId });
            window.open(exp.downloadUrl, '_blank', 'noopener'); await refresh();
          } else if (exp.status === 'failed') {
            clearInterval(poll); setExporting(false);
            toast.error(`Export failed${exp.error ? ` · ${exp.error}` : ''}`, { id: toastId }); await refresh();
          } else if (attempts >= 90) {
            clearInterval(poll); setExporting(false);
            toast.error('Export is taking longer than expected. Check Delivery shortly.', { id: toastId });
          }
        } catch (err) { clearInterval(poll); setExporting(false); toast.error(formatApiError(err, 'Export status'), { id: toastId }); }
      }, 2000);
    } catch (err) { setExporting(false); toast.error(formatApiError(err, 'Start export'), { id: toastId }); }
  }

  if (!project) {
    return <><AppHeader breadcrumbs={[{ label: 'Projects', href: '/dashboard' }]} /><main className="p-10 text-slate-500">Loading…</main></>;
  }

  const readiness = computeReadiness(delivery);
  const goTab = (t: string) => setTab(t as Tab);
  const onEditorTab = () => { if (firstFloor) router.push(`/editor/${firstFloor}`); else toast.info('Upload a plan first.'); };

  return (
    <>
      <AppHeader breadcrumbs={[{ label: 'Projects', href: '/dashboard' }, { label: project.name }]} />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-slate-900">{project.name}</h1>
              <StatusPill status={project.status} />
              {delivery && (delivery.summary?.floors ?? 0) > 0 && (
                <span className={`text-sm font-semibold ${readiness.score >= 90 ? 'text-emerald-600' : readiness.score >= 60 ? 'text-amber-600' : 'text-red-600'}`}>{readiness.score}% ready</span>
              )}
            </div>
            <p className="text-sm text-slate-500">{project.client?.name ?? 'No client'} · {floorCount} floor{floorCount === 1 ? '' : 's'}</p>
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? 'Processing…' : 'Upload plan'}</button>
            <button className="btn-primary" onClick={() => setExportOpen(true)} disabled={exporting || floorCount === 0}>{exporting ? 'Exporting…' : 'Export PDF'}</button>
            <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" hidden onChange={onFile} />
          </div>
        </header>

        {/* Sub-navigation */}
        <nav className="mt-6 flex flex-wrap gap-1 border-b border-slate-200">
          {TABS.map((t) => (
            <button key={t}
              onClick={() => (t === 'Editor' ? onEditorTab() : setTab(t))}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${tab === t && t !== 'Editor' ? 'border-slate-900 font-semibold text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {t}{t === 'Editor' && firstFloor ? ' ↗' : ''}
            </button>
          ))}
        </nav>

        <ExportOptionsModal open={exportOpen} onClose={() => setExportOpen(false)}
          floors={(project.floors ?? []).map((f: any) => ({ id: f._id, name: f.name }))}
          defaultClientName={project.client?.name} busy={exporting} onSubmit={runExport} />

        <div className="mt-6">
          {tab === 'Overview' && (
            <div className="space-y-4">
              <ProjectLifecycle project={project} onExport={() => setExportOpen(true)} onUpload={() => fileRef.current?.click()} onPatchStatus={setStatus} busy={{ upload: uploading, export: exporting }} hideAttention />
              {floorCount > 0 && <AttentionQueue overview={delivery} onTab={goTab} />}
              {floorCount === 0 && <Onboarding onUpload={() => fileRef.current?.click()} uploading={uploading} session={session} />}
            </div>
          )}

          {tab === 'Floors' && (
            <>
              <ProcessingTimeline visible={session.status !== 'idle'} steps={session.timeline} summary={session.message}
                meta={{ assetId: session.assetId, jobId: session.jobId, fileName: session.fileName }} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {project.floors?.map((f: any) => (
                  <Link key={f._id} href={`/editor/${f._id}`} className="card p-5 transition hover:border-slate-300 hover:shadow-md">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-slate-900">{f.name}</div>
                      <StatusPill status={f.analysis?.status ?? 'none'} />
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{f.kind} · level {f.level}</div>
                    <div className="mt-4 flex gap-4 text-xs text-slate-500"><span>{f.counts?.rooms ?? 0} spaces</span><span>{f.counts?.placements ?? 0} devices</span></div>
                  </Link>
                ))}
                {floorCount === 0 && <div className="col-span-full"><Onboarding onUpload={() => fileRef.current?.click()} uploading={uploading} session={session} /></div>}
              </div>
            </>
          )}

          {tab === 'Review' && <ReviewPanel overview={delivery} onSetStatus={setStatus} />}
          {tab === 'Delivery' && <DeliveryPanel overview={delivery} onExport={() => setExportOpen(true)} onSetStatus={setStatus} />}

          {tab === 'Activity' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <h2 className="mb-2 text-sm font-semibold text-slate-800">Floors &amp; analysis</h2>
                <ul className="divide-y divide-slate-100">
                  {project.floors?.map((f: any) => (
                    <li key={f._id} className="flex items-center justify-between py-2 text-sm">
                      <Link href={`/editor/${f._id}`} className="text-slate-700 hover:underline">{f.name}</Link>
                      <div className="flex items-center gap-3 text-xs text-slate-500">
                        <span>{f.counts?.placements ?? 0} devices</span>
                        <StatusPill status={f.analysis?.status ?? 'none'} />
                      </div>
                    </li>
                  ))}
                  {floorCount === 0 && <li className="py-2 text-xs text-slate-400">No floors yet.</li>}
                </ul>
              </div>
              <DeliveryPanel overview={delivery} onExport={() => setExportOpen(true)} onSetStatus={setStatus} readOnly />
            </div>
          )}
        </div>
      </main>
    </>
  );
}

// ── Onboarding empty state ───────────────────────────────────────────────────
function Onboarding({ onUpload, uploading, session }: { onUpload: () => void; uploading: boolean; session: any }) {
  const steps = ['Upload plan', 'Analyze', 'Review spaces', 'Suggest devices', 'Export PDF'];
  return (
    <div className="card p-8">
      <div className="mx-auto max-w-lg text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-slate-200 bg-slate-50"><Upload className="h-5 w-5 text-slate-400" /></div>
        <h3 className="mt-4 text-base font-semibold text-slate-900">Let’s set up this project</h3>
        <p className="mt-2 text-sm text-slate-500">Upload a PDF or image plan — each page becomes a floor and is analyzed automatically.</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5 text-xs">
          {steps.map((s, i) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={`rounded-full px-2.5 py-1 ${i === 0 ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>{i + 1}. {s}</span>
              {i < steps.length - 1 && <ArrowRight className="h-3 w-3 text-slate-300" />}
            </span>
          ))}
        </div>
        {session?.status !== 'idle' && session?.status && (
          <p className={`mt-4 text-sm ${session.status === 'failed' ? 'text-red-600' : 'text-sky-600'}`}>{session.message ?? 'Processing…'}{session.failedStage ? ` · failed at ${session.failedStage}` : ''}</p>
        )}
        <button className="btn-primary mt-6" onClick={onUpload} disabled={uploading}>{uploading ? 'Processing…' : 'Upload your first plan'}</button>
      </div>
    </div>
  );
}
