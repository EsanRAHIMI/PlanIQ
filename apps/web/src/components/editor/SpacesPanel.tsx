'use client';
import { useMemo, useState } from 'react';
import { ROOM_TYPES } from '@planiq/shared';
import { useEditor, type RoomDoc } from '@/features/editor/store';
import { api, formatApiError } from '@/lib/api';
import { toast } from '@/lib/toast';

const TYPE_LABEL: Record<string, string> = {
  bedroom: 'Bedroom', master_bedroom: 'Master Bedroom', maid_room: 'Maid Room', majlis: 'Majlis',
  living_room: 'Living Room', sitting_area: 'Sitting Area', dining: 'Dining', dressing: 'Dressing',
  kitchen: 'Kitchen', pantry: 'Pantry', laundry: 'Laundry', bathroom: 'Bathroom',
  store: 'Store', store_indoor: 'Store (indoor)', store_outdoor: 'Store (outdoor)',
  service_area: 'Service Area', electrical_room: 'Electrical / DB Room',
  corridor: 'Corridor', staircase: 'Staircase', lift: 'Lift',
  entrance: 'Entrance', main_entrance: 'Main Entrance', guest_entrance: 'Guest Entrance',
  service_entrance: 'Service Entrance', main_door: 'Main Door',
  outdoor: 'Outdoor', garden: 'Garden', parking: 'Parking', gate: 'Gate',
  pool: 'Pool', bbq: 'BBQ', outdoor_seating: 'Outdoor Seating', roof: 'Roof',
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  ai_detected:    { label: 'AI detected',    cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  accepted:       { label: 'Accepted',       cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  user_corrected: { label: 'User corrected', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  rejected:       { label: 'Rejected',       cls: 'bg-red-50 text-red-600 border-red-200' },
};

const roomId = (r: RoomDoc) => String(r._id ?? r.id ?? '');
const isActive = (r: RoomDoc) => r.reviewStatus !== 'rejected';

/**
 * Left-side review surface for detected spaces. Makes the AI's spatial understanding
 * visible and correctable BEFORE devices are placed. Edits persist via the rooms API
 * and update the canvas optimistically; re-suggest runs the rule engine on the
 * corrected (non-rejected) spaces.
 */
export function SpacesPanel({
  floorId,
  onResuggest,
  resuggestBusy,
}: {
  floorId: string;
  onResuggest: () => void;
  resuggestBusy: boolean;
}) {
  const rooms = useEditor((s) => s.rooms);
  const selectedRoomId = useEditor((s) => s.selectedRoomId);
  const { selectRoom, patchRoomLocal, removeRoomLocal, upsertRoomLocal } = useEditor();
  const [addType, setAddType] = useState<string>('bedroom');
  const [busyId, setBusyId] = useState<string | null>(null);

  const { active, rejected } = useMemo(() => ({
    active: rooms.filter(isActive),
    rejected: rooms.filter((r) => !isActive(r)),
  }), [rooms]);

  async function patch(id: string, body: Record<string, unknown>, optimistic: Partial<RoomDoc>) {
    setBusyId(id);
    patchRoomLocal(id, optimistic); // optimistic
    try {
      const updated = await api.patch<RoomDoc>(`/rooms/${id}`, body);
      if (updated) upsertRoomLocal({ ...updated, id: roomId(updated) || id });
    } catch (err) {
      toast.error(formatApiError(err, 'Update space'));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    setBusyId(id);
    try {
      await api.del(`/rooms/${id}`);
      removeRoomLocal(id);
    } catch (err) {
      toast.error(formatApiError(err, 'Delete space'));
    } finally {
      setBusyId(null);
    }
  }

  async function addSpace() {
    try {
      const created = await api.post<RoomDoc>(`/floors/${floorId}/rooms`, { type: addType });
      upsertRoomLocal({ ...created, id: roomId(created) });
      selectRoom(roomId(created));
      toast.success(`Added ${TYPE_LABEL[addType] ?? addType}. Drag it onto the room on the plan.`);
    } catch (err) {
      toast.error(formatApiError(err, 'Add space'));
    }
  }

  const Row = ({ r }: { r: RoomDoc }) => {
    const id = roomId(r);
    const badge = STATUS_BADGE[r.reviewStatus ?? 'ai_detected'] ?? STATUS_BADGE.ai_detected;
    const selected = selectedRoomId === id;
    const corrected = r.reviewStatus === 'user_corrected' && r.aiType && r.aiType !== r.type;
    const busy = busyId === id;
    return (
      <div
        onClick={() => selectRoom(id)}
        className={`cursor-pointer rounded-lg border p-2 text-xs transition ${
          selected ? 'border-slate-900 bg-slate-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
        } ${!isActive(r) ? 'opacity-70' : ''}`}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
          <span className="text-[10px] text-slate-400">
            {r.source === 'manual' ? 'manual' : r.confidence != null ? `${Math.round(r.confidence * 100)}% conf` : ''}
          </span>
        </div>

        <select
          className="input mb-1.5 w-full py-1 text-xs"
          value={r.type}
          disabled={busy}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => patch(id, { type: e.target.value }, { type: e.target.value, reviewStatus: 'user_corrected' })}
        >
          {ROOM_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}
        </select>

        {corrected && (
          <p className="mb-1 text-[10px] text-amber-600">Was AI: {TYPE_LABEL[r.aiType as string] ?? r.aiType}</p>
        )}
        {r.reviewStatus === 'rejected' && r.rejectionReason && (
          <p className="mb-1 text-[10px] text-red-500">QC: {r.rejectionReason}</p>
        )}

        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          {isActive(r) ? (
            <button disabled={busy} onClick={() => patch(id, { reviewStatus: 'rejected' }, { reviewStatus: 'rejected' })}
              className="rounded border border-red-200 px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-50">Reject</button>
          ) : (
            <button disabled={busy} onClick={() => patch(id, { reviewStatus: 'accepted' }, { reviewStatus: 'accepted', rejectionReason: null })}
              className="rounded border border-emerald-200 px-1.5 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-50">Accept</button>
          )}
          {isActive(r) && r.reviewStatus !== 'accepted' && (
            <button disabled={busy} onClick={() => patch(id, { reviewStatus: 'accepted' }, { reviewStatus: 'accepted' })}
              className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50">Confirm</button>
          )}
          <button disabled={busy} onClick={() => remove(id)}
            className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50">Delete</button>
        </div>

        <label className="mt-1.5 flex cursor-pointer items-center gap-1 text-[10px] text-slate-500" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="rounded"
            disabled={busy}
            checked={Boolean(r.meta?.doubleHeight)}
            onChange={(e) => patch(id, { doubleHeight: e.target.checked }, { meta: { ...(r.meta ?? {}), doubleHeight: e.target.checked } })}
          />
          Double-height (move ceiling Wi-Fi / speakers out)
        </label>
      </div>
    );
  };

  return (
    <aside className="flex w-72 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 p-3">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Detected Spaces</h2>
          <span className="text-[11px] text-slate-400">{active.length} active · {rejected.length} rejected</span>
        </div>
        <p className="text-[11px] leading-snug text-slate-500">
          Review what the AI understood. Fix the type, accept or reject a space, or add one it missed — then
          re-suggest devices from the corrected spaces.
        </p>
        <div className="mt-2 flex gap-1">
          <select className="input flex-1 py-1 text-xs" value={addType} onChange={(e) => setAddType(e.target.value)}>
            {ROOM_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}
          </select>
          <button onClick={addSpace} className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
            + Add
          </button>
        </div>
        <button
          onClick={onResuggest}
          disabled={resuggestBusy || active.length === 0}
          className="mt-2 w-full rounded-lg bg-slate-900 px-2 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {resuggestBusy ? 'Re-suggesting…' : 'Re-suggest devices from spaces'}
        </button>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
        {rooms.length === 0 && (
          <p className="text-xs text-slate-400">
            No spaces yet. Run <strong>Full AI Analysis</strong> to detect spaces, or add one manually above.
          </p>
        )}
        {active.map((r) => <Row key={roomId(r)} r={r} />)}
        {rejected.length > 0 && (
          <div className="pt-2">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Rejected by QC</p>
            {rejected.map((r) => <Row key={roomId(r)} r={r} />)}
          </div>
        )}
      </div>
    </aside>
  );
}
