'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Upload } from 'lucide-react';
import { api, formatApiError } from '@/lib/api';
import { toast } from '@/lib/toast';
import { ProcessingTimeline } from '@/components/upload/ProcessingTimeline';
import { AppHeader } from '@/components/AppHeader';
import { StatusPill } from '@/components/StatusPill';
import { ProjectLifecycle } from '@/components/project/ProjectLifecycle';
import { ExportOptionsModal } from '@/components/delivery/ExportOptionsModal';
import { usePlanUpload } from '@/hooks/usePlanUpload';
import type { ExportOptions } from '@planiq/shared';

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<any>(null);
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setProject(await api.get<any>(`/projects/${id}`));
  }, [id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const { session, upload, clearPolling } = usePlanUpload(id, refresh);

  useEffect(() => () => clearPolling(), [clearPolling]);

  const uploading = session.status === 'uploading' || session.status === 'processing';

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await upload(file);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function patchStatus(status: string) {
    try {
      await api.patch(`/projects/${id}`, { status });
      toast.success(status === 'review' ? 'Design approved — marked in review'
        : status === 'delivered' ? 'Project marked delivered'
        : status === 'archived' ? 'Project archived' : 'Updated');
      await refresh();
    } catch (err) { toast.error(formatApiError(err, 'Update project')); }
  }

  async function runExport(opts: ExportOptions) {
    setExportOpen(false);
    setExporting(true);
    const toastId = toast.loading('Preparing PDF export…');
    try {
      const { exportId } = await api.post<any>(`/projects/${id}/export`, opts);
      toast.loading('Rendering floors & device schedule…', { id: toastId });

      let attempts = 0;
      const MAX_ATTEMPTS = 90; // ~3 min at 2s intervals
      const poll = setInterval(async () => {
        attempts += 1;
        try {
          const exp = await api.get<any>(`/exports/${exportId}`);
          if (exp.status === 'done' && exp.downloadUrl) {
            clearInterval(poll);
            setExporting(false);
            toast.success(`PDF ready · ${exp.pages ?? ''} page${exp.pages === 1 ? '' : 's'}`.trim(), { id: toastId });
            window.open(exp.downloadUrl, '_blank', 'noopener');
          } else if (exp.status === 'failed') {
            clearInterval(poll);
            setExporting(false);
            toast.error(`Export failed${exp.error ? ` · ${exp.error}` : ''}`, { id: toastId });
          } else if (attempts >= MAX_ATTEMPTS) {
            clearInterval(poll);
            setExporting(false);
            toast.error('Export is taking longer than expected. Check exports again shortly.', { id: toastId });
          }
        } catch (err) {
          clearInterval(poll);
          setExporting(false);
          toast.error(formatApiError(err, 'Export status'), { id: toastId });
        }
      }, 2000);
    } catch (err) {
      setExporting(false);
      toast.error(formatApiError(err, 'Start export'), { id: toastId });
    }
  }

  if (!project) {
    return (
      <>
        <AppHeader breadcrumbs={[{ label: 'Projects', href: '/dashboard' }]} />
        <main className="p-10 text-slate-500">Loading…</main>
      </>
    );
  }

  const floorCount = project.floors?.length ?? 0;
  const showTimeline = session.status !== 'idle';

  return (
    <>
      <AppHeader breadcrumbs={[{ label: 'Projects', href: '/dashboard' }, { label: project.name }]} />
      <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">{project.name}</h1>
            <StatusPill status={project.status} />
          </div>
          <p className="text-sm text-slate-500">
            {project.client?.name ?? 'No client'} · {floorCount} floor{floorCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? 'Processing…' : 'Upload plan'}
          </button>
          <button className="btn-primary" onClick={() => setExportOpen(true)} disabled={exporting || floorCount === 0}>
            {exporting ? 'Exporting…' : 'Export PDF'}
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" hidden onChange={onFile} />
        </div>
      </header>

      <div className="mt-6">
        <ProjectLifecycle
          project={project}
          onExport={() => setExportOpen(true)}
          onUpload={() => fileRef.current?.click()}
          onPatchStatus={patchStatus}
          busy={{ upload: uploading, export: exporting }}
        />
      </div>

      <ExportOptionsModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        floors={(project.floors ?? []).map((f: any) => ({ id: f._id, name: f.name }))}
        defaultClientName={project.client?.name}
        busy={exporting}
        onSubmit={runExport}
      />

      <ProcessingTimeline
        visible={showTimeline}
        steps={session.timeline}
        summary={session.message}
        meta={{ assetId: session.assetId, jobId: session.jobId, fileName: session.fileName }}
      />

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {project.floors?.map((f: any) => (
          <Link key={f._id} href={`/editor/${f._id}`} className="card p-5 transition hover:border-slate-300 hover:shadow-md">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-slate-900">{f.name}</div>
              <StatusPill status={f.analysis?.status ?? 'none'} />
            </div>
            <div className="mt-1 text-xs text-slate-500">{f.kind} · level {f.level}</div>
            <div className="mt-4 flex gap-4 text-xs text-slate-500">
              <span>{f.counts?.rooms ?? 0} spaces</span>
              <span>{f.counts?.placements ?? 0} devices</span>
            </div>
          </Link>
        ))}

        {floorCount === 0 && (
          <EmptyFloorsState session={session} onUpload={() => fileRef.current?.click()} uploading={uploading} />
        )}
      </div>
      </main>
    </>
  );
}

function EmptyFloorsState({
  session,
  onUpload,
  uploading,
}: {
  session: ReturnType<typeof usePlanUpload>['session'];
  onUpload: () => void;
  uploading: boolean;
}) {
  const statusColor =
    session.status === 'failed' ? 'text-red-600'
    : session.status === 'done' ? 'text-emerald-600'
    : session.status === 'processing' ? 'text-sky-600'
    : 'text-slate-500';

  return (
    <div className="card col-span-full p-10">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-200 bg-slate-50">
          <Upload className="h-5 w-5 text-slate-400" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-slate-900">No floors yet</h3>
        <p className="mt-2 text-sm text-slate-500">
          Upload a PDF or image plan — each page becomes a floor and is analyzed automatically.
        </p>

        {session.status !== 'idle' && (
          <div className="mt-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-left">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Last upload</p>
            <p className={`mt-1 text-sm ${statusColor}`}>
              {session.message ?? 'Processing…'}
            </p>
            {session.failedStage && (
              <p className="mt-1 text-xs text-red-500">Failed at: {session.failedStage}</p>
            )}
          </div>
        )}

        <button
          className="btn-primary mt-6"
          onClick={onUpload}
          disabled={uploading}
        >
          {uploading ? 'Processing…' : 'Upload your first plan'}
        </button>
      </div>
    </div>
  );
}

