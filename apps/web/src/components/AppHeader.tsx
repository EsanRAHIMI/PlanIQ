'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { api, loadToken, logout } from '@/lib/api';

export interface Crumb { label: string; href?: string }

interface Me { id: string; name: string; email: string; globalRole: string }

// Module-level cache so navigating between pages doesn't refetch the profile.
// Cleared naturally on logout (logout() does a full page navigation).
let mePromise: Promise<Me | null> | null = null;
function getMe(): Promise<Me | null> {
  if (!mePromise) {
    mePromise = loadToken()
      ? api.get<Me>('/auth/me').catch(() => null)
      : Promise.resolve(null);
  }
  return mePromise;
}

function initials(name?: string, email?: string) {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/** Global app header: brand, location-aware nav, breadcrumbs, and a user menu. */
export function AppHeader({ breadcrumbs }: { breadcrumbs?: Crumb[] }) {
  const pathname = usePathname() ?? '';
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { getMe().then(setMe); }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const isAdmin = me?.globalRole === 'admin' || me?.globalRole === 'superadmin';
  const inProjects = pathname === '/dashboard' || pathname.startsWith('/projects') || pathname.startsWith('/editor');
  const inAdmin = pathname.startsWith('/admin');

  const nav: { label: string; href: string; active: boolean }[] = [
    { label: 'Projects', href: '/dashboard', active: inProjects },
    ...(isAdmin ? [{ label: 'Admin', href: '/admin', active: inAdmin }] : []),
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-6">
        <Link href="/dashboard" className="flex items-center gap-2" aria-label="PlanIQ home">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-xs font-extrabold text-white">P</span>
          <span className="text-sm font-bold tracking-wide text-slate-900">PlanIQ</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex" aria-label="Primary">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={n.active ? 'page' : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${n.active ? 'bg-slate-100 font-semibold text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
            >{n.label}</Link>
          ))}
        </nav>

        <div className="relative ml-auto" ref={menuRef}>
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2 rounded-full border border-slate-200 py-1 pl-1 pr-2 transition hover:bg-slate-50"
            aria-haspopup="menu" aria-expanded={open}
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
              {me ? initials(me.name, me.email) : '··'}
            </span>
            <span className="hidden text-sm font-medium text-slate-700 sm:block">{me?.name ?? 'Account'}</span>
            <svg width="14" height="14" viewBox="0 0 20 20" className="text-slate-400" aria-hidden><path d="M5 7l5 5 5-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>

          {open && (
            <div role="menu" className="absolute right-0 mt-2 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="truncate text-sm font-semibold text-slate-900">{me?.name ?? 'Signed in'}</div>
                <div className="truncate text-xs text-slate-500">{me?.email ?? ''}</div>
                {me?.globalRole && (
                  <span className="mt-1.5 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium capitalize text-slate-600">{me.globalRole}</span>
                )}
              </div>
              <nav className="py-1 text-sm">
                <MenuLink href="/dashboard" onClick={() => setOpen(false)}>Projects</MenuLink>
                {isAdmin && <MenuLink href="/admin" onClick={() => setOpen(false)}>Admin Control Center</MenuLink>}
                <button
                  role="menuitem"
                  onClick={() => { setOpen(false); void logout(); }}
                  className="block w-full px-4 py-2 text-left text-red-600 transition hover:bg-red-50"
                >Sign out</button>
              </nav>
            </div>
          )}
        </div>
      </div>

      {breadcrumbs && breadcrumbs.length > 0 && (
        <div className="border-t border-slate-100 bg-white/60">
          <nav aria-label="Breadcrumb" className="mx-auto flex h-9 max-w-6xl items-center gap-1 px-6 text-xs">
            {breadcrumbs.map((c, i) => {
              const last = i === breadcrumbs.length - 1;
              return (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="h-3 w-3 text-slate-300" />}
                  {c.href && !last
                    ? <Link href={c.href} className="text-slate-500 transition hover:text-slate-800">{c.label}</Link>
                    : <span className={last ? 'font-medium text-slate-800' : 'text-slate-500'} aria-current={last ? 'page' : undefined}>{c.label}</span>}
                </span>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}

function MenuLink({ href, onClick, children }: { href: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link role="menuitem" href={href} onClick={onClick} className="block px-4 py-2 text-slate-700 transition hover:bg-slate-50">{children}</Link>
  );
}
