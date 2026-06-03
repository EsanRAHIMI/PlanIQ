'use client';
import { useState } from 'react';
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions, type OutputStyle } from '@planiq/shared';

interface FloorOpt { id: string; name: string }

export function ExportOptionsModal({
  open, onClose, floors, defaultClientName, defaultPreparedBy, busy, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  floors: FloorOpt[];
  defaultClientName?: string;
  defaultPreparedBy?: string;
  busy?: boolean;
  onSubmit: (opts: ExportOptions) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(floors.map((f) => f.id)));
  const [includeLegend, setIncludeLegend] = useState(true);
  const [includeSchedule, setIncludeSchedule] = useState(true);
  const [includeAiSummary, setIncludeAiSummary] = useState(true);
  const [styleVal, setStyleVal] = useState<OutputStyle>(DEFAULT_EXPORT_OPTIONS.style);
  const [clientName, setClientName] = useState(defaultClientName ?? '');
  const [preparedBy, setPreparedBy] = useState(defaultPreparedBy ?? '');
  const [versionName, setVersionName] = useState('');
  const [notes, setNotes] = useState('');

  if (!open) return null;

  const toggleFloor = (id: string) => setSelected((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const allSelected = selected.size === floors.length;

  const submit = () => {
    const floorIds = floors.map((f) => f.id).filter((id) => selected.has(id));
    onSubmit({
      floors: allSelected ? undefined : floorIds,
      includeLegend, includeSchedule, includeAiSummary, style: styleVal,
      clientName: clientName.trim() || undefined,
      preparedBy: preparedBy.trim() || undefined,
      versionName: versionName.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col rounded-xl bg-white shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Prepare client PDF</h2>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <Field label="Floors to include">
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs text-slate-400">{selected.size} of {floors.length} selected</span>
              <button className="text-xs text-brand hover:underline"
                onClick={() => setSelected(allSelected ? new Set() : new Set(floors.map((f) => f.id)))}>
                {allSelected ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
              {floors.map((f) => (
                <label key={f.id} className="flex items-center gap-2 px-1 text-sm">
                  <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggleFloor(f.id)} />
                  {f.name}
                </label>
              ))}
              {!floors.length && <p className="px-1 text-sm text-slate-400">No floors available.</p>}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Toggle label="Legend" checked={includeLegend} onChange={setIncludeLegend} />
            <Toggle label="Device schedule" checked={includeSchedule} onChange={setIncludeSchedule} />
            <Toggle label="AI analysis summary" checked={includeAiSummary} onChange={setIncludeAiSummary} />
          </div>

          <Field label="Output style">
            <div className="flex gap-2">
              {(['standard', 'detailed'] as OutputStyle[]).map((v) => (
                <button key={v} onClick={() => setStyleVal(v)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition ${styleVal === v ? 'border-brand bg-brand/5 font-semibold text-slate-900' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                  {v}
                  <span className="mt-0.5 block text-[11px] font-normal text-slate-400">
                    {v === 'standard' ? 'Plans + legend + schedule' : 'Adds per-floor device tables'}
                  </span>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Client name"><input className="input" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Project client" /></Field>
            <Field label="Prepared by"><input className="input" value={preparedBy} onChange={(e) => setPreparedBy(e.target.value)} placeholder="Your name" /></Field>
          </div>
          <Field label="Revision / version label"><input className="input" value={versionName} onChange={(e) => setVersionName(e.target.value)} placeholder="e.g. Rev A — for client review" /></Field>
          <Field label="Notes (shown on cover)"><textarea className="input min-h-[72px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes for the client…" /></Field>
        </div>

        <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || selected.size === 0}>
            {busy ? 'Generating…' : 'Generate PDF'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-500">{label}</span>{children}</label>;
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
