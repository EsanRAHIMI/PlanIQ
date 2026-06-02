'use client';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

let accessToken: string | null = null;
export const setToken = (t: string | null) => { accessToken = t; if (typeof window !== 'undefined') { t ? localStorage.setItem('pq_t', t) : localStorage.removeItem('pq_t'); } };
export const loadToken = () => { if (typeof window !== 'undefined' && !accessToken) accessToken = localStorage.getItem('pq_t'); return accessToken; };

export interface ApiErrorDetail {
  code?: string;
  message?: string;
  details?: unknown;
  traceId?: string;
}

export class ApiError extends Error {
  status: number;
  endpoint: string;
  code?: string;
  traceId?: string;
  details?: unknown;

  constructor(message: string, status: number, endpoint: string, detail?: ApiErrorDetail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.code = detail?.code;
    this.traceId = detail?.traceId;
    this.details = detail?.details;
  }

  toLogObject() {
    return {
      status: this.status,
      endpoint: this.endpoint,
      code: this.code,
      message: this.message,
      traceId: this.traceId,
    };
  }
}

export class S3UploadError extends Error {
  status: number;
  stage = 's3-upload';

  constructor(message: string, status: number) {
    super(message);
    this.name = 'S3UploadError';
    this.status = status;
  }
}

async function request<T>(path: string, opts: RequestInit = {}, retry = true): Promise<T> {
  loadToken();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(opts.headers ?? {}),
    },
    credentials: 'include',
  });
  if (res.status === 401 && retry && !path.startsWith('/auth')) {
    const ok = await refresh();
    if (ok) return request<T>(path, opts, false);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = body?.error ?? {};
    throw new ApiError(
      err.message ?? res.statusText,
      res.status,
      path,
      { code: err.code, message: err.message, details: err.details, traceId: err.traceId },
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

async function refresh(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return false;
    const { accessToken: t } = await res.json();
    setToken(t);
    return true;
  } catch { return false; }
}

export const api = {
  get: <T,>(p: string) => request<T>(p),
  post: <T,>(p: string, body?: any) => request<T>(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T,>(p: string, body?: any) => request<T>(p, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T,>(p: string) => request<T>(p, { method: 'DELETE' }),
  refresh,
};

export async function uploadToS3(uploadUrl: string, file: File, contentType: string) {
  const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': contentType } });
  if (!res.ok) throw new S3UploadError(`S3 upload failed (${res.status})`, res.status);
}

/** Resolve MIME from file when browser leaves type empty (common for PDF). */
export function resolveMime(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return file.type;
}

export function formatApiError(err: unknown, stage: string): string {
  if (err instanceof ApiError) {
    const parts = [stage, err.message];
    if (err.code) parts.push(`(${err.code})`);
    if (err.traceId) parts.push(`trace: ${err.traceId}`);
    return parts.join(' · ');
  }
  if (err instanceof S3UploadError) return `${stage}: ${err.message}`;
  if (err instanceof Error) return `${stage}: ${err.message}`;
  return `${stage}: Unknown error`;
}
