'use client';
import { useEditor } from '@/features/editor/store';
import { LogoutButton } from '@/components/LogoutButton';

export function Toolbar({ floorName, saving, suggesting, onSuggest, onSnapshot }: {
  floorName: string; saving: boolean; suggesting?: boolean; onSuggest: () => void; onSnapshot: () => void;
}) {
  const { undo, redo, duplicateSelected, deleteSelected, rotateSelected, toggleLock, toggleHide, groupSelected, selectedIds } = useEditor();
  const has = selectedIds.length > 0;
  const Btn = ({ onClick, children, disabled }: any) => (
    <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={onClick} disabled={disabled}>{children}</button>
  );
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
      <span className="text-sm font-semibold">{floorName}</span>
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
        <Btn onClick={onSnapshot}>Save version</Btn>
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
