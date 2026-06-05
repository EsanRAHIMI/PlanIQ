import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-20">
      <div className="text-sm font-bold tracking-widest text-brand">PLANIQ</div>
      <h1 className="mt-3 text-5xl font-bold leading-tight">Automatic device placement<br />on villa floor plans.</h1>
      <p className="mt-5 max-w-2xl text-lg text-slate-600">
        Upload a plan. PlanIQ analyzes every floor with a self-hosted computer-vision pipeline (OpenCV geometry + OCR),
        suggests engineering-correct CCTV, Wi-Fi, ELV and smart-home placements, and lets you edit everything
        on a fast canvas — then export a client-ready PDF.
      </p>
      <div className="mt-8 flex gap-3">
        <Link href="/register" className="btn-primary">Get started</Link>
        <Link href="/login" className="btn-ghost">Sign in</Link>
      </div>
      <div className="mt-16 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          ['Detect spaces', 'Rooms, gates, parking & entrances via OpenCV + OCR.'],
          ['Suggest devices', 'Deterministic rule engine — always reviewable.'],
          ['Edit & export', 'Figma-lite canvas, versioning, professional PDF.'],
        ].map(([t, d]) => (
          <div key={t} className="card p-5"><div className="font-semibold">{t}</div><div className="mt-1 text-sm text-slate-600">{d}</div></div>
        ))}
      </div>
    </main>
  );
}
