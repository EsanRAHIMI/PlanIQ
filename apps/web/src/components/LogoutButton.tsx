'use client';

import { logout } from '@/lib/api';

export function LogoutButton({ className = 'btn-ghost text-sm' }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => void logout()}
    >
      Log out
    </button>
  );
}
