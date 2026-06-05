'use client';

/**
 * One status vocabulary for the whole product. Every status badge (projects, floors,
 * lifecycle stages, analysis) routes through this so colour + wording never drift.
 */
export type StatusTone = 'neutral' | 'info' | 'progress' | 'success' | 'warn' | 'danger';

const TONE: Record<StatusTone, string> = {
  neutral: 'border-slate-200 bg-slate-50 text-slate-600',
  info: 'border-sky-200 bg-sky-50 text-sky-700',
  progress: 'border-sky-200 bg-sky-50 text-sky-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-700',
  danger: 'border-red-200 bg-red-50 text-red-700',
};

const DOT: Record<StatusTone, string> = {
  neutral: 'bg-slate-400', info: 'bg-sky-500', progress: 'bg-sky-500 animate-pulse',
  success: 'bg-emerald-500', warn: 'bg-amber-500', danger: 'bg-red-500',
};

/** Canonical status key → { label, tone }. Synonyms collapse to one presentation. */
export const STATUS: Record<string, { label: string; tone: StatusTone }> = {
  // generic / project
  none: { label: 'Not started', tone: 'neutral' },
  draft: { label: 'Draft', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'progress' },
  review: { label: 'In review', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
  // analysis / jobs
  queued: { label: 'Queued', tone: 'info' },
  processing: { label: 'Analyzing', tone: 'progress' },
  running: { label: 'Running', tone: 'progress' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  // review lifecycle
  needs_review: { label: 'Needs review', tone: 'warn' },
  reviewed: { label: 'Reviewed', tone: 'success' },
  // delivery
  ready: { label: 'Ready', tone: 'info' },
  exported: { label: 'Exported', tone: 'success' },
  // stage states
  active: { label: 'In progress', tone: 'progress' },
  pending: { label: 'Pending', tone: 'neutral' },
  attention: { label: 'Needs attention', tone: 'warn' },
  optional: { label: 'Optional', tone: 'neutral' },
};

export function StatusPill({ status, label, tone, className = '' }: {
  status?: string; label?: string; tone?: StatusTone; className?: string;
}) {
  const def = (status && STATUS[status]) || { label: label ?? status ?? '—', tone: tone ?? 'neutral' };
  const t = tone ?? def.tone;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE[t]} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[t]}`} />
      {label ?? def.label}
    </span>
  );
}
