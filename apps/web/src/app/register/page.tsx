'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, setToken } from '@/lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ tenantName: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      const r = await api.post<{ accessToken: string }>('/auth/register', form);
      setToken(r.accessToken);
      router.push('/dashboard');
    } catch (err: any) { setError(err.detail?.details?.[0]?.issue ?? err.message ?? 'Registration failed'); } finally { setLoading(false); }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="text-sm font-bold tracking-widest text-brand">PLANIQ</div>
      <h1 className="mt-2 text-2xl font-bold">Create your workspace</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <input className="input" placeholder="Company / workspace name" value={form.tenantName} onChange={set('tenantName')} />
        <input className="input" placeholder="Your name" value={form.name} onChange={set('name')} />
        <input className="input" type="email" placeholder="Email" value={form.email} onChange={set('email')} />
        <input className="input" type="password" placeholder="Password (min 8 chars)" value={form.password} onChange={set('password')} />
        {error && <p className="text-sm text-brand">{error}</p>}
        <button className="btn-primary w-full" disabled={loading}>{loading ? 'Creating…' : 'Create account'}</button>
      </form>
      <p className="mt-4 text-sm text-slate-600">Have an account? <Link href="/login" className="text-brand">Sign in</Link></p>
    </main>
  );
}
