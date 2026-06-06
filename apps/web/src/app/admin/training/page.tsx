'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, loadToken, fetchMe, isAdminRole, uploadToS3, resolveMime, formatApiError } from '@/lib/api';
import { toast } from '@/lib/toast';
import { AppHeader } from '@/components/AppHeader';
import { ActionButton } from '@/components/ActionButton';
import { DEVICE_CLASSES } from '@planiq/shared';

type Sample = {
  _id: string; name: string; status: string; split: string;
  projectType?: string; floorKind?: string; engineer?: string; counts?: { devices: number };
  before?: { s3Key?: string }; after?: { s3Key?: string };
};
type Anno = { deviceCode: string; bboxNorm: [number, number, number, number]; source?: string; status?: string; spaceTypeHint?: string };

export default function TrainingPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(null);
  const [denied, setDenied] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [sel, setSel] = useState<any>(null);          // full sample detail (with URLs + annotations)
  const [annos, setAnnos] = useState<Anno[]>([]);
  const [draw, setDraw] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [curClass, setCurClass] = useState<string>(DEVICE_CLASSES[0]);
  const [datasets, setDatasets] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [feedback, setFeedback] = useState<any>(null);
  const [priors, setPriors] = useState<any>(null);
  const imgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loadToken()) { router.push('/login'); return; }
    fetchMe(true).then((u) => (u && isAdminRole(u.globalRole)) ? setMe(u) : setDenied(true)).catch(() => {});
  }, [router]);

  const refresh = useCallback(async () => {
    setSamples(await api.get<Sample[]>('/training/samples').catch(() => []));
    setDatasets(await api.get<any[]>('/training/datasets').catch(() => []));
    setModels(await api.get<any[]>('/training/models').catch(() => []));
    setFeedback(await api.get<any>('/training/feedback/stats').catch(() => null));
    setPriors(await api.get<any>('/training/priors').catch(() => null));
  }, []);
  useEffect(() => { if (me) void refresh(); }, [me, refresh]);

  const openSample = useCallback(async (id: string) => {
    const s = await api.get<any>(`/training/samples/${id}`);
    setSel(s); setAnnos((s.annotations ?? []) as Anno[]);
  }, []);

  async function createSample() {
    const name = prompt('Sample name (e.g. Villa A — Ground Floor)');
    if (!name) return;
    const s = await api.post<Sample>('/training/samples', { name });
    await refresh(); await openSample(s._id);
  }

  async function upload(role: 'before' | 'after', file: File) {
    const mime = resolveMime(file);
    const { uploadUrl } = await api.post<{ uploadUrl: string }>(`/training/samples/${sel._id}/upload-url`, { role, mime });
    await uploadToS3(uploadUrl, file, mime);
    // measure dims client-side for alignment + YOLO
    const dims = await new Promise<{ w: number; h: number }>((res) => {
      if (!file.type.startsWith('image/')) return res({ w: 0, h: 0 });
      const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.src = URL.createObjectURL(file);
    });
    await api.post(`/training/samples/${sel._id}/complete`, { role, width: dims.w, height: dims.h });
    toast.success(`${role.toUpperCase()} uploaded`); await openSample(sel._id); await refresh();
  }

  async function extract() {
    const r = await api.post<any>(`/training/samples/${sel._id}/extract`, {});
    toast.info(`Seeded ${r.seeded} candidate boxes${r.detectorAvailable ? '' : ' (detector heuristic)'}`);
    await openSample(sel._id);
  }

  async function saveAnnos() {
    await api.post(`/training/samples/${sel._id}/annotations`, { annotations: annos });
    toast.success(`Saved ${annos.filter((a) => a.status !== 'false_positive').length} labels`); await refresh();
  }

  // ── box drawing on the AFTER image (normalized coords) ──
  const toNorm = (e: React.MouseEvent) => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const onDown = (e: React.MouseEvent) => { const p = toNorm(e); setDraw(p); setRect({ x: p.x, y: p.y, w: 0, h: 0 }); };
  const onMove = (e: React.MouseEvent) => {
    if (!draw) return; const p = toNorm(e);
    setRect({ x: Math.min(draw.x, p.x), y: Math.min(draw.y, p.y), w: Math.abs(p.x - draw.x), h: Math.abs(p.y - draw.y) });
  };
  const onUp = () => {
    if (rect && rect.w > 0.01 && rect.h > 0.01) {
      setAnnos((a) => [...a, { deviceCode: curClass, bboxNorm: [rect.x, rect.y, rect.w, rect.h], source: 'human', status: 'confirmed' }]);
    }
    setDraw(null); setRect(null);
  };

  async function exportDataset() {
    const r = await api.post<any>('/training/datasets/export', { valRatio: 0.2 });
    toast.success(`Dataset v${r.version}: ${r.samples} samples, ${Object.values(r.classCounts).reduce((a: any, b: any) => a + b, 0)} boxes`);
    await refresh();
  }
  async function recomputePriors() {
    const r = await api.post<any>('/training/priors/recompute', {});
    toast.success(`Priors v${r.version} from ${r.sampleN} samples, ${r.spaceTypes} space types`);
    await refresh();
  }
  async function promote(id: string, status: string) {
    await api.patch(`/training/models/${id}/status`, { status }).then(refresh).catch((e) => toast.error(formatApiError(e, 'Promote')));
  }

  if (denied) return <main className="mx-auto max-w-2xl px-6 py-24 text-center"><h1 className="text-xl font-semibold">Admin access required</h1><Link href="/dashboard" className="btn-primary mt-6 inline-block">Back</Link></main>;
  if (!me) return <main className="p-10 text-slate-500">Loading…</main>;

  return (
    <>
      <AppHeader breadcrumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Training' }]} />
      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Training &amp; Feedback Center</h1>
            <p className="text-sm text-slate-500">Learn device placement from BEFORE/AFTER engineer samples. Extends the rule engine — never replaces it.</p>
          </div>
          <button onClick={createSample} className="btn-primary">+ New sample</button>
        </div>

        <div className="mt-6 grid grid-cols-12 gap-6">
          {/* Samples list */}
          <aside className="col-span-3 rounded-xl border border-slate-200 bg-white p-3">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Samples ({samples.length})</h2>
            <div className="space-y-1">
              {samples.map((s) => (
                <button key={s._id} onClick={() => openSample(s._id)}
                  className={`block w-full rounded-lg border p-2 text-left text-xs ${sel?._id === s._id ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:border-slate-300'}`}>
                  <div className="font-medium text-slate-800">{s.name}</div>
                  <div className="text-[11px] text-slate-500">{s.status} · {s.counts?.devices ?? 0} devices · {s.split}</div>
                </button>
              ))}
              {!samples.length && <p className="text-xs text-slate-400">No samples yet.</p>}
            </div>
          </aside>

          {/* Review / annotate */}
          <section className="col-span-6 rounded-xl border border-slate-200 bg-white p-4">
            {!sel ? <p className="text-sm text-slate-400">Select or create a sample.</p> : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-800">{sel.name}</span>
                  <label className="cursor-pointer rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">
                    Upload BEFORE<input type="file" hidden accept="image/*,.pdf" onChange={(e) => e.target.files?.[0] && upload('before', e.target.files[0])} />
                  </label>
                  <label className="cursor-pointer rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">
                    Upload AFTER<input type="file" hidden accept="image/*,.pdf" onChange={(e) => e.target.files?.[0] && upload('after', e.target.files[0])} />
                  </label>
                  <ActionButton onRun={extract} idle="Auto-detect" busy="Detecting…" success="Detected" variant="ghost" size="sm" stage="Auto-detect devices" />
                  <ActionButton onRun={saveAnnos} idle="Save labels" busy="Saving…" success="Saved" variant="primary" size="sm" stage="Save labels" />
                </div>

                <div className="mb-2 flex items-center gap-2 text-xs">
                  <span className="text-slate-500">Draw class:</span>
                  <select className="input py-1 text-xs" value={curClass} onChange={(e) => setCurClass(e.target.value)}>
                    {DEVICE_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <span className="text-slate-400">{annos.length} boxes</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-slate-500">BEFORE</div>
                    {sel.beforeUrl ? <img src={sel.beforeUrl} alt="before" className="w-full rounded border border-slate-200" /> : <div className="rounded border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400">No BEFORE</div>}
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-slate-500">AFTER — draw device boxes</div>
                    {sel.afterUrl ? (
                      <div ref={imgRef} className="relative select-none" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}>
                        <img src={sel.afterUrl} alt="after" className="w-full rounded border border-slate-200" draggable={false} />
                        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
                          {annos.map((a, i) => (
                            <g key={i}>
                              <rect x={a.bboxNorm[0]} y={a.bboxNorm[1]} width={a.bboxNorm[2]} height={a.bboxNorm[3]}
                                fill={a.status === 'false_positive' ? 'rgba(239,68,68,0.1)' : 'rgba(37,99,235,0.12)'}
                                stroke={a.status === 'false_positive' ? '#ef4444' : '#2563EB'} strokeWidth={0.003} />
                            </g>
                          ))}
                          {rect && <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill="rgba(16,185,129,0.15)" stroke="#10B981" strokeWidth={0.003} />}
                        </svg>
                      </div>
                    ) : <div className="rounded border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400">Upload an AFTER plan</div>}
                  </div>
                </div>

                {/* annotation list */}
                <div className="mt-3 max-h-40 overflow-y-auto rounded border border-slate-100">
                  {annos.map((a, i) => (
                    <div key={i} className="flex items-center gap-2 border-b border-slate-50 px-2 py-1 text-[11px]">
                      <select className="input py-0.5 text-[11px]" value={a.deviceCode}
                        onChange={(e) => setAnnos((arr) => arr.map((x, j) => j === i ? { ...x, deviceCode: e.target.value } : x))}>
                        {DEVICE_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <span className="text-slate-400">{a.source}</span>
                      <button onClick={() => setAnnos((arr) => arr.map((x, j) => j === i ? { ...x, status: x.status === 'false_positive' ? 'confirmed' : 'false_positive' } : x))}
                        className="ml-auto text-amber-600">{a.status === 'false_positive' ? 'restore' : 'false+'}</button>
                      <button onClick={() => setAnnos((arr) => arr.filter((_, j) => j !== i))} className="text-red-500">del</button>
                    </div>
                  ))}
                  {!annos.length && <p className="px-2 py-2 text-[11px] text-slate-400">No labels. Draw on the AFTER plan or Auto-detect.</p>}
                </div>
              </>
            )}
          </section>

          {/* Dataset / models / feedback */}
          <aside className="col-span-3 space-y-4">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <h2 className="mb-2 text-sm font-semibold text-slate-700">Dataset &amp; Priors</h2>
              <div className="mb-1"><ActionButton onRun={exportDataset} idle="Export YOLO dataset" busy="Exporting…" success="Exported" variant="primary" size="sm" fullWidth stage="Export dataset" /></div>
              <ActionButton onRun={recomputePriors} idle="Recompute priors" busy="Computing…" success="Updated" variant="ghost" size="sm" fullWidth stage="Recompute priors" />
              {priors?.sampleN ? <p className="mt-2 text-[11px] text-slate-500">Priors: {priors.sampleN} samples · {Object.keys(priors.perSpace ?? {}).length} space types</p> : null}
              {datasets.map((d) => <p key={d._id} className="mt-1 text-[11px] text-slate-500">Dataset v{d.version}: {d.split?.train}/{d.split?.val} train/val</p>)}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <h2 className="mb-2 text-sm font-semibold text-slate-700">Models</h2>
              <div className="mb-2"><ActionButton onRun={async () => { await api.post('/training/models', {}); await refresh(); }} idle="+ Register model" busy="…" success="Registered" variant="ghost" size="sm" fullWidth stage="Register model" /></div>
              {models.map((m) => (
                <div key={m._id} className="mb-1 flex items-center justify-between text-[11px]">
                  <span>v{m.version} · <span className="font-medium">{m.status}</span></span>
                  <span className="flex gap-1">
                    {m.status === 'draft' && <button onClick={() => promote(m._id, 'training')} className="text-sky-600">train</button>}
                    {m.status === 'evaluated' && <button onClick={() => promote(m._id, 'approved')} className="text-emerald-600">approve</button>}
                    {m.status === 'approved' && <button onClick={() => promote(m._id, 'production')} className="text-emerald-700">go live</button>}
                  </span>
                </div>
              ))}
              {!models.length && <p className="text-[11px] text-slate-400">No models yet.</p>}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <h2 className="mb-2 text-sm font-semibold text-slate-700">Editor Feedback</h2>
              {feedback?.perDevice?.length ? feedback.perDevice.map((f: any) => (
                <p key={f.deviceCode} className="text-[11px] text-slate-500">{f.deviceCode}: {f.accepted}✓ / {f.rejected}✗ {f.acceptRate != null ? `(${Math.round(f.acceptRate * 100)}%)` : ''}</p>
              )) : <p className="text-[11px] text-slate-400">No feedback yet ({feedback?.total ?? 0}).</p>}
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
