import { z } from 'zod';

/** Fail fast at boot if critical env vars are missing/invalid. */
const optionalNonEmptyString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  MONGO_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_ENDPOINT: optionalNonEmptyString,
  AI_SERVICE_URL: z.string().url(),
  AI_FALLBACK_PROVIDER: z.enum(['disabled', 'openai', 'gemini', 'claude']).default('disabled'),
});

export function validateEnv(config: Record<string, unknown>) {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // In dev we warn; in prod we throw.
    if (config.NODE_ENV === 'production') {
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    // eslint-disable-next-line no-console
    console.warn(`[config] env warnings (dev):\n${issues}`);
  }
  return config;
}
