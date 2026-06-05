'use client';
import { useCallback, useRef, useState } from 'react';
import { formatApiError } from '@/lib/api';

export type ActionState = 'idle' | 'loading' | 'success' | 'error';

/**
 * Wraps an async action with an explicit state machine so every button can show
 * loading → success → error with a recovery path, instead of failing silently.
 */
export function useAction(opts: { stage?: string; resetMs?: number } = {}) {
  const [state, setState] = useState<ActionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const lastFn = useRef<(() => Promise<unknown>) | null>(null);
  const resetMs = opts.resetMs ?? 1800;

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    lastFn.current = fn as () => Promise<unknown>;
    setState('loading');
    setError(null);
    try {
      const result = await fn();
      setState('success');
      window.setTimeout(() => setState((s) => (s === 'success' ? 'idle' : s)), resetMs);
      return result;
    } catch (e) {
      setState('error');
      setError(formatApiError(e, opts.stage ?? 'Action'));
      return undefined;
    }
  }, [opts.stage, resetMs]);

  const retry = useCallback(() => { if (lastFn.current) void run(lastFn.current); }, [run]);
  const reset = useCallback(() => { setState('idle'); setError(null); }, []);

  return { state, error, run, retry, reset };
}
