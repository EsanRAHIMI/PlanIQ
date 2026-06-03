'use client';
import Link from 'next/link';
import { useEditor } from '@/features/editor/store';
import { LogoutButton } from '@/components/LogoutButton';

interface FloorOption { _id: string; name: string }

export function Toolbar({
  floorName, saving, suggesting, onSuggest, onVersions, floors, currentFloorId, onSelectFloor, projectHref,
}: {
  floorName: string; saving: boolean; suggesting?: boolean;
  onSuggest: () => void; onVersions: () => void;
  floors?: FloorOption[]; currentFloorId?: string; onSelectFloor?: (id: string) => void;
  projectHref?: string;
}) {
  const { undo, redo, duplicateSelected, deleteSelected, rotateSelected, toggleLock, toggleHide, groupSelected, selectedIds } = useEditor();
  const has = selectedIds.length > 0;
  const Btn = ({ onClick, children, disabled }: any) => (
    <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={onClick} disabled={disabled}>{children}</button>
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
      <Btn onClick={undo}>↶ Undo</Btn>
      <Btn onClick={redo}>↷ Redo</Btn>
      <div className="mx-2 h-5 w-px bg-slate-200" />
      <Btn onClick={duplicateSelected} disabled={!has}>Duplicate</Btn>
      <Btn onClick={() => rotateSelected(15)} disabled={!has}>Rotate</Btn>
      <Btn onClick={toggleLock} disabled={!has}>Lock</Btn>
      <Btn onClick={toggleHide} disabled={!has}>Hide</Btn>
      <Btn onClick={groupSelected} disabled={selectedIds.length < 2}>Group</Btn>
      <Btn onClick={deleteSelected} disabled={!has}>Delete</Btn>
      <div className="ml-auto flex gap-2">
        <LogoutButton className="btn-ghost px-2.5 py-1.5 text-xs" />
        <Btn onClick={onVersions}>Versions</Btn>
        <button
          className="btn-primary px-3 py-1.5 text-xs"
          onClick={onSuggest}
          disabled={suggesting}
        >
          {suggesting ? 'Suggesting…' : 'Re-run AI suggestions'}
        </button>
      </div>
    </div>
  );
}
