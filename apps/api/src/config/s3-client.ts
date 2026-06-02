import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';

export interface S3Settings {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

/** Treat blank env values as unset (required for real AWS S3 where endpoint is omitted). */
export function optionalEnvString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** MinIO/S3-compatible when endpoint is set; native AWS endpoint when omitted. */
export function buildS3ClientConfig(s3: S3Settings): S3ClientConfig {
  return {
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    region: s3.region,
    forcePathStyle: s3.forcePathStyle,
    credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
  };
}

export function createS3Client(s3: S3Settings): S3Client {
  return new S3Client(buildS3ClientConfig(s3));
}

export function formatS3EndpointForLog(endpoint?: string): string {
  return endpoint ?? 'AWS native (region endpoint)';
}
