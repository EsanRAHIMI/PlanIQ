'use client';
import { create } from 'zustand';
import { enableMapSet, produce } from 'immer';
import type { Placement } from '@planiq/shared';

enableMapSet();

/** Editor state with an undo/redo command stack and debounced-dirty tracking. */
interface HistoryEntry { placements: Record<string, Placement>; }

interface EditorState {
  floorId: string | null;
  placements: Record<string, Placement>;
  layers: any[];
  selectedIds: string[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  dirty: Set<string>;
  deleted: Set<string>;
  zoom: number;
  debugMode: boolean;
  setDebugMode: (v: boolean) => void;
  // setup
  load: (floorId: string, placements: Placement[], layers: any[]) => void;
  // selection
  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  // mutations (all push history)
  addPlacement: (p: Placement) => void;
  updatePlacement: (id: string, patch: Partial<Placement>) => void;
  moveSelected: (dx: number, dy: number) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  rotateSelected: (deg: number) => void;
  toggleLock: () => void;
  toggleHide: () => void;
  groupSelected: () => void;
  setLayerVisibility: (layerId: string, visible: boolean) => void;
  setZoom: (z: number) => void;
  undo: () => void;
  redo: () => void;
  // persistence helpers
  takeDirty: () => { upserts: Placement[]; deletes: string[] };
}

const snapshot = (s: EditorState): HistoryEntry => ({ placements: JSON.parse(JSON.stringify(s.placements)) });
const uid = () => `loc_${Math.random().toString(36).slice(2, 10)}`;

export const useEditor = create<EditorState>((set, get) => ({
  floorId: null, placements: {}, layers: [], selectedIds: [], past: [], future: [],
  dirty: new Set(), deleted: new Set(), zoom: 1, debugMode: false,

  load: (floorId, placements, layers) => set({
    floorId, layers, selectedIds: [], past: [], future: [], dirty: new Set(), deleted: new Set(),
    placements: Object.fromEntries(placements.map((p) => [p.id ?? uid(), p])),
  }),

  select: (ids, additive) => set((s) => ({ selectedIds: additive ? [...new Set([...s.selectedIds, ...ids])] : ids })),
  clearSelection: () => set({ selectedIds: [] }),

  addPlacement: (p) => set(produce((s: EditorState) => {
    s.past.push(snapshot(s)); s.future = [];
    const id = p.id ?? uid();
    s.placements[id] = { ...p, id }; s.dirty.add(id); s.selectedIds = [id];
  })),

  updatePlacement: (id, patch) => set(produce((s: EditorState) => {
    s.past.push(snapshot(s)); s.future = [];
    Object.assign(s.placements[id], patch); s.dirty.add(id);
  })),

  moveSelected: (dx, dy) => set(produce((s: EditorState) => {
    s.past.push(snapshot(s)); s.future = [];
    for (const id of s.selectedIds) {
      const p = s.placements[id]; if (!p || p.locked) continue;
      p.position.x = Math.min(1, Math.max(0, p.position.x + dx));
      p.position.y = Math.min(1, Math.max(0, p.position.y + dy));
      s.dirty.add(id);
    }
  })),

  rotateSelected: (deg) => set(produce((s: EditorState) => {
    s.past.push(snapshot(s)); s.future = [];
    for (const id of s.selectedIds) { const p = s.placements[id]; if (p && !p.locked) { p.rotation = (p.rotation + deg) % 360; s.dirty.add(id); } }
  })),

  deleteSelected: () => set(produce((s: EditorState) => {
    s.past.push(snapshot(s)); s.future = [];
    for (const id of s.selectedIds) { if (s.placements[id]?.locked) continue; delete s.placements[id]; s.dirty.delete(id); s.deleted.add(id); }
    s.selectedIds = [];
  })),

  duplicateSelected: () => set(produce((s: EditorState) => {
    s.past.push(snapshot(s)); s.future = [];
    const newIds: string[] = [];
    for (const id of s.selectedIds) {
      const src = s.placements[id]; if (!src) continue;
      const nid = uid();
      s.placements[nid] = { ...JSON.parse(JSON.stringify(src)), id: nid, position: { x: Math.min(1, src.position.x + 0.02), y: Math.min(1, src.position.y + 0.02) } };
      s.dirty.add(nid); newIds.push(nid);
    }
    s.selectedIds = newIds;
  })),

  toggleLock: () => set(produce((s: EditorState) => {
    s.past.push(snapshot(s)); s.future = [];
    for (const id of s.selectedIds) { const p = s.placements[id]; if (p) { p.locked = !p.locked; s.dirty.add(id); } }
  })),

  toggleHide: () => set(produce((s: EditorState) => {
    s.past.push(snapshot(s)); s.future = [];
    for (const id of s.selectedIds) { const p = s.placements[id]; if (p) { p.hidden = !p.hidden; s.dirty.add(id); } }
  })),

  groupSelected: () => set(produce((s: EditorState) => {
    s.past.push(snapshot(s)); s.future = [];
    const g = uid();
    for (const id of s.selectedIds) { const p = s.placements[id]; if (p) { p.groupId = g; s.dirty.add(id); } }
  })),

  setLayerVisibility: (layerId, visible) => set(produce((s: EditorState) => {
    const l = s.layers.find((x) => x.id === layerId || x._id === layerId); if (l) l.visible = visible;
  })),

  setZoom: (z) => set({ zoom: Math.min(5, Math.max(0.2, z)) }),
  setDebugMode: (debugMode) => set({ debugMode }),

  undo: () => set(produce((s: EditorState) => {
    const prev = s.past.pop(); if (!prev) return;
    s.future.push(snapshot(s)); s.placements = prev.placements;
    Object.keys(prev.placements).forEach((id) => s.dirty.add(id));
  })),
  redo: () => set(produce((s: EditorState) => {
    const next = s.future.pop(); if (!next) return;
    s.past.push(snapshot(s)); s.placements = next.placements;
    Object.keys(next.placements).forEach((id) => s.dirty.add(id));
  })),

  takeDirty: () => {
    const s = get();
    const upserts = [...s.dirty].map((id) => s.placements[id]).filter(Boolean) as Placement[];
    const deletes = [...s.deleted];
    set({ dirty: new Set(), deleted: new Set() });
    return { upserts, deletes };
  },
}));
