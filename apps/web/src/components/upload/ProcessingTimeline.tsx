'use client';

import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';

export type TimelineStepId =
  | 'upload'
  | 's3'
  | 'complete'
  | 'queue'
  | 'processing'
  | 'floors'
  | 'ai';

export type StepStatus = 'pending' | 'active' | 'success' | 'failed';

export type TimelineState = Record<TimelineStepId, StepStatus>;

export const TIMELINE_STEPS: { id: TimelineStepId; label: string }[] = [
  { id: 'upload', label: 'Upload' },
  { id: 's3', label: 'S3' },
  { id: 'complete', label: 'Complete' },
  { id: 'queue', label: 'Queue' },
  { id: 'processing', label: 'Processing' },
  { id: 'floors', label: 'Floors' },
  { id: 'ai', label: 'AI Analysis' },
];

export const INITIAL_TIMELINE: TimelineState = {
  upload: 'pending',
  s3: 'pending',
  complete: 'pending',
  queue: 'pending',
  processing: 'pending',
  floors: 'pending',
  ai: 'pending',
};

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'active') return <Loader2 className="h-4 w-4 animate-spin text-sky-600" />;
  if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 text-red-500" />;
  return <Circle className="h-4 w-4 text-slate-300" />;
}

function stepClasses(status: StepStatus): string {
  if (status === 'active') return 'border-sky-200 bg-sky-50/50 text-sky-900';
  if (status === 'success') return 'border-emerald-200 bg-emerald-50/40 text-emerald-900';
  if (status === 'failed') return 'border-red-200 bg-red-50/50 text-red-900';
  return 'border-slate-200 bg-white text-slate-500';
}

interface ProcessingTimelineProps {
  steps: TimelineState;
  visible: boolean;
  summary?: string;
  meta?: { assetId?: string; jobId?: string; fileName?: string };
}

export function ProcessingTimeline({ steps, visible, summary, meta }: ProcessingTimelineProps) {
  if (!visible) return null;

  return (
    <div className="card mt-6 p-5 transition-all duration-300">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Processing status</h2>
          {summary && <p className="mt-1 text-xs text-slate-500">{summary}</p>}
        </div>
        {meta?.fileName && (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
            {meta.fileName}
          </span>
        )}
      </div>

      <ol className="mt-4 flex flex-wrap gap-2">
        {TIMELINE_STEPS.map(({ id, label }) => (
          <li
            key={id}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors duration-200 ${stepClasses(steps[id])}`}
          >
            <StepIcon status={steps[id]} />
            {label}
          </li>
        ))}
      </ol>

      {(meta?.assetId || meta?.jobId) && (
        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-slate-400">
          {meta.assetId && <span>asset: {meta.assetId}</span>}
          {meta.jobId && <span>job: {meta.jobId}</span>}
        </div>
      )}
    </div>
  );
}
