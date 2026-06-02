import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { createS3Client } from '../../config/s3-client';

@Injectable()
export class StorageService {
  private readonly logger = new Logger('Storage');
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private config: ConfigService) {
    const s3 = this.config.get('s3') as any;
    this.bucket = s3.bucket;
    this.s3 = createS3Client(s3);
  }

  key(tenantId: string, projectId: string, kind: string, ext: string): string {
    return `${tenantId}/${projectId}/${kind}/${randomUUID()}.${ext}`;
  }

  async presignPut(key: string, contentType: string, expiresIn = 900): Promise<string> {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn });
  }

  async presignGet(key: string, expiresIn = 900): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  async exists(key: string): Promise<boolean> {
    try { await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; }
    catch { return false; }
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async getBuffer(key: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const c of res.Body as any) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
