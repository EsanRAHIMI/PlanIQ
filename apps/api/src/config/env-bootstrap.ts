import { existsSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Single source of truth for env file precedence across API + worker.
 * Relative paths are resolved from process.cwd().
 */
export const ENV_FILE_PATHS = ['.env.local.dev', '.env', '../../.env.local.dev', '../../.env'] as const;

const optionalNonEmptyString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const workerRuntimeSchema = z.object({
  MONGO_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  AI_SERVICE_URL: z.string().min(1),
  S3_ENDPOINT: optionalNonEmptyString,
});

export function loadEnvFromSharedSources(): string[] {
  const loaded: string[] = [];
  for (const relPath of ENV_FILE_PATHS) {
    const absolutePath = resolve(process.cwd(), relPath);
    if (!existsSync(absolutePath)) continue;
    dotenv.config({ path: absolutePath, override: false, quiet: true });
    loaded.push(absolutePath);
  }
  return loaded;
}

export function validateWorkerRuntimeEnv(config: Record<string, unknown>): void {
  const parsed = workerRuntimeSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Worker environment is incomplete:\n${issues}`);
  }
}

export function maskSecret(value: string, visible = 4): string {
  if (!value) return '(empty)';
  if (value.length <= visible * 2) return '***';
  return `${value.slice(0, visible)}***${value.slice(-visible)}`;
}

export function maskConnectionValue(input: string): string {
  // Hide credentials in connection URLs while keeping host/port for diagnostics.
  try {
    const url = new URL(input);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return maskSecret(input);
  }
}

export function extractHost(input: string): string {
  try {
    return new URL(input).host;
  } catch {
    return input;
  }
}
