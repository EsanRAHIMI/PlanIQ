'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { api, formatApiError } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useEditor } from '@/features/editor/store';
import { DeviceLibraryPanel, PropertiesPanel } from '@/components/editor/Panels';
import { AiSummaryPanel } from '@/components/editor/AiSummaryPanel';
import { Toolbar } from '@/components/editor/Toolbar';
import { VersionsModal } from '@/components/editor/VersionsModal';
import type { AnalysisQcSummary, DeviceDef, Placement } from '@planiq/shared';

const Canvas = dynamic(() => import('@/components/editor/Canvas').then((m) => m.Canvas), { ssr: false });

export default function EditorPage() {
  const { floorId } = useParams<{ floorId: string }>();
  const router = useRouter();
  const [devices, setDevices] = useState<DeviceDef[]>([]);
  const [floor, setFloor] = useState<any>(null);
  const [floors, setFloors] = useState<any[]>([]);
  const [rasterUrl, setRasterUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [qcSummary, setQcSummary] = useState<AnalysisQcSummary | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  const { load, takeDirty, moveSelected, undo, redo, duplicateSelected, deleteSelected, clearSelection, debugMode, setDebugMode } = useEditor();
  const dirty = useEditor((s) => s.dirty);
  const deleted = useEditor((s) => s.deleted);

  const loadPlacements = useCallback(async (debug: boolean) => {
    const pl = await api.get<{ placements: Placement[]; layers: any[]; qcSummary?: AnalysisQcSummary }>(
      `/floors/${floorId}/placements${debug ? '?debug=1' : ''}`,
    );
    setQcSummary(pl.qcSummary ?? floor?.analysis?.qcSummary ?? null);
    const placements = pl.placements.map((p: any) => ({ ...p, id: p._id ?? p.id }));
    const layers = pl.layers.map((l: any) => ({ ...l, id: l._id ?? l.id }));
    load(floorId, placements as any, layers);
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
      } catch {
        // Auth failures handled globally in api.ts (toast + redirect).
      }
    })();
  }, [floorId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadPlacements(debugMode);
  }, [debugMode, loadPlacements]);

  /** Flush pending edits immediately. Reused by the debounce and before navigation. */
  const saveNow = useCallback(async () => {
    const { upserts, deletes } = takeDirty();
    if (!upserts.length && !deletes.length) return;
    setSaving(true);
    try {
      await api.patch(`/floors/${floorId}/placements`, {
        upserts: upserts.map((p: any) => ({ ...p, id: String(p.id).startsWith('loc_') ? undefined : p.id })),
        deletes: deletes.filter((d) => !d.startsWith('loc_')),
      });
    } catch {
      // Auth errors handled in api.ts; avoid unhandled rejection.
    } finally { setSaving(false); }
  }, [floorId, takeDirty]);

  useEffect(() => {
    if (dirty.size === 0 && deleted.size === 0) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveNow(); }, 800);
    return () => clearTimeout(saveTimer.current);
  }, [dirty, deleted, saveNow]);

  /** Persist pending edits, then switch floors. */
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
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      else if (e.key === 'Escape') { clearSelection(); }
      else if (e.key === 'ArrowUp') moveSelected(0, -0.005);
      else if (e.key === 'ArrowDown') moveSelected(0, 0.005);
      else if (e.key === 'ArrowLeft') moveSelected(-0.005, 0);
      else if (e.key === 'ArrowRight') moveSelected(0.005, 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, duplicateSelected, deleteSelected, clearSelection, moveSelected]);

  const onSuggest = useCallback(async () => {
    setSuggesting(true);
    const toastId = toast.loading('Re-running AI suggestions…');
    try {
      const res = await api.post<{
        placements: Placement[];
        summary: AnalysisQcSummary;
        replaced?: number;
        roomCount?: number;
      }>(`/floors/${floorId}/placements/suggest`);

      setQcSummary(res.summary);
      await loadPlacements(false);

      if (!res.placements?.length) {
        toast.warning('No suggestions passed quality checks. Enable debug mode to inspect rejections.', { id: toastId });
        return;
      }
      toast.success(`Applied ${res.placements.length} AI suggestion(s)`, { id: toastId });
    } catch (err) {
      toast.error(formatApiError(err, 'Re-run AI suggestions'), { id: toastId });
    } finally {
      setSuggesting(false);
    }
  }, [floorId, loadPlacements]);

  return (
    <div className="flex h-screen flex-col">
      <Toolbar
        floorName={floor?.name ?? 'Editor'}
        saving={saving}
        suggesting={suggesting}
        onSuggest={onSuggest}
        onVersions={() => setVersionsOpen(true)}
        floors={floors}
        currentFloorId={floorId}
        onSelectFloor={onSelectFloor}
        projectHref={floor?.projectId ? `/projects/${floor.projectId}` : undefined}
      />
      <VersionsModal
        floorId={floorId}
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        onRestored={() => loadPlacements(debugMode)}
      />
      <div className="flex flex-1 overflow-hidden">
        <DeviceLibraryPanel devices={devices} />
        <div className="flex flex-1 flex-col">
          <Canvas rasterUrl={rasterUrl} width={floor?.raster?.width ?? 1200} height={floor?.raster?.height ?? 900} />
          <AiSummaryPanel summary={qcSummary} debugMode={debugMode} onToggleDebug={() => setDebugMode(!debugMode)} />
        </div>
        <PropertiesPanel devices={devices} />
      </div>
    </div>
  );
}
