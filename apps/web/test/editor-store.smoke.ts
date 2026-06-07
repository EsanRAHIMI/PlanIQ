/**
 * Runnable data-safety smoke test for the REAL editor store (Zustand).
 * Covers: failed-autosave keeps dirty edits, delete is reversible (undo), redo, and the
 * dirty/deleted persistence queues. No DOM/React needed — exercises store actions directly.
 *
 * Run: node --experimental-strip-types apps/web/test/editor-store.smoke.ts (from repo root)
 */
import { useEditor } from '../src/features/editor/store.ts';

let pass = 0, fail = 0;
const ck = (n: string, c: boolean) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n); fail++; } };
const s = () => useEditor.getState();
const place = (id: string) => ({ id, deviceCode: 'WIFI_AP', position: { x: 0.5, y: 0.5 }, rotation: 0, scale: 1, locked: false, hidden: false } as any);

console.log('Editor store data-safety smoke:');

// fresh floor
s().load('floor-1', [], []);

// 1) add a device → it is dirty (queued for autosave)
s().addPlacement(place('loc_a'));
ck('add queues a dirty edit', s().dirty.size === 1 && Object.keys(s().placements).length === 1);

// 2) simulate a FAILED autosave: takeDirty drains the queue, then requeueDirty restores it
const drained = s().takeDirty();
ck('takeDirty returns the edit + clears queue', drained.upserts.length === 1 && s().dirty.size === 0);
const addedId = Object.keys(s().placements)[0];
s().requeueDirty([addedId], []);
ck('failed save → requeueDirty keeps the edit pending', s().dirty.size === 1 && !!s().placements[addedId]);

// 3) delete is reversible via undo
s().select([addedId]);
s().deleteSelected();
ck('delete removes the device', !s().placements[addedId]);
s().undo();
ck('undo restores the deleted device (reversible)', !!s().placements[addedId]);
s().redo();
ck('redo re-deletes', !s().placements[addedId]);

// 4) requeue only keeps ids that still exist (no resurrection of hard-deleted)
s().requeueDirty(['loc_ghost'], []);
ck('requeue ignores non-existent ids', !s().placements['loc_ghost']);

// 5) lock prevents move/delete (data-integrity)
s().load('floor-2', [], []);
s().addPlacement(place('loc_b'));
const bId = Object.keys(s().placements)[0];
s().select([bId]); s().toggleLock();
s().deleteSelected();
ck('locked device is not deleted', !!s().placements[bId]);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
