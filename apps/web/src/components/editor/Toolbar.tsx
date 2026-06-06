'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useEditor } from '@/features/editor/store';
import { LogoutButton } from '@/components/LogoutButton';
import { fetchMe, isAdminRole } from '@/lib/api';

interface FloorOption { _id: string; name: string }

export function Toolbar({
  floorName, saving, onVersions, floors, currentFloorId, onSelectFloor, projectHref,
}: {
  floorName: string; saving: boolean;
  onVersions: () => void;
  floors?: FloorOption[]; currentFloorId?: string; onSelectFloor?: (id: string) => void;
  projectHref?: string;
}) {
  const { undo, redo, duplicateSelected, deleteSelected, rotateSelected, toggleLock, toggleHide, selectedIds, past, future } = useEditor();
  const [showAdmin, setShowAdmin] = useState(false);
  useEffect(() => { fetchMe().then((u) => setShowAdmin(isAdminRole(u?.globalRole))); }, []);
  const has = selectedIds.length > 0;
  const Btn = ({ onClick, children, disabled, title }: any) => (
    <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={onClick} disabled={disabled} title={title}>{children}</button>
  );
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
      <Link href="/dashboard" className="grid h-7 w-7 place-items-center rounded-md bg-brand text-xs font-extrabold text-white" title="PlanIQ — home" aria-label="PlanIQ home">P</Link>
      {projectHref && <Link href={projectHref} className="text-xs text-slate-400 transition hover:text-slate-600" title="Back to project">Project ›</Link>}
      <div className="mx-1 h-5 w-px bg-slate-200" />
      {floors && floors.length > 1 ? (
        <select
          className="input max-w-[200px] py-1 text-sm font-semibold"
          value={currentFloorId ?? ''}
          onChange={(e) => onSelectFloor?.(e.target.value)}
          title="Switch floor"
        >
          {floors.map((f) => <option key={f._id} value={f._id}>{f.name}</option>)}
        </select>
      ) : (
        <span className="text-sm font-semibold">{floorName}</span>
      )}
      <span className="text-xs text-slate-400">{saving ? 'Saving…' : 'Saved'}</span>
      <div className="mx-2 h-5 w-px bg-slate-200" />
      <Btn onClick={undo} disabled={past.length === 0} title="Undo (Ctrl/Cmd+Z)">↶ Undo</Btn>
      <Btn onClick={redo} disabled={future.length === 0} title="Redo (Ctrl/Cmd+Shift+Z)">↷ Redo</Btn>
      <div className="mx-2 h-5 w-px bg-slate-200" />
      <Btn onClick={duplicateSelected} disabled={!has} title="Duplicate (Ctrl/Cmd+D)">Duplicate</Btn>
      <Btn onClick={() => rotateSelected(15)} disabled={!has} title="Rotate 15°">Rotate</Btn>
      <Btn onClick={toggleLock} disabled={!has} title="Lock / unlock selection">Lock</Btn>
      <Btn onClick={toggleHide} disabled={!has} title="Hide selection (use the “All” canvas toggle to see and unhide hidden devices)">Hide</Btn>
      {/* Grouping is not production-ready (no multi-select propagation / ungroup yet) — disabled
          rather than shipped half-working, per the reliability phase. */}
      <Btn disabled title="Grouping isn’t available yet">Group</Btn>
      <Btn onClick={deleteSelected} disabled={!has} title="Delete selection (Del)">Delete</Btn>
      <div className="ml-auto flex gap-2">
        {showAdmin && (
          <Link href="/admin" className="btn-ghost px-2.5 py-1.5 text-xs" title="Admin Control Center">
            Admin
          </Link>
        )}
        <LogoutButton className="btn-ghost px-2.5 py-1.5 text-xs" />
        <Btn onClick={onVersions}>Versions</Btn>
      </div>
    </div>
  );
}
