/**
 * PlanIQ background worker (BullMQ). Standalone process (no HTTP).
 * Queues: analysis ('process' | 'analyze'), export ('export').
 * Run: node dist/worker.js
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import IORedis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import config from './config/configuration';
import {
  extractHost,
  loadEnvFromSharedSources,
  maskConnectionValue,
  maskSecret,
  validateWorkerRuntimeEnv,
} from './config/env-bootstrap';
import { createS3Client, formatS3EndpointForLog } from './config/s3-client';
import { MONGOOSE_MODELS } from './db/schemas';
import { renderProjectPdf } from './modules/exports/pdf-renderer';

const loadedEnvFiles = loadEnvFromSharedSources();
validateWorkerRuntimeEnv(process.env as Record<string, unknown>);
const cfg = config();
const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });
const s3 = createS3Client(cfg.s3);

async function presignGet(key: string) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: key }), { expiresIn: 1800 });
}
async function getBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: key }));
  const chunks: Buffer[] = []; for await (const c of res.Body as any) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}
async function putBuffer(key: string, body: Buffer, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket: cfg.s3.bucket, Key: key, Body: body, ContentType: contentType }));
}

const analysisQueue = new Queue('analysis', { connection });
async function progress(floorId: string, stage: string, pct: number, message = '') {
  await connection.set(`analysis:progress:${floorId}`, JSON.stringify({ stage, pct, message }), 'EX', 600);
}

let M: Record<string, mongoose.Model<any>> = {};

const FLOOR_KIND_BY_NAME = (name: string): string => {
  const n = name.toLowerCase();
  if (n.includes('site')) return 'site';
  if (n.includes('ground')) return 'ground';
  if (n.includes('first')) return 'first';
  if (n.includes('second')) return 'second';
  if (n.includes('roof')) return 'roof';
  if (n.includes('basement')) return 'basement';
  return 'other';
};

// ── 'process': source upload → page rasters → floors → enqueue analyze ──
async function handleProcess(data: any) {
  const asset = await M.PlanAsset.findById(data.assetId);
  if (!asset) return;
  const buf = await getBuffer(asset.s3Key);

  // Ask the AI service to ingest (PDF→page PNGs / image passthrough). Stateless: returns base64 pages.
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)]), asset.originalName ?? 'plan');
  form.append('dpi', String(cfg.ai.rasterDpi));
  const res = await fetch(`${cfg.ai.url}/ingest`, { method: 'POST', body: form as any });
  if (!res.ok) throw new Error(`AI ingest failed: ${res.status}`);
  const { pages } = await res.json() as { pages: { name: string; width: number; height: number; b64: string }[] };

  const createdFloors: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const key = `${asset.tenantId}/${asset.projectId}/page_raster/${randomUUID()}.png`;
    await putBuffer(key, Buffer.from(pg.b64, 'base64'), 'image/png');

    let floor = asset.floorId && i === 0 ? await M.Floor.findById(asset.floorId) : null;
    const name = pg.name || `Page ${i + 1}`;
    if (!floor) {
      floor = await M.Floor.create({
        tenantId: asset.tenantId, projectId: asset.projectId, name, level: i,
        kind: FLOOR_KIND_BY_NAME(name),
      });
      // seed default layers
      const { DEFAULT_LAYERS } = await import('@planiq/shared');
      await M.Layer.insertMany(DEFAULT_LAYERS.map((l: any, idx: number) => ({
        tenantId: asset.tenantId, floorId: floor!._id, name: l.name, color: l.color, order: idx, visible: true,
      })));
    }
    floor.raster = { assetId: asset._id, key, width: pg.width, height: pg.height, dpi: cfg.ai.rasterDpi };
    floor.analysis = { status: 'queued' };
    await floor.save();
    createdFloors.push(String(floor._id));
    await analysisQueue.add('analyze', { floorId: String(floor._id), tenantId: asset.tenantId, provider: 'cv' });
  }
  asset.status = 'scanned'; await asset.save();
  await M.Project.updateOne({ _id: asset.projectId }, { $inc: { 'stats.floors': createdFloors.length } });
  return { floors: createdFloors };
}

// ── 'analyze': floor raster → AI /analyze → persist rooms/zones/placements ──
async function handleAnalyze(data: any) {
  const floor = await M.Floor.findById(data.floorId);
  if (!floor?.raster?.key) return;
  await progress(data.floorId, 'preprocess', 10, 'Preparing image');
  floor.analysis = { ...floor.analysis, status: 'processing' }; await floor.save();

  const imageUrl = await presignGet(floor.raster.key);
  await progress(data.floorId, 'detect', 40, 'Detecting rooms & symbols');
  const res = await fetch(`${cfg.ai.url}/analyze`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageUrl, floorId: data.floorId, units: 'm', provider: data.provider ?? 'cv', fallbackProvider: cfg.ai.fallbackProvider }),
  });
  if (!res.ok) { floor.analysis = { ...floor.analysis, status: 'failed', error: `AI ${res.status}` }; await floor.save(); throw new Error(`analyze ${res.status}`); }
  const result = await res.json();

  await progress(data.floorId, 'persist', 75, 'Saving suggestions');
  await M.DetectedRoom.deleteMany({ floorId: floor._id });
  await M.DetectedZone.deleteMany({ floorId: floor._id });
  await M.Placement.deleteMany({ floorId: floor._id, source: 'ai', reviewed: false });

  if (result.rooms?.length) await M.DetectedRoom.insertMany(result.rooms.map((r: any) => ({ ...r, tenantId: floor.tenantId, floorId: floor._id })));
  if (result.zones?.length) await M.DetectedZone.insertMany(result.zones.map((z: any) => ({ ...z, tenantId: floor.tenantId, floorId: floor._id })));
  if (result.placements?.length) await M.Placement.insertMany(result.placements.map((p: any) => ({
    ...p, _id: undefined, tenantId: floor.tenantId, floorId: floor._id, projectId: floor.projectId,
    hidden: p.hidden ?? p.meta?.qcStatus === 'rejected',
    confidence: p.confidence ?? 0.7,
    meta: p.meta ?? {},
  })));

  const acceptedCount = (result.placements ?? []).filter((p: any) =>
    !p.hidden && p.meta?.qcStatus !== 'rejected',
  ).length;

  floor.counts = { rooms: result.rooms?.length ?? 0, placements: acceptedCount };
  floor.analysis = {
    status: 'done',
    confidence: result.confidence,
    version: (floor.analysis?.version ?? 0) + 1,
    finishedAt: new Date(),
    qcSummary: result.qcSummary ?? null,
    rawRoomCount: result.rawRoomCount ?? result.qcSummary?.detectedSpaces ?? null,
  };
  await floor.save();
  await progress(data.floorId, 'done', 100, 'Analysis complete');
  return { rooms: floor.counts.rooms, placements: floor.counts.placements };
}

// ── 'export': render project PDF via Playwright → S3 ──
async function handleExport(data: any) {
  const exp = await M.Export.findById(data.exportId);
  if (!exp) return;
  exp.status = 'processing'; await exp.save();
  try {
    const project = await M.Project.findById(data.projectId).lean();
    const floorFilter: any = { projectId: data.projectId };
    if (exp.options?.floors?.length) floorFilter._id = { $in: exp.options.floors };
    const floors = await M.Floor.find(floorFilter).sort({ level: 1 }).lean();
    const data_ = await Promise.all(floors.map(async (f: any) => ({
      floor: f,
      rasterUrl: f.raster?.key ? await presignGet(f.raster.key) : null,
      placements: await M.Placement.find({ floorId: f._id }).lean(),
    })));
    const devices = await M.DeviceLibrary.find({ enabled: true }).lean();
    const pdf = await renderProjectPdf({ project, floors: data_, devices, options: exp.options });
    const key = `${exp.tenantId}/${data.projectId}/export/${randomUUID()}.pdf`;
    await putBuffer(key, pdf, 'application/pdf');
    exp.status = 'done'; exp.s3Key = key; exp.pages = floors.length + 1; exp.sizeBytes = pdf.length; exp.finishedAt = new Date();
    await exp.save();
    await M.Project.updateOne({ _id: data.projectId }, { 'stats.lastExportAt': new Date() });
  } catch (e: any) {
    exp.status = 'failed'; exp.error = e?.message; await exp.save(); throw e;
  }
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`[worker] env sources: ${loadedEnvFiles.length ? loadedEnvFiles.join(', ') : 'process.env only'}`);
  // eslint-disable-next-line no-console
  console.log(`[worker] Mongo host: ${extractHost(cfg.mongoUri)} (${maskConnectionValue(cfg.mongoUri)})`);
  // eslint-disable-next-line no-console
  console.log(`[worker] Redis URL: ${maskConnectionValue(cfg.redisUrl)}`);
  // eslint-disable-next-line no-console
  console.log(`[worker] S3 bucket: ${cfg.s3.bucket}`);
  // eslint-disable-next-line no-console
  console.log(`[worker] S3 region: ${cfg.s3.region}`);
  // eslint-disable-next-line no-console
  console.log(`[worker] S3 endpoint: ${formatS3EndpointForLog(cfg.s3.endpoint)}`);
  // eslint-disable-next-line no-console
  console.log(`[worker] S3 path style: ${cfg.s3.forcePathStyle}`);
  // eslint-disable-next-line no-console
  console.log(`[worker] S3 access key: ${maskSecret(cfg.s3.accessKey)}`);
  // eslint-disable-next-line no-console
  console.log(`[worker] AI service URL: ${maskConnectionValue(cfg.ai.url)}`);

  await mongoose.connect(cfg.mongoUri);
  M = Object.fromEntries(MONGOOSE_MODELS.map((m) => [m.name, mongoose.model(m.name, m.schema)]));
  // eslint-disable-next-line no-console
  console.log('PlanIQ worker connected; listening on analysis + export queues');

  new Worker('analysis', async (job) => {
    if (job.name === 'process') return handleProcess(job.data);
    if (job.name === 'analyze') return handleAnalyze(job.data);
  }, { connection, concurrency: 4 });

  new Worker('export', async (job) => handleExport(job.data), { connection, concurrency: 2 });
}

main().catch((e) => { console.error(e); process.exit(1); });

process.on('SIGTERM', async () => { await mongoose.disconnect(); process.exit(0); });
