'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, setToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('demo@planiq.app');
  const [password, setPassword] = useState('Password123!');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      const r = await api.post<{ accessToken: string }>('/auth/login', { email, password });
      setToken(r.accessToken);
      router.push('/dashboard');
    } catch (err: any) { setError(err.message ?? 'Login failed'); } finally { setLoading(false); }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="text-sm font-bold tracking-widest text-brand">PLANIQ</div>
      <h1 className="mt-2 text-2xl font-bold">Sign in</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <input className="input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="text-sm text-brand">{error}</p>}
        <button className="btn-primary w-full" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="mt-4 text-sm text-slate-600">No account? <Link href="/register" className="text-brand">Create one</Link></p>
    </main>
  );
}
