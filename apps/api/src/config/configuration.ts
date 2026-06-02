import { optionalEnvString } from './s3-client';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  apiPrefix: string;
  webOrigin: string;
  mongoUri: string;
  redisUrl: string;
  jwt: { accessSecret: string; refreshSecret: string; accessTtl: string; refreshTtl: string; cookieDomain: string };
  s3: { endpoint?: string; region: string; bucket: string; accessKey: string; secretKey: string; forcePathStyle: boolean; publicUrl?: string };
  ai: { url: string; timeoutMs: number; rasterDpi: number; enableDwg: boolean; fallbackProvider: string };
  limits: { uploadMaxMb: number; rateWindow: number; rateMax: number };
  logLevel: string;
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.API_PORT ?? '4000', 10),
  apiPrefix: process.env.API_PREFIX ?? '/api/v1',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/planiq',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
    cookieDomain: process.env.COOKIE_DOMAIN ?? 'localhost',
  },
  s3: {
    endpoint: optionalEnvString(process.env.S3_ENDPOINT),
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? '',
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'false') === 'true',
    publicUrl: optionalEnvString(process.env.S3_PUBLIC_URL),
  },
  ai: {
    url: process.env.AI_SERVICE_URL ?? 'http://localhost:8000',
    timeoutMs: parseInt(process.env.AI_TIMEOUT_MS ?? '120000', 10),
    rasterDpi: parseInt(process.env.AI_RASTER_DPI ?? '200', 10),
    enableDwg: (process.env.AI_ENABLE_DWG ?? 'false') === 'true',
    fallbackProvider: process.env.AI_FALLBACK_PROVIDER ?? 'disabled',
  },
  limits: {
    uploadMaxMb: parseInt(process.env.UPLOAD_MAX_MB ?? '50', 10),
    rateWindow: parseInt(process.env.RATE_LIMIT_WINDOW ?? '60', 10),
    rateMax: parseInt(process.env.RATE_LIMIT_MAX ?? '120', 10),
  },
  logLevel: process.env.LOG_LEVEL ?? 'info',
});
