'use client';
import { useMemo } from 'react';
import { ChevronDown, Cpu, Ruler, ScanSearch, ShieldCheck, Sparkles, Info } from 'lucide-react';
import type { AiCapabilities, AnalysisQcSummary, AnalysisRunTrace } from '@planiq/shared';
import { DEVICE_BY_CODE, lastRunSummaryLabel, runCompletionSummary, usedFallback } from '@planiq/shared';
import { useEditor } from '@/features/editor/store';
import { StatusPill } from '@/components/StatusPill';

const TYPE_LABEL: Record<string, string> = {
  bedroom: 'Bedroom', master_bedroom: 'Master Bedroom', maid_room: 'Maid Room', majlis: 'Majlis',
  living_room: 'Living Room', sitting_area: 'Sitting Area', dining: 'Dining', dressing: 'Dressing',
  kitchen: 'Kitchen', pantry: 'Pantry', laundry: 'Laundry', bathroom: 'Bathroom', store: 'Store',
  store_indoor: 'Store (indoor)', store_outdoor: 'Store (outdoor)', service_area: 'Service Area',
  electrical_room: 'Electrical / DB', corridor: 'Corridor', staircase: 'Staircase', lift: 'Lift',
  entrance: 'Entrance', main_entrance: 'Main Entrance', guest_entrance: 'Guest Entrance',
  service_entrance: 'Service Entrance', main_door: 'Main Door', outdoor: 'Outdoor', garden: 'Garden',
  parking: 'Parking', gate: 'Gate', pool: 'Pool', bbq: 'BBQ', outdoor_seating: 'Outdoor Seating', roof: 'Roof',
};
const label = (t?: string) => (t ? TYPE_LABEL[t] ?? t : '');

function Conf({ value }: { value?: number | null }) {
  if (value == null) return <span className="text-slate-400">—</span>;
  const pct = Math.round(value * 100);
  const tone = pct >= 75 ? 'bg-emerald-500' : pct >= 55 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-200"><span className={`block h-full ${tone}`} style={{ width: `${pct}%` }} /></span>
      <span className="text-[11px] font-medium text-slate-600">{pct}%</span>
    </span>
  );
}

function Section({ icon, title, right, children }: { icon: React.ReactNode; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-b border-slate-100 px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{icon}{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex items-center justify-between py-0.5 text-xs"><span className="text-slate-500">{k}</span><span className="font-medium text-slate-800">{v}</span></div>
);

/**
 * The unified Explainable AI workspace. Surfaces — from data already produced, no new AI —
 * which engine ran, the model, geometry detected, rules + QC outcomes, and (on selection)
 * exactly why a device or space exists, its confidence, and the alternatives QC withheld.
 */
export function AiWorkspacePanel({
  runs, activeRun, liveRun, onSelectRun, qcSummary, capabilities, zones, scale, priors, debugMode, onToggleDebug,
}: {
  runs: AnalysisRunTrace[];
  activeRun: AnalysisRunTrace | null;
  liveRun?: AnalysisRunTrace | null;
  onSelectRun: (id: string) => void;
  qcSummary?: AnalysisQcSummary | null;
  capabilities: AiCapabilities | null;
  zones?: { type: string; confidence?: number }[];
  scale?: { metersPerPixel?: number; calibrated?: boolean } | null;
  priors?: { sampleN?: number; perSpace?: Record<string, any> } | null;
  debugMode: boolean;
  onToggleDebug: () => void;
}) {
  const run = liveRun ?? activeRun;
  const qc = run?.qcSummary ?? qcSummary ?? null;
  const placements = useEditor((s) => s.placements);
  const selectedIds = useEditor((s) => s.selectedIds);
  const rooms = useEditor((s) => s.rooms);
  const selectedRoomId = useEditor((s) => s.selectedRoomId);

  const selDevice = selectedIds.length === 1 ? (placements as any)[selectedIds[0]] : null;
  const selRoom = selectedRoomId ? rooms.find((r: any) => String(r._id ?? r.id) === selectedRoomId) : null;

  const zoneCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const z of zones ?? []) c[z.type] = (c[z.type] ?? 0) + 1;
    return c;
  }, [zones]);

  const caps = capabilities;
  const engineName = caps?.yoloWeightsAvailable ? 'Computer vision + YOLO + OCR' : 'Computer vision (OpenCV geometry + OCR)';
  const topRejections = (qc?.rejections ?? []).filter((r) => r.deviceCode !== '-').slice(0, 4);

  return (
    <div className="flex max-h-[42vh] flex-col overflow-y-auto border-t border-slate-200 bg-white">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand" />
          <span className="text-sm font-semibold text-slate-800">Explainable AI</span>
          {run && <StatusPill status={run.status} />}
        </div>
        <div className="flex items-center gap-2">
          {runs.length > 1 && (
            <select className="input max-w-[200px] py-1 text-[11px]" value={activeRun?.id ?? ''} onChange={(e) => onSelectRun(e.target.value)}>
              {runs.map((r) => <option key={r.id} value={r.id!}>{r.kind === 'rules_resuggest' ? 'Rules' : 'Full analysis'} · {new Date(r.startedAt).toLocaleString()}</option>)}
            </select>
          )}
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-500">
            <input type="checkbox" checked={debugMode} onChange={onToggleDebug} className="rounded" /> Show withheld
          </label>
        </div>
      </div>

      {!run && !qc && (
        <p className="px-4 py-6 text-center text-xs text-slate-400">
          No analysis yet. Use <strong>Analyze plan</strong> or <strong>Suggest devices</strong> above — every result is explained here.
        </p>
      )}

      {/* 1 — Engine & run */}
      {run && (
        <Section icon={<Cpu className="h-3.5 w-3.5" />} title="Engine & run">
          <p className="mb-1 text-xs text-slate-600">{lastRunSummaryLabel(run)}</p>
          <Row k="Engine" v={engineName} />
          <Row k="Model" v={run.modelName ?? '—'} />
          <Row k="Duration" v={run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'} />
          <Row k="LLM fallback" v={usedFallback(run) ? 'Used' : (caps?.fallbackProvider && caps.fallbackProvider !== 'disabled' ? 'Available, not used' : 'Off')} />
          {!caps?.aiServiceOk && <p className="mt-1 text-[11px] text-amber-600">AI service offline — results may be stale.</p>}
          {qc?.consistent === false && <p className="mt-1 text-[11px] text-amber-600">⚠ Counts did not fully reconcile — review the summary.</p>}
        </Section>
      )}

      {/* 2 — What was detected (geometry) */}
      {(qc || zones?.length || scale?.metersPerPixel) && (
        <Section icon={<ScanSearch className="h-3.5 w-3.5" />} title="What was detected">
          {qc && <Row k="Spaces" v={<span>{qc.acceptedSpaces} accepted · {qc.rejectedSpaces} withheld <span className="text-slate-400">of {qc.detectedSpaces}</span></span>} />}
          {(zoneCounts.door || zoneCounts.entrance || zoneCounts.column || zoneCounts.staircase || zoneCounts.gate || zoneCounts.parking) && (
            <Row k="Geometry" v={
              <span className="text-[11px]">
                {[['door', 'doors'], ['entrance', 'entrances'], ['column', 'columns'], ['staircase', 'stairs'], ['gate', 'gate'], ['parking', 'parking']]
                  .filter(([t]) => zoneCounts[t]).map(([t, lab]) => `${zoneCounts[t]} ${lab}`).join(' · ')}
              </span>} />
          )}
          {scale?.metersPerPixel ? (
            <Row k={<span className="inline-flex items-center gap-1"><Ruler className="h-3 w-3" /> Scale</span> as any}
              v={<span>{(scale.metersPerPixel).toFixed(4)} m/px {scale.calibrated ? '· calibrated' : '· estimated'}</span>} />
          ) : null}
        </Section>
      )}

      {/* 3 — Rules & quality control */}
      {qc && (
        <Section icon={<ShieldCheck className="h-3.5 w-3.5" />} title="Rules & quality control">
          <p className="mb-1.5 text-xs leading-snug text-slate-600">{qc.summary ?? `Placed ${qc.acceptedPlacements} of ${qc.rawPlacements} suggestions.`}</p>
          <Row k="Devices placed" v={`${qc.acceptedPlacements} (${qc.roomBasedPlacements ?? 0} room · ${(qc.zoneBasedPlacements ?? 0) + (qc.perimeterBasedPlacements ?? 0)} perimeter/zone)`} />
          <Row k="Withheld by QC" v={qc.rejectedPlacements} />
          {topRejections.length > 0 && (
            <div className="mt-1.5">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Top reasons withheld</p>
              {topRejections.map((r, i) => (
                <p key={i} className="text-[11px] text-slate-500">· {DEVICE_BY_CODE[r.deviceCode]?.name ?? r.deviceCode}{r.nearSpace ? ` (${r.nearSpace})` : ''} — {r.reason}</p>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* 4 — Selected device: why it exists */}
      {selDevice && (
        <Section icon={<Info className="h-3.5 w-3.5" />} title={`Why this ${DEVICE_BY_CODE[selDevice.deviceCode]?.name ?? selDevice.deviceCode}`}
          right={<Conf value={selDevice.confidence} />}>
          <p className="text-xs text-slate-700">{selDevice.rationale ?? 'Manually placed device.'}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px]">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">basis: {selDevice.meta?.basis ?? (selDevice.source === 'manual' ? 'manual' : 'room')}</span>
            {selDevice.meta?.nearSpace && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">space: {selDevice.meta.nearSpace}</span>}
            <span className={`rounded-full px-2 py-0.5 ${selDevice.source === 'ai' ? 'bg-sky-50 text-sky-700' : 'bg-emerald-50 text-emerald-700'}`}>{selDevice.source === 'ai' ? 'AI suggestion' : 'your edit'}</span>
          </div>
          {/* Alternatives QC withheld near the same space */}
          {(() => {
            const near = selDevice.meta?.nearSpace;
            const alts = (qc?.rejections ?? []).filter((r) => r.deviceCode !== '-' && (near ? r.nearSpace === near : r.deviceCode === selDevice.deviceCode));
            if (!alts.length) return null;
            return (
              <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Alternatives considered & withheld</p>
                {alts.slice(0, 4).map((r, i) => (
                  <p key={i} className="text-[11px] text-slate-500">· {DEVICE_BY_CODE[r.deviceCode]?.name ?? r.deviceCode} — {r.reason}</p>
                ))}
              </div>
            );
          })()}
        </Section>
      )}

      {/* 4b — Selected space: how it was classified */}
      {selRoom && !selDevice && (
        <Section icon={<Info className="h-3.5 w-3.5" />} title={`Space: ${label((selRoom as any).type)}`} right={<Conf value={(selRoom as any).confidence} />}>
          <Row k="Status" v={<StatusPill status={(selRoom as any).reviewStatus === 'ai_detected' ? 'needs_review' : (selRoom as any).reviewStatus} label={(selRoom as any).reviewStatus} />} />
          <Row k="Classified by" v={classifiedBy((selRoom as any).meta?.classificationSource)} />
          {(selRoom as any).meta?.signals && (
            <p className="mt-1 text-[11px] text-slate-500">
              label match {pctOf((selRoom as any).meta.signals.labelScore)} · OCR {pctOf((selRoom as any).meta.signals.ocrConf)} · size fit {pctOf((selRoom as any).meta.signals.areaPlausibility)}
            </p>
          )}
          {(selRoom as any).aiType && (selRoom as any).aiType !== (selRoom as any).type && (
            <p className="mt-1 text-[11px] text-amber-600">You corrected this from AI’s “{label((selRoom as any).aiType)}”.</p>
          )}
          {(selRoom as any).rejectionReason && <p className="mt-1 text-[11px] text-red-500">QC: {(selRoom as any).rejectionReason}</p>}
        </Section>
      )}

      {/* 5 — Learned from training */}
      <Section icon={<Sparkles className="h-3.5 w-3.5" />} title="Learned from training">
        {priors?.sampleN ? (
          <>
            <p className="text-[11px] text-slate-600">Placement priors learned from <strong>{priors.sampleN}</strong> engineer sample{priors.sampleN === 1 ? '' : 's'} across {Object.keys(priors.perSpace ?? {}).length} space types.</p>
            {selDevice?.meta?.nearSpace && priorFor(priors, rooms, selDevice) && (
              <p className="mt-1 text-[11px] text-slate-500">For this space, engineers place this device in {Math.round((priorFor(priors, rooms, selDevice) ?? 0) * 100)}% of samples.</p>
            )}
          </>
        ) : (
          <p className="text-[11px] text-slate-400">No training priors yet. Add BEFORE/AFTER samples in the Training Center to teach PlanIQ; suggestions stay rule-based until then.</p>
        )}
      </Section>
    </div>
  );
}

function classifiedBy(src?: string) {
  if (src === 'ocr_label') return 'plan label (OCR)';
  if (src === 'geometry') return 'geometry (stairs/door cue)';
  if (src === 'area_heuristic') return 'size heuristic (no label)';
  return 'manual';
}
const pctOf = (v?: number) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function priorFor(priors: any, rooms: any[], dev: any): number | null {
  const near = dev?.meta?.nearSpace;
  if (!near) return null;
  const room = rooms.find((r) => (r.label ?? r.type) === near);
  const sp = room?.type;
  return sp ? priors?.perSpace?.[sp]?.[dev.deviceCode]?.rate ?? null : null;
}
