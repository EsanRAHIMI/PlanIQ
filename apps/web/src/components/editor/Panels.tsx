'use client';
import { useState } from 'react';
import { useEditor } from '@/features/editor/store';
import type { DeviceDef } from '@planiq/shared';

/** Left: searchable device library. Click to add to canvas center. */
export function DeviceLibraryPanel({ devices }: { devices: DeviceDef[] }) {
  const [q, setQ] = useState('');
  const add = useEditor((s) => s.addPlacement);
  const filtered = devices.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()) || d.code.toLowerCase().includes(q.toLowerCase()));
  const cats = [...new Set(filtered.map((d) => d.category))];

  return (
    <aside className="flex w-64 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 p-3">
        <input className="input" placeholder="Search devices…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {cats.map((cat) => (
          <div key={cat} className="mb-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{cat.replace('_', ' ')}</div>
            <div className="grid grid-cols-1 gap-1">
              {filtered.filter((d) => d.category === cat).map((d) => (
                <button key={d.code} onClick={() => add({
                  deviceCode: d.code, position: { x: 0.5, y: 0.5 }, rotation: 0, scale: 1,
                  locked: false, hidden: false, source: 'manual', reviewed: true, props: { ...d.defaultProps }, zIndex: 0,
                } as any)}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50">
                  <span className="h-3 w-3 rounded" style={{ background: d.color }} />
                  {d.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Right: properties of the current selection + layers. */
export function PropertiesPanel({ devices }: { devices: DeviceDef[] }) {
  const placements = useEditor((s) => s.placements);
  const selectedIds = useEditor((s) => s.selectedIds);
  const layers = useEditor((s) => s.layers);
  const { updatePlacement, setLayerVisibility } = useEditor();
  const sel = selectedIds.length === 1 ? placements[selectedIds[0]] : null;

  return (
    <aside className="flex w-72 flex-col border-l border-slate-200 bg-white">
      <div className="flex-1 overflow-y-auto p-4">
        <h3 className="text-sm font-semibold">Properties</h3>
        {!sel && <p className="mt-3 text-sm text-slate-400">{selectedIds.length > 1 ? `${selectedIds.length} selected` : 'Select a device'}</p>}
        {sel && (
          <div className="mt-3 space-y-3 text-sm">
            <Field label="Label">
              <input className="input" value={sel.label ?? ''} placeholder={sel.deviceCode}
                onChange={(e) => updatePlacement(selectedIds[0], { label: e.target.value })} />
            </Field>
            <Field label="Device type">
              <select className="input" value={sel.deviceCode} onChange={(e) => updatePlacement(selectedIds[0], { deviceCode: e.target.value })}>
                {devices.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="X"><input className="input" type="number" step="0.01" value={sel.position.x.toFixed(3)} onChange={(e) => updatePlacement(selectedIds[0], { position: { ...sel.position, x: +e.target.value } })} /></Field>
              <Field label="Y"><input className="input" type="number" step="0.01" value={sel.position.y.toFixed(3)} onChange={(e) => updatePlacement(selectedIds[0], { position: { ...sel.position, y: +e.target.value } })} /></Field>
            </div>
            <Field label={`Rotation: ${sel.rotation}°`}>
              <input type="range" min={0} max={359} value={sel.rotation} className="w-full" onChange={(e) => updatePlacement(selectedIds[0], { rotation: +e.target.value })} />
            </Field>
            {sel.source === 'ai' && (
              <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                <div className="font-semibold">AI suggestion {sel.confidence ? `(${Math.round(sel.confidence * 100)}%)` : ''}</div>
                {sel.rationale && <p className="mt-1">{sel.rationale}</p>}
                {!sel.reviewed && <button className="btn-primary mt-2 px-2 py-1 text-xs" onClick={() => updatePlacement(selectedIds[0], { reviewed: true })}>Accept</button>}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 p-4">
        <h3 className="text-sm font-semibold">Layers</h3>
        <div className="mt-2 space-y-1">
          {layers.map((l) => (
            <label key={l.id ?? l._id ?? l.name} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={l.visible !== false} onChange={(e) => setLayerVisibility(l.id ?? l._id ?? l.name, e.target.checked)} />
              <span className="h-3 w-3 rounded" style={{ background: l.color }} />{l.name}
            </label>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs text-slate-500">{label}</span>{children}</label>;
}
