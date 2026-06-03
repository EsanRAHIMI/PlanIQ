'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, formatApiError } from '@/lib/api';
import { toast } from '@/lib/toast';

interface Version {
  _id: string;
  number: number;
  label?: string;
  note?: string;
  createdAt?: string;
}

/** Save immutable snapshots and restore previous versions of a floor. */
export function VersionsModal({
  floorId, open, onClose, onRestored,
}: {
  floorId: string;
  open: boolean;
  onClose: () => void;
  onRestored: () => void | Promise<void>;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setVersions(await api.get<Version[]>(`/floors/${floorId}/versions`));
    } catch (err) {
      toast.error(formatApiError(err, 'Load versions'));
    } finally {
      setLoading(false);
    }
  }, [floorId]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await api.post(`/floors/${floorId}/versions`, {
        label: label.trim() || undefined,
        note: note.trim() || undefined,
      });
      setLabel(''); setNote('');
      toast.success('Version saved');
      await refresh();
    } catch (err) {
      toast.error(formatApiError(err, 'Save version'));
    } finally {
      setBusy(false);
    }
  }, [floorId, label, note, refresh]);

  const restore = useCallback(async (v: Version) => {
    if (!window.confirm(`Restore version ${v.number}${v.label ? ` (${v.label})` : ''}? Current placements are snapshotted first.`)) return;
    setBusy(true);
    const id = toast.loading(`Restoring version ${v.number}…`);
    try {
      await api.post(`/versions/${v._id}/restore`);
      toast.success(`Restored version ${v.number}`, { id });
      await onRestored();
      await refresh();
      onClose();
    } catch (err) {
      toast.error(formatApiError(err, 'Restore version'), { id });
    } finally {
      setBusy(false);
    }
  }, [onRestored, refresh, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Version history</h2>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="border-b border-slate-100 p-4">
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Version label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button className="btn-primary px-3 py-1.5 text-sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save version'}
            </button>
          </div>
          <input
            className="input mt-2 w-full"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && <p className="text-sm text-slate-400">Loading…</p>}
          {!loading && versions.length === 0 && (
            <p className="text-sm text-slate-400">No versions yet. Save one to capture the current layout.</p>
          )}
          <ul className="space-y-2">
            {versions.map((v) => (
              <li key={v._id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-800">
                    v{v.number}{v.label ? ` · ${v.label}` : ''}
                  </div>
                  <div className="text-xs text-slate-400">
                    {v.createdAt ? new Date(v.createdAt).toLocaleString() : ''}
                    {v.note ? ` — ${v.note}` : ''}
                  </div>
                </div>
                <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => restore(v)} disabled={busy}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
