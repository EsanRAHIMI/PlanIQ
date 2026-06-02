'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Stage, Layer, Image as KImage, Group, Rect, Text, Line } from 'react-konva';
import type Konva from 'konva';
import { useEditor } from '@/features/editor/store';
import { DEVICE_BY_CODE } from '@planiq/shared';

interface Props { rasterUrl: string | null; width: number; height: number; }

/** Figma-lite canvas: raster background + device markers, with zoom/pan/snap/select/drag. */
export function Canvas({ rasterUrl, width, height }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panning = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
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

  const endPan = useCallback(() => { panning.current = false; }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!panning.current) return;
      const dx = e.clientX - lastPointer.current.x;
      const dy = e.clientY - lastPointer.current.y;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', endPan);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', endPan);
    };
  }, [endPan]);

  const baseScale = Math.min(size.w / width, size.h / height) || 1;
  const scale = baseScale * zoom;
  const planW = width * scale;
  const planH = height * scale;
  const groupX = (size.w - planW) / 2 + pan.x;
  const groupY = (size.h - planH) / 2 + pan.y;

  const snapVal = (v: number) => (snap ? Math.round(v * 40) / 40 : v);

  function onWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    setZoom(zoom * (e.evt.deltaY < 0 ? 1.1 : 0.9));
  }

  function startPan(e: Konva.KonvaEventObject<MouseEvent>) {
    panning.current = true;
    lastPointer.current = { x: e.evt.clientX, y: e.evt.clientY };
  }

  function onBackgroundMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    e.cancelBubble = true;
    clearSelection();
    startPan(e);
  }

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
        width={size.w}
        height={size.h}
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (e.target === e.target.getStage()) {
            clearSelection();
            startPan(e);
          }
        }}
      >
        <Layer>
          <Group x={groupX} y={groupY}>
            <Rect
              name="plan-bg"
              x={0}
              y={0}
              width={planW}
              height={planH}
              fill={img ? undefined : '#fff'}
              stroke="#cbd5e1"
              onMouseDown={onBackgroundMouseDown}
            />
            {img && (
              <KImage
                image={img}
                x={0}
                y={0}
                width={planW}
                height={planH}
                listening={false}
              />
            )}
            {snap && Array.from({ length: 41 }).map((_, i) => (
              <Line
                key={`v${i}`}
                name="plan-grid"
                points={[(planW / 40) * i, 0, (planW / 40) * i, planH]}
                stroke="#e2e8f0"
                strokeWidth={0.5}
                listening={false}
              />
            ))}
          </Group>
        </Layer>

        <Layer>
          <Group x={groupX} y={groupY}>
            {Object.entries(placements).map(([id, p]) => {
              const def = DEVICE_BY_CODE[p.deviceCode];
              const cat = def?.category ?? '';
              const rejected = p.meta?.qcStatus === 'rejected' || (p.confidence != null && p.confidence < 0.62);
              if (p.hidden && !debugMode) return null;
              if (rejected && !debugMode) return null;
              const lyr = layerOfCategory(cat);
              if (lyr && !lyr.visible) return null;
              const x = p.position.x * planW;
              const y = p.position.y * planH;
              const selected = selectedIds.includes(id);
              const color = rejected ? '#94a3b8' : (def?.color ?? '#E11D2A');
              const opacity = rejected ? 0.45 : 1;
              return (
                <Group
                  key={id}
                  x={x}
                  y={y}
                  rotation={p.rotation}
                  draggable={!p.locked && !rejected}
                  opacity={opacity}
                  onMouseDown={(e) => { e.cancelBubble = true; }}
                  onClick={(e) => select([id], e.evt.shiftKey)}
                  onTap={() => select([id])}
                  onDragEnd={(e) => {
                    const node = e.target;
                    const nx = snapVal(Math.min(1, Math.max(0, node.x() / planW)));
                    const ny = snapVal(Math.min(1, Math.max(0, node.y() / planH)));
                    updatePlacement(id, { position: { x: nx, y: ny } });
                    node.position({ x: nx * planW, y: ny * planH });
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
          </Group>
        </Layer>
      </Stage>
    </div>
  );
}
