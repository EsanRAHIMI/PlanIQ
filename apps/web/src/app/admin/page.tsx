'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, loadToken, formatApiError } from '@/lib/api';
import { toast } from '@/lib/toast';
import { AppHeader } from '@/components/AppHeader';
import {
  AiSettings, AI_SETTINGS_BOUNDS, FALLBACK_PROVIDERS,
} from '@planiq/shared';

type Me = { id: string; email: string; name: string; globalRole: string; tenantId: string };

const TABS = ['Overview', 'Jobs & Errors', 'AI Settings', 'Users', 'Tenants', 'Audit'] as const;
type Tab = (typeof TABS)[number];

export default function AdminPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [denied, setDenied] = useState(false);
  const [tab, setTab] = useState<Tab>('Overview');

  useEffect(() => {
    if (!loadToken()) { router.push('/login'); return; }
    api.get<Me>('/auth/me')
      .then((u) => {
        if (u.globalRole === 'admin' || u.globalRole === 'superadmin') setMe(u);
        else setDenied(true);
      })
      .catch(() => { /* handled globally */ });
  }, [router]);

  if (denied) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-24 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Admin access required</h1>
        <p className="mt-2 text-sm text-slate-500">Your account doesn’t have the admin role.</p>
        <Link href="/dashboard" className="btn-primary mt-6 inline-block">Back to projects</Link>
      </main>
    );
  }
  if (!me) return <main className="p-10 text-slate-500">Loading…</main>;

  const isSuper = me.globalRole === 'superadmin';
  const visibleTabs = TABS.filter((t) => t !== 'Tenants' || isSuper);

  return (
    <>
      <AppHeader breadcrumbs={[{ label: 'Admin' }]} />
      <main className="mx-auto max-w-6xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Admin Control Center</h1>
        <p className="text-sm text-slate-500">
          {me.name} · <span className="capitalize">{me.globalRole}</span>{isSuper ? ' · all tenants' : ' · your tenant'}
        </p>
      </header>

      <nav className="mt-6 flex flex-wrap gap-1 border-b border-slate-200">
        {visibleTabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${tab === t ? 'border-brand font-semibold text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >{t}</button>
        ))}
      </nav>

      <div className="py-6">
        {tab === 'Overview' && <OverviewTab />}
        {tab === 'Jobs & Errors' && <JobsTab isSuper={isSuper} />}
        {tab === 'AI Settings' && <AiSettingsTab />}
        {tab === 'Users' && <UsersTab meId={me.id} />}
        {tab === 'Tenants' && isSuper && <TenantsTab />}
        {tab === 'Audit' && <AuditTab />}
      </div>
      </main>
    </>
  );
}

/* ─────────────────────────── Overview ─────────────────────────── */
function OverviewTab() {
  const [health, setHealth] = useState<any>(null);
  const [data, setData] = useState<any>(null);

  const load = useCallback(() => {
    api.get('/admin/health').then(setHealth).catch(() => {});
    api.get('/admin/overview').then(setData).catch((e) => toast.error(formatApiError(e, 'Overview')));
  }, []);
  useEffect(() => { load(); const i = setInterval(load, 15000); return () => clearInterval(i); }, [load]);

  const SERVICES: { key: string; label: string }[] = [
    { key: 'mongo', label: 'MongoDB' }, { key: 'redis', label: 'Redis' }, { key: 'ai', label: 'AI Service' },
    { key: 's3', label: 'S3 / Storage' }, { key: 'worker', label: 'Worker' },
  ];

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>System health{health && <StatusPill ok={health.status === 'healthy'} text={health.status} />}</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {SERVICES.map((s) => {
            const ok = health?.services?.[s.key];
            return (
              <div key={s.key} className="card flex items-center justify-between p-3">
                <span className="text-sm text-slate-600">{s.label}</span>
                <span className={`h-2.5 w-2.5 rounded-full ${health == null ? 'bg-slate-300' : ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
              </div>
            );
          })}
        </div>
        {health?.worker?.lastBeatMs != null && (
          <p className="mt-2 text-xs text-slate-400">Worker last heartbeat {Math.round(health.worker.lastBeatMs / 1000)}s ago</p>
        )}
      </section>

      {data && (
        <>
          <section>
            <SectionTitle>Usage</SectionTitle>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              <Kpi label="Tenants" value={data.kpis.tenants} />
              <Kpi label="Users" value={data.kpis.users} />
              <Kpi label="Projects" value={data.kpis.projects} />
              <Kpi label="Floors" value={data.kpis.floors} />
              <Kpi label="Uploads" value={data.kpis.uploads} />
              <Kpi label="Exports" value={data.kpis.exports} />
              <Kpi label="Devices" value={data.kpis.placements} />
              <Kpi label="Manual" value={data.kpis.manualPlacements} />
            </div>
          </section>

          <section>
            <SectionTitle>AI suggestions — accepted vs rejected</SectionTitle>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi label="Suggested" value={data.ai.suggested} />
              <Kpi label="Accepted" value={data.ai.accepted} accent="emerald" />
              <Kpi label="Rejected" value={data.ai.rejected} accent="red" />
              <Kpi label="Acceptance" value={data.ai.acceptanceRatio == null ? '—' : `${Math.round(data.ai.acceptanceRatio * 100)}%`} accent="sky" />
            </div>
            <Ratio accepted={data.ai.accepted} rejected={data.ai.rejected} />
            <p className="mt-2 text-xs text-slate-400">
              Training/feedback loop: acceptance ratio is the live signal. A labelled-sample registry for retraining is planned (not yet collected).
            </p>
          </section>

          <section>
            <SectionTitle>Queues</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <QueueCard name="analysis" counts={data.jobs.analysis} />
              <QueueCard name="export" counts={data.jobs.export} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function QueueCard({ name, counts }: { name: string; counts: any }) {
  const fields = ['active', 'waiting', 'delayed', 'completed', 'failed'];
  return (
    <div className="card p-4">
      <div className="mb-2 text-sm font-semibold capitalize text-slate-800">{name} queue</div>
      <div className="grid grid-cols-5 gap-2 text-center">
        {fields.map((f) => (
          <div key={f}>
            <div className={`text-lg font-semibold ${f === 'failed' && counts?.[f] ? 'text-red-600' : 'text-slate-900'}`}>{counts?.[f] ?? 0}</div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">{f}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── Jobs & Errors ─────────────────────────── */
function JobsTab({ isSuper }: { isSuper: boolean }) {
  const [queue, setQueue] = useState<'analysis' | 'export'>('analysis');
  const [jobs, setJobs] = useState<any[]>([]);
  const [errors, setErrors] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get<any[]>(`/admin/jobs?queue=${queue}`).then(setJobs),
      api.get('/admin/errors').then(setErrors),
    ]).catch((e) => toast.error(formatApiError(e, 'Jobs'))).finally(() => setLoading(false));
  }, [queue]);
  useEffect(() => { load(); }, [load]);

  const retry = async (j: any) => {
    try { await api.post(`/admin/jobs/${j.queue}/${j.id}/retry`); toast.success(`Retrying job ${j.id}`); load(); }
    catch (e) { toast.error(formatApiError(e, 'Retry job')); }
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <SectionTitle>Queue jobs</SectionTitle>
          <div className="flex gap-2">
            <select className="input py-1 text-sm" value={queue} onChange={(e) => setQueue(e.target.value as any)}>
              <option value="analysis">analysis</option>
              <option value="export">export</option>
            </select>
            <button className="btn-ghost text-sm" onClick={load}>Refresh</button>
          </div>
        </div>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr><th className="p-2">Job</th><th className="p-2">State</th><th className="p-2">Target</th><th className="p-2">Attempts</th><th className="p-2">Reason</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={`${j.queue}-${j.id}`} className="border-t border-slate-100">
                  <td className="p-2 font-mono text-xs">{j.name} #{j.id}</td>
                  <td className="p-2"><JobState state={j.state} /></td>
                  <td className="p-2 text-xs text-slate-500">{j.floorId ? `floor ${short(j.floorId)}` : j.exportId ? `export ${short(j.exportId)}` : j.projectId ? `proj ${short(j.projectId)}` : '—'}</td>
                  <td className="p-2 text-xs">{j.attemptsMade ?? 0}</td>
                  <td className="p-2 max-w-[220px] truncate text-xs text-red-500" title={j.failedReason ?? ''}>{j.failedReason ?? ''}</td>
                  <td className="p-2 text-right">{j.state === 'failed' && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => retry(j)}>Retry</button>}</td>
                </tr>
              ))}
              {!loading && !jobs.length && <tr><td colSpan={6} className="p-4 text-center text-slate-400">No jobs in this queue.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <SectionTitle>Recent failures</SectionTitle>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ErrorList title="Failed analyses" items={errors?.analysis} render={(e: any) => `${e.name}: ${e.error ?? 'unknown error'}`} />
          <ErrorList title="Failed exports" items={errors?.exports} render={(e: any) => `${short(e.projectId)}: ${e.error ?? 'unknown error'}`} />
        </div>
      </section>
    </div>
  );
}

function ErrorList({ title, items, render }: { title: string; items?: any[]; render: (x: any) => string }) {
  return (
    <div className="card p-4">
      <div className="mb-2 text-sm font-semibold text-slate-800">{title}</div>
      {!items?.length ? <p className="text-sm text-slate-400">None 🎉</p> : (
        <ul className="space-y-1">
          {items.map((e) => (
            <li key={e.id} className="text-xs text-slate-600">
              <span className="text-slate-400">{e.at ? new Date(e.at).toLocaleString() : ''}</span> — {render(e)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─────────────────────────── AI Settings ─────────────────────────── */
function AiSettingsTab() {
  const [s, setS] = useState<AiSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.get<AiSettings>('/admin/ai-settings').then(setS).catch((e) => toast.error(formatApiError(e, 'AI settings'))); }, []);
  if (!s) return <p className="text-slate-400">Loading…</p>;

  const NUMS: { key: keyof AiSettings; label: string; step?: number }[] = [
    { key: 'maxRoomsPerFloor', label: 'Max rooms per floor', step: 1 },
    { key: 'maxDevicesPerFloor', label: 'Max devices per floor', step: 1 },
    { key: 'maxDevicesPerRoom', label: 'Max devices per room', step: 1 },
    { key: 'minRoomConfidence', label: 'Min room confidence', step: 0.01 },
    { key: 'minDeviceConfidence', label: 'Min device confidence', step: 0.01 },
  ];

  const save = async () => {
    setSaving(true);
    try { const next = await api.patch<AiSettings>('/admin/ai-settings', s); setS(next); toast.success('AI settings saved · applies to new analyses'); }
    catch (e) { toast.error(formatApiError(e, 'Save AI settings')); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">
        These quality-control limits are forwarded to the AI pipeline on the next analysis / re-run — they directly change how many devices are suggested and which are rejected.
      </div>

      <div className="card p-4">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-500">Vision-LLM fallback provider</span>
          <select className="input" value={s.fallbackProvider} onChange={(e) => setS({ ...s, fallbackProvider: e.target.value as any })}>
            {FALLBACK_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <span className="mt-1 block text-xs text-slate-400">Default “disabled” keeps the self-hosted CV pipeline as the only engine. Other providers require server API keys.</span>
        </label>
      </div>

      <div className="card grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
        {NUMS.map(({ key, label, step }) => {
          const [min, max] = (AI_SETTINGS_BOUNDS as any)[key];
          return (
            <label key={key} className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">{label}</span>
              <input
                className="input" type="number" step={step} min={min} max={max}
                value={s[key] as number}
                onChange={(e) => setS({ ...s, [key]: Number(e.target.value) })}
              />
              <span className="mt-1 block text-[11px] text-slate-400">range {min}–{max}</span>
            </label>
          );
        })}
      </div>

      <div className="flex gap-2">
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save AI settings'}</button>
        <button className="btn-ghost" onClick={() => api.get<AiSettings>('/admin/ai-settings').then(setS)}>Reset</button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Users ─────────────────────────── */
function UsersTab({ meId }: { meId: string }) {
  const [users, setUsers] = useState<any[]>([]);
  const load = useCallback(() => { api.get<any[]>('/admin/users').then(setUsers).catch((e) => toast.error(formatApiError(e, 'Users'))); }, []);
  useEffect(() => { load(); }, [load]);

  const ROLES = ['viewer', 'editor', 'manager', 'admin'];
  const patch = async (id: string, body: any) => {
    try { await api.patch(`/admin/users/${id}`, body); toast.success('User updated'); load(); }
    catch (e) { toast.error(formatApiError(e, 'Update user')); }
  };

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr><th className="p-2">User</th><th className="p-2">Role</th><th className="p-2">Status</th><th className="p-2">Last login</th><th className="p-2 text-right">Actions</th></tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const self = u._id === meId;
            return (
              <tr key={u._id} className="border-t border-slate-100">
                <td className="p-2"><div className="font-medium text-slate-800">{u.name}</div><div className="text-xs text-slate-400">{u.email}</div></td>
                <td className="p-2">
                  <select className="input py-1 text-xs" value={u.globalRole} disabled={self}
                    onChange={(e) => patch(u._id, { globalRole: e.target.value })}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    {u.globalRole === 'superadmin' && <option value="superadmin">superadmin</option>}
                  </select>
                </td>
                <td className="p-2"><StatusPill ok={u.status === 'active'} text={u.status} /></td>
                <td className="p-2 text-xs text-slate-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : '—'}</td>
                <td className="p-2 text-right">
                  {self ? <span className="text-xs text-slate-400">You</span> : (
                    <button className="btn-ghost px-2 py-1 text-xs"
                      onClick={() => patch(u._id, { status: u.status === 'active' ? 'suspended' : 'active' })}>
                      {u.status === 'active' ? 'Suspend' : 'Activate'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {!users.length && <tr><td colSpan={5} className="p-4 text-center text-slate-400">No users.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────── Tenants ─────────────────────────── */
function TenantsTab() {
  const [tenants, setTenants] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>('/admin/tenants').then(setTenants).catch((e) => toast.error(formatApiError(e, 'Tenants'))); }, []);
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr><th className="p-2">Tenant</th><th className="p-2">Plan</th><th className="p-2">Users</th><th className="p-2">Projects</th></tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t._id} className="border-t border-slate-100">
              <td className="p-2"><div className="font-medium text-slate-800">{t.name}</div><div className="text-xs text-slate-400">{t.slug}</div></td>
              <td className="p-2"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize">{t.plan}</span></td>
              <td className="p-2">{t.counts?.users ?? 0}</td>
              <td className="p-2">{t.counts?.projects ?? 0}</td>
            </tr>
          ))}
          {!tenants.length && <tr><td colSpan={4} className="p-4 text-center text-slate-400">No tenants.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────── Audit ─────────────────────────── */
function AuditTab() {
  const [logs, setLogs] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>('/admin/audit-logs').then(setLogs).catch((e) => toast.error(formatApiError(e, 'Audit log'))); }, []);
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr><th className="p-2">When</th><th className="p-2">Action</th><th className="p-2">Target</th><th className="p-2">Actor</th></tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l._id} className="border-t border-slate-100">
              <td className="p-2 text-xs text-slate-500">{l.at ? new Date(l.at).toLocaleString() : ''}</td>
              <td className="p-2"><span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{l.action}</span></td>
              <td className="p-2 text-xs text-slate-500">{l.target?.type ? `${l.target.type} ${short(l.target.id)}` : '—'}</td>
              <td className="p-2 text-xs text-slate-400">{short(l.actorId)}</td>
            </tr>
          ))}
          {!logs.length && <tr><td colSpan={4} className="p-4 text-center text-slate-400">No audit entries yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────── Shared bits ─────────────────────────── */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">{children}</h2>;
}
function Kpi({ label, value, accent }: { label: string; value: any; accent?: 'emerald' | 'red' | 'sky' }) {
  const color = accent === 'emerald' ? 'text-emerald-700' : accent === 'red' ? 'text-red-600' : accent === 'sky' ? 'text-sky-700' : 'text-slate-900';
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}
function StatusPill({ ok, text }: { ok: boolean; text: string }) {
  return <span className={`rounded-full border px-2 py-0.5 text-xs capitalize ${ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>{text}</span>;
}
function JobState({ state }: { state: string }) {
  const map: Record<string, string> = {
    active: 'bg-sky-50 text-sky-700 border-sky-200', completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    failed: 'bg-red-50 text-red-700 border-red-200', waiting: 'bg-slate-50 text-slate-600 border-slate-200',
    delayed: 'bg-amber-50 text-amber-700 border-amber-200',
  };
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${map[state] ?? map.waiting}`}>{state}</span>;
}
function Ratio({ accepted, rejected }: { accepted: number; rejected: number }) {
  const total = accepted + rejected;
  const pct = total > 0 ? (accepted / total) * 100 : 0;
  return (
    <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-red-200">
      <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
    </div>
  );
}
function short(id?: string) { return id ? String(id).slice(-6) : '—'; }
