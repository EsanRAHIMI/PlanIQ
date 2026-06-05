'use client';
import { Loader2, Check, AlertCircle, RotateCcw } from 'lucide-react';
import { useAction } from '@/lib/useAction';

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-800',
  ghost: 'border border-slate-300 text-slate-700 hover:bg-slate-50',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  subtle: 'border border-slate-200 text-slate-600 hover:bg-slate-50',
};

/**
 * A button that always tells the user what happened: spinner while running, a check on
 * success, and an inline error + Retry on failure. Every major action should use this so
 * no click is ever silent.
 */
export function ActionButton({
  onRun, idle, busy, success, variant = 'primary', size = 'md',
  disabled, className = '', stage, title, fullWidth,
}: {
  onRun: () => Promise<unknown>;
  idle: string;
  busy?: string;
  success?: string;
  variant?: Variant;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  stage?: string;
  title?: string;
  fullWidth?: boolean;
}) {
  const a = useAction({ stage: stage ?? idle });
  const pad = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-2 text-sm';
  const label = a.state === 'loading' ? (busy ?? idle)
    : a.state === 'success' ? (success ?? 'Done')
    : a.state === 'error' ? idle
    : idle;
  const tone = a.state === 'success' ? 'bg-emerald-600 text-white hover:bg-emerald-600'
    : a.state === 'error' ? 'bg-red-600 text-white hover:bg-red-700'
    : VARIANT[variant];

  return (
    <span className={`inline-flex flex-col gap-1 ${fullWidth ? 'w-full' : ''}`}>
      <button
        type="button"
        title={title}
        disabled={disabled || a.state === 'loading'}
        onClick={() => { void a.run(onRun); }}
        className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:opacity-50 ${pad} ${tone} ${fullWidth ? 'w-full' : ''} ${className}`}
      >
        {a.state === 'loading' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {a.state === 'success' && <Check className="h-3.5 w-3.5" />}
        {a.state === 'error' && <AlertCircle className="h-3.5 w-3.5" />}
        {label}
      </button>
      {a.state === 'error' && (
        <span className="flex items-center gap-1.5 text-[11px] text-red-600">
          <span className="truncate">{a.error ?? 'Something went wrong'}</span>
          <button onClick={a.retry} className="inline-flex items-center gap-0.5 font-medium text-red-700 hover:underline">
            <RotateCcw className="h-3 w-3" /> Retry
          </button>
        </span>
      )}
    </span>
  );
}
