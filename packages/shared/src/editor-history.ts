/**
 * Pure persistence-set reconciliation for the editor's undo/redo history.
 *
 * The editor tracks two sets that drive its debounced autosave:
 *   - `dirty`   — placement ids to upsert on the server
 *   - `deleted` — placement ids to delete on the server
 *
 * When the user undoes/redoes, the placement map is replaced wholesale with a
 * snapshot. The persistence sets must be reconciled against that change,
 * otherwise two bugs appear:
 *
 *   1. Data loss: deleting a device then undoing leaves the id in `deleted`.
 *      The restored device is in state but the next autosave still deletes it
 *      server-side (batch upserts then deletes — the delete wins), so it
 *      silently vanishes on reload.
 *   2. Dirty flooding: marking every restored id dirty forces a full re-upsert
 *      of the floor on every undo.
 *
 * `reconcileRestore` diffs the current map against the restored map and returns
 * fresh sets that mark only genuinely changed ids dirty, cancel pending deletes
 * for ids that came back, and schedule deletes for ids the restore removed.
 *
 * It is framework-free (no zustand/immer) so it can be unit-tested directly.
 */
export interface PersistenceSets {
  dirty: Set<string>;
  deleted: Set<string>;
}

export function reconcileRestore<T>(
  current: Record<string, T>,
  restored: Record<string, T>,
  dirty: Set<string>,
  deleted: Set<string>,
): PersistenceSets {
  const nextDirty = new Set(dirty);
  const nextDeleted = new Set(deleted);

  const currentIds = Object.keys(current);
  const restoredIds = Object.keys(restored);
  const restoredSet = new Set(restoredIds);

  // Ids present now but absent in the restored snapshot → the restore removed
  // them. Schedule a server delete and drop any pending upsert.
  for (const id of currentIds) {
    if (!restoredSet.has(id)) {
      nextDeleted.add(id);
      nextDirty.delete(id);
    }
  }

  // Ids present in the restored snapshot exist again → cancel any pending
  // delete, and mark dirty only if new or actually changed.
  for (const id of restoredIds) {
    nextDeleted.delete(id);
    const before = current[id];
    if (before === undefined || !shallowJsonEqual(before, restored[id])) {
      nextDirty.add(id);
    }
  }

  return { dirty: nextDirty, deleted: nextDeleted };
}

/** Structural equality good enough for plain JSON placement objects. */
function shallowJsonEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
