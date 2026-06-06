'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, loadToken, ApiError } from '@/lib/api';
import { AppHeader } from '@/components/AppHeader';
import { StatusPill } from '@/components/StatusPill';
import { projectCardAttention } from '@/lib/readiness';

export default function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState('');

  async function refresh() {
    try {
      const r = await api.get<{ items: any[] }>('/projects');
      setProjects(r.items);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      if (!loadToken()) router.push('/login');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!loadToken()) { router.push('/login'); return; }
    refresh();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault(); if (!name.trim()) return;
    setCreateError('');
    try {
      const p = await api.post<any>('/projects', { name: name.trim(), units: 'm' });
      setName(''); setCreating(false);
      router.push(`/projects/${p._id}`);
    } catch (err: any) {
      const details = err?.details ?? err?.detail?.details;
      if (Array.isArray(details) && details.length > 0) {
        const first = details[0];
        const msg = first?.issue || first?.message || first?.path?.join?.('.') || 'Validation failed';
        setCreateError(msg);
      } else {
        setCreateError(err?.message ?? 'Could not create project');
      }
    }
  }

  return (
    <>
      <AppHeader breadcrumbs={[{ label: 'Projects' }]} />
      <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Projects</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>New project</button>
      </div>

      {creating && (
        <form onSubmit={create} className="card mt-6 flex gap-3 p-4">
          <input autoFocus className="input" placeholder="Project name (e.g. Proposed Villa G+1)" value={name} onChange={(e) => setName(e.target.value)} />
          {createError && <p className="text-sm text-brand self-center">{createError}</p>}
          <button className="btn-primary">Create</button>
          <button type="button" className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
        </form>
      )}

      {loading ? <p className="mt-10 text-slate-500">Loading…</p> : (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link key={p._id} href={`/projects/${p._id}`} className="card p-5 transition hover:shadow-md">
              <div className="flex items-start justify-between">
                <div className="font-semibold">{p.name}</div>
                <StatusPill status={p.status} />
              </div>
              <div className="mt-1 text-sm text-slate-500">{p.code ?? '—'} · {p.client?.name ?? 'No client'}</div>
              <div className="mt-4 flex items-center gap-4 text-xs text-slate-500">
                <span>{p.stats?.floors ?? 0} floors</span><span>{p.stats?.devices ?? 0} devices</span>
                {projectCardAttention(p) && (
                  <span className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${projectCardAttention(p)!.tone === 'danger' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>● {projectCardAttention(p)!.label}</span>
                )}
              </div>
            </Link>
          ))}
          {!projects.length && (
            <div className="col-span-full">
              <div className="card p-10 text-center">
                <h3 className="text-base font-semibold text-slate-900">Welcome to PlanIQ</h3>
                <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
                  Create your first project, upload a villa plan, and PlanIQ analyzes each floor and suggests engineering-correct device placements you can review and deliver.
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5 text-xs text-slate-500">
                  {['Create project', 'Upload plan', 'Analyze', 'Review', 'Export PDF'].map((s, i) => (
                    <span key={s} className={`rounded-full px-2.5 py-1 ${i === 0 ? 'bg-slate-900 text-white' : 'bg-slate-100'}`}>{i + 1}. {s}</span>
                  ))}
                </div>
                <button className="btn-primary mt-6" onClick={() => setCreating(true)}>Create your first project</button>
              </div>
            </div>
          )}
        </div>
      )}
      </main>
    </>
  );
}
