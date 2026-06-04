'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Stage, Layer, Image as KImage, Group, Rect, Text, Line } from 'react-konva';
import type Konva from 'konva';
import { useEditor } from '@/features/editor/store';
import { DEVICE_BY_CODE, DEFAULT_LAYERS } from '@planiq/shared';

interface Props {
  rasterUrl: string | null;
  width: number;
  height: number;
  /** Persist a space move (normalized centroid + polygon) after a drag. */
  onRoomMoved?: (id: string, centroid: [number, number], polygon: number[][]) => void;
}

/** Outline + fill colour for each space review status. */
const ROOM_STYLE: Record<string, { stroke: string; fill: string; tag: string }> = {
  ai_detected:    { stroke: '#2563EB', fill: 'rgba(37,99,235,0.10)',  tag: 'AI' },
  accepted:       { stroke: '#16A34A', fill: 'rgba(22,163,74,0.12)',  tag: '✓' },
  user_corrected: { stroke: '#D97706', fill: 'rgba(217,119,6,0.12)',  tag: '✎' },
  rejected:       { stroke: '#EF4444', fill: 'rgba(239,68,68,0.07)',  tag: '✕' },
};
const roomStyle = (s?: string) => ROOM_STYLE[s ?? 'ai_detected'] ?? ROOM_STYLE.ai_detected;
const roomBox = (centroid: number[], half = 0.05): number[][] => {
  const [cx, cy] = centroid;
  return [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]];
};
const ROOM_TYPE_LABEL: Record<string, string> = {
  bedroom: 'Bedroom', master_bedroom: 'Master Bed', maid_room: 'Maid', majlis: 'Majlis',
  living_room: 'Living', sitting_area: 'Sitting', dining: 'Dining', kitchen: 'Kitchen',
  corridor: 'Corridor', entrance: 'Entrance', main_door: 'Main Door', outdoor: 'Outdoor',
  garden: 'Garden', parking: 'Parking', gate: 'Gate', staircase: 'Stairs', lift: 'Lift',
  bathroom: 'Bathroom', store: 'Store', service_area: 'Service', roof: 'Roof',
};

const MIN_DIM = 1;

/** Avoid Konva drawImage crashes when layout or raster dims are transiently zero. */
function safeDim(v: number, fallback = MIN_DIM): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function imageReady(img: HTMLImageElement | null): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Persisted layers often lack the `categories` field (seeding drops it), so we
// fall back to matching the layer name against the default catalog.
const LAYER_CATS_BY_NAME: Record<string, string[]> =
  Object.fromEntries(DEFAULT_LAYERS.map((l) => [l.name, l.categories]));

/** Figma-lite canvas: raster background + device markers, with zoom/pan/snap/marquee-select/drag. */
export function Canvas({ rasterUrl, width, height, onRoomMoved }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panning = useRef(false);
  const spaceDown = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [snap, setSnap] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [cursor, setCursor] = useState<'default' | 'grab' | 'grabbing'>('default');

  // Marquee selection rectangle, in stage (screen) pixel coords.
  const marquee = useRef<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null);
  const [marqueeBox, setMarqueeBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const placements = useEditor((s) => s.placements);
  const selectedIds = useEditor((s) => s.selectedIds);
  const zoom = useEditor((s) => s.zoom);
  const debugMode = useEditor((s) => s.debugMode);
  const layers = useEditor((s) => s.layers);
  const rooms = useEditor((s) => s.rooms);
  const roomsVisible = useEditor((s) => s.roomsVisible);
  const selectedRoomId = useEditor((s) => s.selectedRoomId);
  const { select, clearSelection, updatePlacement, setZoom, setDebugMode, selectRoom, patchRoomLocal, setRoomsVisible } = useEditor();

  useEffect(() => {
    if (!rasterUrl) { setImg(null); return; }
    const i = new window.Image(); i.crossOrigin = 'anonymous'; i.src = rasterUrl;
    i.onload = () => setImg(i);
  }, [rasterUrl]);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      const h = e.contentRect.height;
      // ResizeObserver can briefly report 0 during flex reflow (e.g. toasts / AI bar).
      if (w < MIN_DIM || h < MIN_DIM) return;
      setSize({ w, h });
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const planWidth = safeDim(width, 1200);
  const planHeight = safeDim(height, 900);
  const stageW = safeDim(size.w, 800);
  const stageH = safeDim(size.h, 600);

  // Geometry (kept in a ref so window listeners read fresh values without re-registering).
  const baseScale = Math.min(stageW / planWidth, stageH / planHeight) || 1;
  const scale = baseScale * zoom;
  const planW = planWidth * scale;
  const planH = planHeight * scale;
  const groupX = (stageW - planW) / 2 + pan.x;
  const groupY = (stageH - planH) / 2 + pan.y;
  const geom = useRef({ groupX, groupY, planW, planH });
  geom.current = { groupX, groupY, planW, planH };

  // Square-cell grid: derive per-axis steps from the plan aspect so cells are
  // square in plan-pixel space (fixes snap distortion on non-square plans).
  const longer = Math.max(planWidth, planHeight);
  const stepX = longer / (40 * planWidth);
  const stepY = longer / (40 * planHeight);
  const vLines = Math.round(1 / stepX);
  const hLines = Math.round(1 / stepY);
  const snapX = (v: number) => (snap ? clamp01(Math.round(v / stepX) * stepX) : clamp01(v));
  const snapY = (v: number) => (snap ? clamp01(Math.round(v / stepY) * stepY) : clamp01(v));

  // Space-bar toggles pan mode (Figma-style); middle mouse also pans.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !spaceDown.current) {
        const t = e.target as HTMLElement;
        if (t?.tagName === 'INPUT' || t?.tagName === 'SELECT' || t?.tagName === 'TEXTAREA') return;
        spaceDown.current = true; setCursor('grab'); e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') { spaceDown.current = false; if (!panning.current) setCursor('default'); }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  const isRenderable = useCallback((p: any) => {
    const def = DEVICE_BY_CODE[p.deviceCode];
    const cat = def?.category ?? '';
    const rejected = p.meta?.qcStatus === 'rejected' || (p.confidence != null && p.confidence < 0.62);
    if (p.hidden && !debugMode) return false;
    if (rejected && !debugMode) return false;
    const lyr = layers.find((l) => (l.categories ?? LAYER_CATS_BY_NAME[l.name] ?? []).includes(cat));
    if (lyr && lyr.visible === false) return false;
    return true;
  }, [debugMode, layers]);

  // Pan + marquee pointer handling on window (so a drag that leaves the canvas still tracks).
  useEffect(() => {
    const rectOf = () => containerRef.current?.getBoundingClientRect();
    const onMove = (e: MouseEvent) => {
      if (panning.current) {
        const dx = e.clientX - lastPointer.current.x;
        const dy = e.clientY - lastPointer.current.y;
        lastPointer.current = { x: e.clientX, y: e.clientY };
        setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
        return;
      }
      if (marquee.current) {
        const r = rectOf(); if (!r) return;
        marquee.current.x1 = e.clientX - r.left;
        marquee.current.y1 = e.clientY - r.top;
        const m = marquee.current;
        setMarqueeBox({ x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1), w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0) });
      }
    };
    const onUp = () => {
      if (panning.current) { panning.current = false; setCursor(spaceDown.current ? 'grab' : 'default'); }
      if (marquee.current) {
        const m = marquee.current;
        const moved = Math.abs(m.x1 - m.x0) > 4 || Math.abs(m.y1 - m.y0) > 4;
        if (moved) {
          const { groupX: gX, groupY: gY, planW: pW, planH: pH } = geom.current;
          const xmin = Math.min(m.x0, m.x1), xmax = Math.max(m.x0, m.x1);
          const ymin = Math.min(m.y0, m.y1), ymax = Math.max(m.y0, m.y1);
          const ids = Object.entries(useEditor.getState().placements)
            .filter(([, p]) => isRenderable(p))
            .filter(([, p]) => {
              const sx = gX + p.position.x * pW;
              const sy = gY + p.position.y * pH;
              return sx >= xmin && sx <= xmax && sy >= ymin && sy <= ymax;
            })
            .map(([id]) => id);
          select(ids, m.additive);
        }
        marquee.current = null;
        setMarqueeBox(null);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [isRenderable, select]);

  function onWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    setZoom(zoom * (e.evt.deltaY < 0 ? 1.1 : 0.9));
  }

  function startPan(clientX: number, clientY: number) {
    panning.current = true; setCursor('grabbing');
    lastPointer.current = { x: clientX, y: clientY };
  }

  // Empty-canvas mousedown: pan (space / middle button) or begin a marquee.
  function onEmptyMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    e.cancelBubble = true;
    const evt = e.evt;
    if (spaceDown.current || evt.button === 1) { startPan(evt.clientX, evt.clientY); return; }
    if (evt.button !== 0) return;
    const r = containerRef.current?.getBoundingClientRect(); if (!r) return;
    const x = evt.clientX - r.left, y = evt.clientY - r.top;
    if (!evt.shiftKey) clearSelection();
    marquee.current = { x0: x, y0: y, x1: x, y1: y, additive: evt.shiftKey };
    setMarqueeBox({ x, y, w: 0, h: 0 });
  }

  function fitView() { setPan({ x: 0, y: 0 }); setZoom(1); }

  const Ctrl = ({ onClick, active, children, title }: any) => (
    <button
      title={title}
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs shadow-sm ${active ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
    >{children}</button>
  );

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-slate-100" style={{ cursor }}>
      <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-2">
        <Ctrl onClick={() => setZoom(zoom * 1.2)} title="Zoom in">＋</Ctrl>
        <Ctrl onClick={() => setZoom(zoom * 0.8)} title="Zoom out">－</Ctrl>
        <span className="rounded bg-white px-2 py-1 text-xs shadow-sm">{Math.round(zoom * 100)}%</span>
        <Ctrl onClick={fitView} title="Fit plan to screen">Fit</Ctrl>
        <Ctrl onClick={() => setSnap(!snap)} active={snap} title="Snap to grid">Snap</Ctrl>
        <Ctrl onClick={() => setShowGrid(!showGrid)} active={showGrid} title="Show grid">Grid</Ctrl>
        <Ctrl onClick={() => setRoomsVisible(!roomsVisible)} active={roomsVisible} title="Show detected spaces">Spaces</Ctrl>
        <Ctrl onClick={() => setDebugMode(!debugMode)} active={debugMode} title="Show rejected suggestions">
          {debugMode ? 'All' : 'Accepted'}
        </Ctrl>
      </div>
      {selectedIds.length > 0 && (
        <div className="absolute right-3 top-3 z-10 rounded bg-slate-900/90 px-2 py-1 text-xs text-white shadow-sm">
          {selectedIds.length} selected
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded bg-white/80 px-2 py-1 text-[10px] text-slate-500 shadow-sm">
        Drag to select · Space/middle-drag to pan · Scroll to zoom
      </div>

      <Stage
        width={stageW}
        height={stageH}
        onWheel={onWheel}
        onMouseDown={(e) => { if (e.target === e.target.getStage()) onEmptyMouseDown(e); }}
      >
        <Layer>
          <Group x={groupX} y={groupY}>
            <Rect
              name="plan-bg" x={0} y={0} width={Math.max(planW, MIN_DIM)} height={Math.max(planH, MIN_DIM)}
              fill={imageReady(img) ? undefined : '#fff'} stroke="#cbd5e1"
              onMouseDown={onEmptyMouseDown}
            />
            {imageReady(img) && planW >= MIN_DIM && planH >= MIN_DIM && (
              <KImage image={img} x={0} y={0} width={planW} height={planH} listening={false} />
            )}
            {showGrid && Array.from({ length: vLines + 1 }).map((_, i) => (
              <Line key={`v${i}`} points={[stepX * i * planW, 0, stepX * i * planW, planH]}
                stroke="#e2e8f0" strokeWidth={0.5} listening={false} />
            ))}
            {showGrid && Array.from({ length: hLines + 1 }).map((_, j) => (
              <Line key={`h${j}`} points={[0, stepY * j * planH, planW, stepY * j * planH]}
                stroke="#e2e8f0" strokeWidth={0.5} listening={false} />
            ))}
          </Group>
        </Layer>

        {roomsVisible && rooms.length > 0 && (
          <Layer>
            <Group x={groupX} y={groupY}>
              {rooms.map((r) => {
                const id = String(r._id ?? r.id ?? '');
                const st = roomStyle(r.reviewStatus);
                const poly = r.polygon && r.polygon.length >= 3 ? r.polygon : roomBox(r.centroid as number[]);
                const pts = poly.flatMap(([px, py]) => [px * planW, py * planH]);
                const cx = (Number(r.centroid?.[0]) || 0.5) * planW;
                const cy = (Number(r.centroid?.[1]) || 0.5) * planH;
                const selected = selectedRoomId === id;
                const conf = r.confidence != null ? `${Math.round(r.confidence * 100)}%` : '';
                const label = `${ROOM_TYPE_LABEL[r.type] ?? r.type}${conf ? ` · ${conf}` : ''}`;
                return (
                  <Group
                    key={`room-${id}`}
                    draggable
                    onMouseDown={(e) => { e.cancelBubble = true; selectRoom(id); }}
                    onClick={(e) => { e.cancelBubble = true; selectRoom(id); }}
                    onMouseEnter={(e) => { const s = e.target.getStage(); if (s) s.container().style.cursor = 'move'; }}
                    onMouseLeave={(e) => { const s = e.target.getStage(); if (s) s.container().style.cursor = cursor; }}
                    onDragEnd={(e) => {
                      const node = e.target;
                      const dx = node.x() / planW;
                      const dy = node.y() / planH;
                      node.position({ x: 0, y: 0 });
                      if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return;
                      const newPoly = poly.map(([px, py]) => [clamp01(px + dx), clamp01(py + dy)]);
                      const newCentroid: [number, number] = [
                        clamp01((Number(r.centroid?.[0]) || 0.5) + dx),
                        clamp01((Number(r.centroid?.[1]) || 0.5) + dy),
                      ];
                      patchRoomLocal(id, { polygon: newPoly, centroid: newCentroid });
                      onRoomMoved?.(id, newCentroid, newPoly);
                    }}
                  >
                    <Line
                      points={pts} closed fill={st.fill} stroke={st.stroke}
                      strokeWidth={selected ? 3 : 1.5}
                      dash={r.reviewStatus === 'rejected' ? [6, 4] : undefined}
                      shadowBlur={selected ? 6 : 0} shadowColor={st.stroke}
                      opacity={r.reviewStatus === 'rejected' ? 0.85 : 1}
                    />
                    {scale > 0.25 && (
                      <Text text={label} x={cx - 45} y={cy - 7} width={90} align="center"
                        fontSize={10} fontStyle="bold" fill={st.stroke} listening={false} />
                    )}
                    {scale > 0.25 && (
                      <Text text={st.tag} x={cx - 45} y={cy + 6} width={90} align="center"
                        fontSize={8} fill={st.stroke} listening={false} />
                    )}
                  </Group>
                );
              })}
            </Group>
          </Layer>
        )}

        <Layer>
          <Group x={groupX} y={groupY}>
            {Object.entries(placements).map(([id, p]) => {
              const def = DEVICE_BY_CODE[p.deviceCode];
              const cat = def?.category ?? '';
              const rejected = p.meta?.qcStatus === 'rejected' || (p.confidence != null && p.confidence < 0.62);
              if (p.hidden && !debugMode) return null;
              if (rejected && !debugMode) return null;
              const lyr = layers.find((l) => (l.categories ?? LAYER_CATS_BY_NAME[l.name] ?? []).includes(cat));
              if (lyr && lyr.visible === false) return null;
              const x = p.position.x * planW;
              const y = p.position.y * planH;
              const selected = selectedIds.includes(id);
              const color = rejected ? '#94a3b8' : (def?.color ?? '#E11D2A');
              const opacity = rejected ? 0.45 : (p.hidden ? 0.4 : 1);
              return (
                <Group
                  key={id} x={x} y={y} rotation={p.rotation}
                  draggable={!p.locked && !rejected}
                  opacity={opacity}
                  onMouseDown={(e) => { e.cancelBubble = true; if (!selectedIds.includes(id)) select([id], e.evt.shiftKey); }}
                  onClick={(e) => { e.cancelBubble = true; select([id], e.evt.shiftKey); }}
                  onTap={() => select([id])}
                  onMouseEnter={(e) => { const s = e.target.getStage(); if (s) s.container().style.cursor = p.locked ? 'not-allowed' : 'move'; }}
                  onMouseLeave={(e) => { const s = e.target.getStage(); if (s) s.container().style.cursor = cursor; }}
                  onDragEnd={(e) => {
                    const node = e.target;
                    const nx = snapX(node.x() / planW);
                    const ny = snapY(node.y() / planH);
                    updatePlacement(id, { position: { x: nx, y: ny } });
                    node.position({ x: nx * planW, y: ny * planH });
                  }}
                >
                  <Rect x={-11} y={-11} width={22} height={22} cornerRadius={4} fill="#fff" stroke={color}
                    strokeWidth={selected ? 3 : 1.5} shadowBlur={selected ? 8 : 0} shadowColor={color} />
                  <Rect x={-6} y={-6} width={12} height={12} cornerRadius={2} fill={color} />
                  {scale > 0.3 && <Text text={p.label ?? p.deviceCode} y={14} x={-30} width={60} align="center" fontSize={9} fill="#0f172a" />}
                  {rejected && debugMode && <Text text="rejected" y={-18} x={-18} width={36} align="center" fontSize={7} fill="#ef4444" />}
                  {p.hidden && debugMode && !rejected && <Text text="hidden" y={-18} x={-18} width={36} align="center" fontSize={7} fill="#64748b" />}
                  {p.locked && <Text text="🔒" x={6} y={-16} fontSize={9} />}
                </Group>
              );
            })}
          </Group>
        </Layer>

        {marqueeBox && (
          <Layer listening={false}>
            <Rect x={marqueeBox.x} y={marqueeBox.y} width={marqueeBox.w} height={marqueeBox.h}
              fill="rgba(37,99,235,0.10)" stroke="#2563EB" strokeWidth={1} dash={[4, 4]} />
          </Layer>
        )}
      </Stage>
    </div>
  );
}
