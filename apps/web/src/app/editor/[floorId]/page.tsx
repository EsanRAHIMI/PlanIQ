'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { api, formatApiError, ApiError } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useEditor } from '@/features/editor/store';
import { DeviceLibraryPanel, PropertiesPanel } from '@/components/editor/Panels';
import { SpacesPanel } from '@/components/editor/SpacesPanel';
import { AiWorkspacePanel } from '@/components/editor/AiWorkspacePanel';
import { AiActionsBar } from '@/components/editor/AiActionsBar';
import { Toolbar } from '@/components/editor/Toolbar';
import { VersionsModal } from '@/components/editor/VersionsModal';
import type { AiCapabilities, AnalysisQcSummary, AnalysisRunTrace, DeviceDef, Placement } from '@planiq/shared';
import {
  fullAnalysisFallbackToast,
  fullAnalysisStartToast,
  noVisibleChangesMessage,
  rulesRunStartToast,
  runCompletionSummary,
} from '@planiq/shared';

const Canvas = dynamic(() => import('@/components/editor/Canvas').then((m) => m.Canvas), { ssr: false });

function countVisiblePlacements(placements: Record<string, Placement>): number {
  return Object.values(placements).filter((p) => !p.hidden).length;
}

export default function EditorPage() {
  const { floorId } = useParams<{ floorId: string }>();
  const router = useRouter();
  const [devices, setDevices] = useState<DeviceDef[]>([]);
  const [floor, setFloor] = useState<any>(null);
  const [floors, setFloors] = useState<any[]>([]);
  const [rasterUrl, setRasterUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [qcSummary, setQcSummary] = useState<AnalysisQcSummary | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<AiCapabilities | null>(null);
  const [zones, setZones] = useState<any[]>([]);
  const [priors, setPriors] = useState<any>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [runs, setRuns] = useState<AnalysisRunTrace[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<AnalysisRunTrace | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null;

  const loadRuns = useCallback(async () => {
    try {
      const list = await api.get<AnalysisRunTrace[]>(`/floors/${floorId}/analysis/runs`);
      setRuns(list);
      if (list.length && !activeRunId) setActiveRunId(list[0].id ?? null);
      else if (list.length && activeRunId && !list.some((r) => r.id === activeRunId)) {
        setActiveRunId(list[0].id ?? null);
      }
    } catch {
      // non-fatal
    }
  }, [floorId, activeRunId]);

  const loadCapabilities = useCallback(async () => {
    try {
      const caps = await api.get<AiCapabilities>('/ai/capabilities');
      setCapabilities(caps);
    } catch {
      setCapabilities(null);
    }
  }, []);

  const { load, takeDirty, requeueDirty, moveSelected, undo, redo, duplicateSelected, deleteSelected, clearSelection, debugMode, setDebugMode, setRooms, patchRoomLocal } = useEditor();
  const dirty = useEditor((s) => s.dirty);
  const deleted = useEditor((s) => s.deleted);

  const loadRooms = useCallback(async () => {
    try {
      const list = await api.get<any[]>(`/floors/${floorId}/rooms`);
      setRooms(list.map((r) => ({ ...r, id: String(r._id ?? r.id) })));
    } catch {
      // non-fatal — Spaces panel just shows empty
    }
  }, [floorId, setRooms]);

  const loadZones = useCallback(async () => {
    try { setZones(await api.get<any[]>(`/floors/${floorId}/zones`)); } catch { /* non-fatal */ }
  }, [floorId]);

  // Feedback loop: when the user removes AI-suggested devices, record it as training signal.
  const emitDeleteFeedback = useCallback(() => {
    const st = useEditor.getState();
    for (const id of st.selectedIds) {
      const p: any = st.placements[id];
      if (p && p.source === 'ai' && !p.locked) {
        void api.post('/training/feedback', {
          projectId: floor?.projectId, floorId, deviceCode: p.deviceCode,
          action: 'rejected', nearSpace: p.meta?.nearSpace,
        }).catch(() => {});
      }
    }
  }, [floorId, floor?.projectId]);

  const onRoomMoved = useCallback(async (id: string, centroid: [number, number], polygon: number[][]) => {
    try {
      await api.patch(`/rooms/${id}`, { centroid, polygon });
    } catch (err) {
      toast.error(formatApiError(err, 'Move space'));
    }
  }, []);

  const loadPlacements = useCallback(async (debug: boolean) => {
    const pl = await api.get<{ placements: Placement[]; layers: any[]; qcSummary?: AnalysisQcSummary }>(
      `/floors/${floorId}/placements${debug ? '?debug=1' : ''}`,
    );
    setQcSummary(pl.qcSummary ?? floor?.analysis?.qcSummary ?? null);
    const placements = pl.placements.map((p: any) => ({ ...p, id: p._id ?? p.id }));
    const layers = pl.layers.map((l: any) => ({ ...l, id: l._id ?? l.id }));
    load(floorId, placements as any, layers);
    return countVisiblePlacements(Object.fromEntries(placements.map((p: any) => [p.id, p])));
  }, [floorId, floor?.analysis?.qcSummary, load]);

  useEffect(() => {
    (async () => {
      try {
        const [dev, flr] = await Promise.all([
          api.get<DeviceDef[]>('/devices'),
          api.get<any>(`/floors/${floorId}`),
        ]);
        setDevices(dev);
        setFloor(flr);
        setRasterUrl(flr.rasterUrl ?? null);
        setQcSummary(flr.analysis?.qcSummary ?? null);
        if (flr.projectId) {
          api.get<any[]>(`/projects/${flr.projectId}/floors`).then(setFloors).catch(() => {});
        }
        await loadPlacements(false);
        await Promise.all([loadRuns(), loadCapabilities(), loadRooms(), loadZones()]);
        api.get<any>('/training/priors').then(setPriors).catch(() => {}); // admin-only; graceful
      } catch {
        // Auth failures handled globally in api.ts (toast + redirect).
      }
    })();
  }, [floorId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadPlacements(debugMode);
  }, [debugMode, loadPlacements]);

  const saveNow = useCallback(async () => {
    const { upserts, deletes } = takeDirty();
    if (!upserts.length && !deletes.length) return;
    setSaving(true);
    try {
      await api.patch(`/floors/${floorId}/placements`, {
        upserts: upserts.map((p: any) => ({ ...p, id: String(p.id).startsWith('loc_') ? undefined : p.id })),
        deletes: deletes.filter((d) => !d.startsWith('loc_')),
      });
    } catch (err) {
      // Do NOT lose the user's edits on a failed save: re-queue them for the next
      // autosave and surface the failure (401s are handled globally in api.ts).
      requeueDirty(upserts.map((p: any) => p.id).filter(Boolean), deletes);
      if (!(err instanceof ApiError && err.status === 401)) {
        toast.error('Couldn’t save changes — your edits are kept and will retry automatically.', { id: 'autosave-error' });
      }
    } finally { setSaving(false); }
  }, [floorId, takeDirty, requeueDirty]);

  useEffect(() => {
    if (dirty.size === 0 && deleted.size === 0) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveNow(); }, 800);
    return () => clearTimeout(saveTimer.current);
  }, [dirty, deleted, saveNow]);

  // Guard against silent data loss: warn if the tab is closed/reloaded while edits are
  // still pending (within the autosave debounce, or after a failed save kept them queued).
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.size === 0 && deleted.size === 0) return;
      e.preventDefault();
      e.returnValue = '';   // shows the browser's "unsaved changes" prompt
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, deleted]);

  const onSelectFloor = useCallback(async (id: string) => {
    if (!id || id === floorId) return;
    clearTimeout(saveTimer.current);
    await saveNow();
    router.push(`/editor/${id}`);
  }, [floorId, saveNow, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (meta && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (meta && e.key === 'd') { e.preventDefault(); duplicateSelected(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); emitDeleteFeedback(); deleteSelected(); }
      else if (e.key === 'Escape') { clearSelection(); }
      else if (e.key === 'ArrowUp') moveSelected(0, -0.005);
      else if (e.key === 'ArrowDown') moveSelected(0, 0.005);
      else if (e.key === 'ArrowLeft') moveSelected(-0.005, 0);
      else if (e.key === 'ArrowRight') moveSelected(0.005, 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, duplicateSelected, deleteSelected, clearSelection, moveSelected]);

  const finishRunToast = useCallback((
    run: AnalysisRunTrace,
    beforeCount: number,
    afterCount: number,
    toastId: string | number,
  ) => {
    const summary = runCompletionSummary(run);
    const noChange = noVisibleChangesMessage(beforeCount, afterCount, run);
    if (run.status === 'failed') {
      toast.error(`${summary}${run.errors[0] ? ` · ${run.errors[0]}` : ''}`, { id: toastId });
      return;
    }
    if (noChange) {
      toast.warning(`${summary} · ${noChange}`, { id: toastId });
      return;
    }
    toast.success(summary, { id: toastId });
  }, []);

  const onRulesResuggest = useCallback(async () => {
    setRulesBusy(true);
    const beforeCount = countVisiblePlacements(useEditor.getState().placements);
    const startedAt = new Date().toISOString();
    setLiveRun({
      id: 'live',
      projectId: floor?.projectId ?? '',
      floorId,
      kind: 'rules_resuggest',
      status: 'running',
      provider: 'rules',
      modelName: 'Internal Rules + QC',
      fallbackChain: ['rules_engine', 'typescript_mirror'],
      qcSettings: {},
      startedAt,
      detectedSpaces: 0,
      acceptedSpaces: 0,
      rejectedSpaces: 0,
      acceptedDevices: 0,
      rejectedDevices: 0,
      errors: [],
      warnings: [],
    });
    const toastId = toast.loading(rulesRunStartToast());
    try {
      const res = await api.post<{
        placements: Placement[];
        summary: AnalysisQcSummary;
        analysisRun?: AnalysisRunTrace & { id: string };
      }>(`/floors/${floorId}/placements/suggest`);

      setQcSummary(res.summary);
      const afterCount = await loadPlacements(false);
      await Promise.all([loadRuns(), loadRooms(), loadZones()]);
      setLiveRun(null);

      const run = res.analysisRun ?? (await api.get<AnalysisRunTrace | null>(`/floors/${floorId}/analysis/runs/latest`));
      if (run?.id) setActiveRunId(run.id);

      if (run) finishRunToast(run, beforeCount, afterCount, toastId);
      else toast.success('Internal Rules + QC finished.', { id: toastId });
    } catch (err) {
      setLiveRun(null);
      toast.error(formatApiError(err, 'Re-run Rule Suggestions'), { id: toastId });
    } finally {
      setRulesBusy(false);
    }
  }, [floorId, floor?.projectId, loadPlacements, loadRuns, loadRooms, loadZones, finishRunToast]);

  const pollFullAnalysis = useCallback(async (): Promise<AnalysisRunTrace | null> => {
    for (let i = 0; i < 180; i++) {
      const [status, latest] = await Promise.all([
        api.get<{ status?: string; error?: string }>(`/floors/${floorId}/analysis`),
        api.get<AnalysisRunTrace | null>(`/floors/${floorId}/analysis/runs/latest`),
      ]);
      if (latest?.kind === 'full_analysis') setLiveRun(latest);
      if (status?.status === 'done' || status?.status === 'failed') {
        return latest?.kind === 'full_analysis' ? latest : null;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }, [floorId]);

  const onFullAnalysis = useCallback(async () => {
    if (!rasterUrl && !floor?.raster?.key) {
      toast.error('No plan image on this floor. Upload a plan before running Full AI Analysis.');
      return;
    }
    setAnalysisBusy(true);
    const beforeCount = countVisiblePlacements(useEditor.getState().placements);
    const caps = capabilities ?? { aiServiceOk: false, yoloWeightsAvailable: false, fallbackProvider: 'disabled' as const };
    const toastId = toast.loading(fullAnalysisStartToast(caps));
    const fbToast = fullAnalysisFallbackToast(caps);
    if (fbToast) toast.info(fbToast);

    setLiveRun({
      id: 'live',
      projectId: floor?.projectId ?? '',
      floorId,
      kind: 'full_analysis',
      status: 'running',
      provider: 'cv',
      modelName: caps.yoloWeightsAvailable ? 'CV + YOLOv11 + OCR' : 'CV + OCR',
      fallbackChain: ['cv'],
      qcSettings: {},
      startedAt: new Date().toISOString(),
      detectedSpaces: 0,
      acceptedSpaces: 0,
      rejectedSpaces: 0,
      acceptedDevices: 0,
      rejectedDevices: 0,
      errors: [],
      warnings: [],
    });

    try {
      await api.post(`/floors/${floorId}/analysis`, { provider: 'cv' });
      const run = await pollFullAnalysis();
      const afterCount = await loadPlacements(false);
      await Promise.all([loadRuns(), loadRooms(), loadZones()]);
      setLiveRun(null);

      if (run?.id) setActiveRunId(run.id);
      const finalRun = run?.id
        ? await api.get<AnalysisRunTrace>(`/analysis-runs/${run.id}`)
        : run;

      if (finalRun) finishRunToast(finalRun, beforeCount, afterCount, toastId);
      else toast.success('Full AI analysis finished.', { id: toastId });
    } catch (err) {
      setLiveRun(null);
      toast.error(formatApiError(err, 'Run Full AI Analysis'), { id: toastId });
    } finally {
      setAnalysisBusy(false);
    }
  }, [floorId, floor, rasterUrl, capabilities, pollFullAnalysis, loadPlacements, loadRuns, loadRooms, loadZones, finishRunToast]);

  return (
    <div className="flex h-screen flex-col">
      <Toolbar
        floorName={floor?.name ?? 'Editor'}
        saving={saving}
        onVersions={() => setVersionsOpen(true)}
        floors={floors}
        currentFloorId={floorId}
        onSelectFloor={onSelectFloor}
        projectHref={floor?.projectId ? `/projects/${floor.projectId}` : undefined}
      />
      <AiActionsBar
        capabilities={capabilities}
        rulesBusy={rulesBusy}
        analysisBusy={analysisBusy}
        hasRaster={!!(rasterUrl || floor?.raster?.key)}
        onRulesResuggest={onRulesResuggest}
        onFullAnalysis={onFullAnalysis}
      />
      <VersionsModal
        floorId={floorId}
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        onRestored={() => { void loadPlacements(debugMode); }}
      />
      <div className="flex flex-1 overflow-hidden">
        <SpacesPanel floorId={floorId} onResuggest={onRulesResuggest} resuggestBusy={rulesBusy} />
        <DeviceLibraryPanel devices={devices} />
        <div className="flex flex-1 flex-col">
          <Canvas
            rasterUrl={rasterUrl}
            width={Math.max(1, floor?.raster?.width ?? 1200)}
            height={Math.max(1, floor?.raster?.height ?? 900)}
            onRoomMoved={onRoomMoved}
          />
          <AiWorkspacePanel
            runs={runs}
            activeRun={activeRun}
            onSelectRun={setActiveRunId}
            liveRun={liveRun}
            qcSummary={qcSummary}
            capabilities={capabilities}
            zones={zones}
            scale={floor?.scale}
            priors={priors}
            debugMode={debugMode}
            onToggleDebug={() => setDebugMode(!debugMode)}
          />
        </div>
        <PropertiesPanel devices={devices} />
      </div>
    </div>
  );
}
