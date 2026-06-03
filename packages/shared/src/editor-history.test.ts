import { describe, it, expect } from 'vitest';
import { reconcileRestore } from './editor-history';

type P = { id: string; x: number };
const map = (...ps: P[]): Record<string, P> => Object.fromEntries(ps.map((p) => [p.id, p]));

describe('reconcileRestore', () => {
  it('keeps a restored-after-delete device alive (no lingering delete)', () => {
    // User deleted "a": it is gone from the map and queued for server delete.
    const current = map({ id: 'b', x: 1 });
    const deleted = new Set(['a']);
    const dirty = new Set<string>();
    // Undo restores the snapshot that still contained "a".
    const restored = map({ id: 'a', x: 0 }, { id: 'b', x: 1 });

    const next = reconcileRestore(current, restored, dirty, deleted);

    expect(next.deleted.has('a')).toBe(false); // delete cancelled — no data loss
    expect(next.dirty.has('a')).toBe(true);    // re-created on server via upsert
  });

  it('re-deletes on redo of a delete', () => {
    // After the undo above, "a" is back. Redo replays the delete.
    const current = map({ id: 'a', x: 0 }, { id: 'b', x: 1 });
    const restored = map({ id: 'b', x: 1 });
    const next = reconcileRestore(current, restored, new Set(['a']), new Set());

    expect(next.deleted.has('a')).toBe(true);
    expect(next.dirty.has('a')).toBe(false);
  });

  it('marks only changed ids dirty, not the whole floor', () => {
    const current = map({ id: 'a', x: 0 }, { id: 'b', x: 1 }, { id: 'c', x: 2 });
    // Restore differs only in "b".
    const restored = map({ id: 'a', x: 0 }, { id: 'b', x: 9 }, { id: 'c', x: 2 });
    const next = reconcileRestore(current, restored, new Set(), new Set());

    expect([...next.dirty].sort()).toEqual(['b']);
    expect(next.deleted.size).toBe(0);
  });

  it('does not mutate the input sets', () => {
    const dirty = new Set<string>();
    const deleted = new Set(['a']);
    reconcileRestore(map(), map({ id: 'a', x: 0 }), dirty, deleted);
    expect(deleted.has('a')).toBe(true); // original untouched
    expect(dirty.size).toBe(0);
  });
});
