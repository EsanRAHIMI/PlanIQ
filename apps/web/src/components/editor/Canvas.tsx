'use client';
import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KImage, Group, Rect, Text, Line } from 'react-konva';
import type Konva from 'konva';
import { useEditor } from '@/features/editor/store';
import { DEVICE_BY_CODE } from '@planiq/shared';

interface Props { rasterUrl: string | null; width: number; height: number; }

/** Figma-lite canvas: raster background + device markers, with zoom/pan/snap/select/drag. */
export function Canvas({ rasterUrl, width, height }: Props) {
  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [snap, setSnap] = useState(true);

  const placements = useEditor((s) => s.placements);
  const selectedIds = useEditor((s) => s.selectedIds);
  const zoom = useEditor((s) => s.zoom);
  const debugMode = useEditor((s) => s.debugMode);
  const layers = useEditor((s) => s.layers);
  const { select, clearSelection, updatePlacement, setZoom } = useEditor();

  useEffect(() => {
    if (!rasterUrl) return;
    const i = new window.Image(); i.crossOrigin = 'anonymous'; i.src = rasterUrl;
    i.onload = () => setImg(i);
  }, [rasterUrl]);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // base scale so the plan fits the viewport
  const baseScale = Math.min(size.w / width, size.h / height) || 1;
  const scale = baseScale * zoom;
  const planW = width * scale, planH = height * scale;
  const offX = (size.w - planW) / 2 + stagePos.x;
  const offY = (size.h - planH) / 2 + stagePos.y;

  const toNorm = (sx: number, sy: number) => ({ x: (sx - offX) / planW, y: (sy - offY) / planH });
  const snapVal = (v: number) => (snap ? Math.round(v * 40) / 40 : v); // 1/40 grid

  function onWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    setZoom(zoom * (e.evt.deltaY < 0 ? 1.1 : 0.9));
  }

  const hiddenLayerNames = new Set(layers.filter((l) => !l.visible).map((l) => l.name));
  const layerOfCategory = (cat: string) => layers.find((l) => (l.categories ?? []).includes?.(cat));

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-slate-100">
      <div className="absolute left-3 top-3 z-10 flex gap-2">
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setZoom(zoom * 1.2)}>＋</button>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setZoom(zoom * 0.8)}>－</button>
        <span className="rounded bg-white px-2 py-1 text-xs">{Math.round(zoom * 100)}%</span>
        <label className="flex items-center gap-1 rounded bg-white px-2 py-1 text-xs">
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap
        </label>
      </div>

      <Stage
        ref={stageRef} width={size.w} height={size.h} onWheel={onWheel}
        draggable onDragEnd={(e) => setStagePos({ x: e.target.x(), y: e.target.y() })}
        onMouseDown={(e) => { if (e.target === e.target.getStage()) clearSelection(); }}
      >
        <Layer>
          {img && <KImage image={img} x={offX} y={offY} width={planW} height={planH} listening={false} />}
          {!img && <Rect x={offX} y={offY} width={planW} height={planH} fill="#fff" stroke="#cbd5e1" />}
          {/* grid */}
          {snap && Array.from({ length: 41 }).map((_, i) => (
            <Line key={`v${i}`} points={[offX + (planW / 40) * i, offY, offX + (planW / 40) * i, offY + planH]} stroke="#e2e8f0" strokeWidth={0.5} listening={false} />
          ))}
        </Layer>

        <Layer>
          {Object.entries(placements).map(([id, p]) => {
            const def = DEVICE_BY_CODE[p.deviceCode];
            const cat = def?.category ?? '';
            const rejected = p.meta?.qcStatus === 'rejected' || (p.confidence != null && p.confidence < 0.62);
            if (p.hidden && !debugMode) return null;
            if (rejected && !debugMode) return null;
            const lyr = layerOfCategory(cat);
            if (lyr && !lyr.visible) return null;
            const x = offX + p.position.x * planW;
            const y = offY + p.position.y * planH;
            const selected = selectedIds.includes(id);
            const color = rejected ? '#94a3b8' : (def?.color ?? '#E11D2A');
            const opacity = rejected ? 0.45 : 1;
            return (
              <Group
                key={id} x={x} y={y} rotation={p.rotation} draggable={!p.locked && !rejected}
                opacity={opacity}
                onClick={(e) => select([id], e.evt.shiftKey)}
                onTap={() => select([id])}
                onDragEnd={(e) => {
                  const n = toNorm(e.target.x(), e.target.y());
                  updatePlacement(id, { position: { x: snapVal(Math.min(1, Math.max(0, n.x))), y: snapVal(Math.min(1, Math.max(0, n.y))) } });
                }}
              >
                <Rect x={-11} y={-11} width={22} height={22} cornerRadius={4} fill="#fff" stroke={color} strokeWidth={selected ? 3 : 1.5} shadowBlur={selected ? 6 : 0} shadowColor={color} />
                <Rect x={-6} y={-6} width={12} height={12} cornerRadius={2} fill={color} />
                {scale > 0.3 && <Text text={p.label ?? p.deviceCode} y={14} x={-30} width={60} align="center" fontSize={9} fill="#0f172a" />}
                {rejected && debugMode && <Text text="rejected" y={-18} x={-18} width={36} align="center" fontSize={7} fill="#ef4444" />}
                {p.locked && <Text text="🔒" x={6} y={-16} fontSize={9} />}
              </Group>
            );
          })}
        </Layer>
      </Stage>
    </div>
  );
}
