/**
 * Customer-readiness scoring + attention derivation — computed entirely from the existing
 * delivery overview (GET /projects/:id/delivery) and project list data. No new backend.
 */
export interface ChecklistItem { id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail?: string }

export interface DeliveryOverview {
  summary: { name: string; floors: number; devices: number; lastEditedAt?: string };
  floors: { id: string; name: string; analysisStatus: string; devices: number; rooms: number }[];
  deviceByCategory: Record<string, number>;
  ai: { avgConfidence: number | null; acceptedSuggestions: number; rejectedSuggestions: number };
  exportStatus: string | null;
  deliveryStatus: 'draft' | 'ready' | 'exported' | 'delivered';
  checklist: ChecklistItem[];
  history: ExportHistoryItem[];
}

export interface ExportHistoryItem {
  id: string; status: string; versionName?: string | null; style?: string; floors?: number;
  pages?: number | null; sizeBytes?: number | null; exportedBy?: string | null;
  createdAt?: string; finishedAt?: string | null; error?: string | null; downloadUrl?: string | null;
}

const WEIGHT = { pass: 1, warn: 0.5, fail: 0 } as const;

/** 0–100 readiness from the delivery checklist, plus the list of blockers (what's < 100%). */
export function computeReadiness(o?: DeliveryOverview | null): {
  score: number; blockers: ChecklistItem[]; passed: number; total: number;
} {
  const items = o?.checklist ?? [];
  if (!items.length) return { score: 0, blockers: [], passed: 0, total: 0 };
  const sum = items.reduce((s, i) => s + WEIGHT[i.status], 0);
  const score = Math.round((sum / items.length) * 100);
  const blockers = items.filter((i) => i.status !== 'pass');
  return { score, blockers, passed: items.filter((i) => i.status === 'pass').length, total: items.length };
}

export interface AttentionItem { message: string; tone: 'warn' | 'danger'; href?: string; tab?: string }

/** Build the project-level "needs attention" list from existing overview data. */
export function buildAttention(o?: DeliveryOverview | null): AttentionItem[] {
  if (!o) return [];
  const out: AttentionItem[] = [];
  for (const f of o.floors) {
    if (f.analysisStatus === 'failed') out.push({ message: `${f.name}: analysis failed — retry`, tone: 'danger', href: `/editor/${f.id}` });
    else if (f.analysisStatus === 'done' && f.devices === 0) out.push({ message: `${f.name}: analyzed but no devices`, tone: 'warn', href: `/editor/${f.id}` });
    else if (f.analysisStatus === 'none') out.push({ message: `${f.name}: not analyzed yet`, tone: 'warn', href: `/editor/${f.id}` });
  }
  const latest = o.history?.[0];
  if (latest?.status === 'failed') out.push({ message: `Last export failed${latest.error ? ` — ${latest.error}` : ''}`, tone: 'danger', tab: 'Delivery' });
  if (o.ai?.rejectedSuggestions > 0 && o.summary.devices === 0) out.push({ message: `${o.ai.rejectedSuggestions} suggestions withheld and none placed`, tone: 'warn', tab: 'Review' });
  if (o.deliveryStatus === 'exported') out.push({ message: 'Exported — ready to mark delivered', tone: 'warn', tab: 'Delivery' });
  return out;
}

/** Lightweight per-project attention for the dashboard (from project list fields). */
export function projectCardAttention(p: any): { label: string; tone: 'warn' | 'danger' } | null {
  const floors = p.stats?.floors ?? 0;
  const devices = p.stats?.devices ?? 0;
  const delivery = p.delivery?.status;
  if (floors > 0 && devices === 0) return { label: 'No devices yet', tone: 'warn' };
  if (delivery === 'exported') return { label: 'Ready to deliver', tone: 'warn' };
  return null;
}

export function formatBytes(n?: number | null): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
