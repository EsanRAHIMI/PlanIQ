/** Developer-friendly upload logging (no secrets). */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}?…`;
  } catch {
    return '(invalid url)';
  }
}

export function uploadLog(stage: string, data: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === 'production') return;
  // eslint-disable-next-line no-console
  console.log(`[upload] ${stage}`, data);
}
