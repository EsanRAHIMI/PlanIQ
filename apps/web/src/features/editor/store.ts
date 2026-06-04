'use client';
import { create } from 'zustand';
import { enableMapSet, produce } from 'immer';
import { reconcileRestore } from '@planiq/shared';
import type { Placement } from '@planiq/shared';

enableMapSet();

/** Detected/edited space as stored in Mongo (loose shape: carries _id from the API). */
export interface RoomDoc {
  _id?: string;
  id?: string;
  label?: string;
  type: string;
  polygon: number[][];
  centroid: [number, number] | number[];
  area?: number;
  confidence?: number;
  source?: 'cv' | 'manual';
  reviewStatus?: 'ai_detected' | 'rejected' | 'accepted' | 'user_corrected';
  aiType?: string | null;
  rejectionReason?: string | null;
  meta?: Record<string, any>;
}

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
  // detected spaces (reviewed via API, not part of placement undo history)
  rooms: RoomDoc[];
  roomsVisible: boolean;
  selectedRoomId: string | null;
  setRooms: (rooms: RoomDoc[]) => void;
  setRoomsVisible: (v: boolean) => void;
  selectRoom: (id: string | null) => void;
  patchRoomLocal: (id: string, patch: Partial<RoomDoc>) => void;
  removeRoomLocal: (id: string) => void;
  upsertRoomLocal: (room: RoomDoc) => void;
  // setup
  load: (floorId: string, placements: Placement[], layers: any[]) => void;
  // selection
  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  // mutations (all push history)
  addPlacement: (p: Placement) => void;
  updatePlacement: (id: string, patch: Partial<Placement>) => void;
  updateSelected: (patch: Partial<Placement>) => void;
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
  rooms: [], roomsVisible: true, selectedRoomId: null,

  setRooms: (rooms) => set({ rooms }),
  setRoomsVisible: (roomsVisible) => set({ roomsVisible }),
  selectRoom: (selectedRoomId) => set({ selectedRoomId }),
  patchRoomLocal: (id, patch) => set(produce((s: EditorState) => {
    const i = s.rooms.findIndex((r) => (r._id ?? r.id) === id);
    if (i >= 0) Object.assign(s.rooms[i], patch);
  })),
  removeRoomLocal: (id) => set(produce((s: EditorState) => {
    s.rooms = s.rooms.filter((r) => (r._id ?? r.id) !== id);
    if (s.selectedRoomId === id) s.selectedRoomId = null;
  })),
  upsertRoomLocal: (room) => set(produce((s: EditorState) => {
    const id = room._id ?? room.id;
    const i = s.rooms.findIndex((r) => (r._id ?? r.id) === id);
    if (i >= 0) s.rooms[i] = room;
    else s.rooms.push(room);
  })),

  load: (floorId, placements, layers) => set({
    floorId, layers, selectedIds: [], past: [], future: [], dirty: new Set(), deleted: new Set(),
    rooms: [], selectedRoomId: null,
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

  updateSelected: (patch) => set(produce((s: EditorState) => {
    if (!s.selectedIds.length) return;
    s.past.push(snapshot(s)); s.future = [];
    for (const id of s.selectedIds) {
      const p = s.placements[id]; if (!p) continue;
      Object.assign(p, patch); s.dirty.add(id);
    }
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

  // Undo/redo replace the placement map wholesale, then reconcile the
  // persistence sets against that change (see reconcileRestore). This keeps
  // restored-after-delete devices alive and avoids re-upserting the whole floor.
  undo: () => set((s) => {
    if (!s.past.length) return {} as Partial<EditorState>;
    const prev = s.past[s.past.length - 1];
    const { dirty, deleted } = reconcileRestore(s.placements, prev.placements, s.dirty, s.deleted);
    return {
      past: s.past.slice(0, -1),
      future: [...s.future, snapshot(s)],
      placements: prev.placements,
      dirty, deleted,
      selectedIds: s.selectedIds.filter((id) => prev.placements[id]),
    };
  }),
  redo: () => set((s) => {
    if (!s.future.length) return {} as Partial<EditorState>;
    const next = s.future[s.future.length - 1];
    const { dirty, deleted } = reconcileRestore(s.placements, next.placements, s.dirty, s.deleted);
    return {
      past: [...s.past, snapshot(s)],
      future: s.future.slice(0, -1),
      placements: next.placements,
      dirty, deleted,
      selectedIds: s.selectedIds.filter((id) => next.placements[id]),
    };
  }),

  takeDirty: () => {
    const s = get();
    const upserts = [...s.dirty].map((id) => s.placements[id]).filter(Boolean) as Placement[];
    const deletes = [...s.deleted];
    set({ dirty: new Set(), deleted: new Set() });
    return { upserts, deletes };
  },
}));
