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
import { AI_SETTINGS_KEY, normalizeAiSettings, countsFromQcSummary } from '@planiq/shared';
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
import { assertPlaniqSharedBuilt } from './config/ensure-shared';

assertPlaniqSharedBuilt();

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
  // Advance the canonical lifecycle out of 'draft' once a plan is in.
  await M.Project.updateOne({ _id: asset.projectId, status: 'draft' }, { $set: { status: 'in_progress' } });
  return { floors: createdFloors };
}

function qcPayload(settings: ReturnType<typeof normalizeAiSettings>) {
  return {
    maxRoomsPerFloor: settings.maxRoomsPerFloor,
    maxDevicesPerFloor: settings.maxDevicesPerFloor,
    maxDevicesPerRoom: settings.maxDevicesPerRoom,
    minRoomConfidence: settings.minRoomConfidence,
    minDeviceConfidence: settings.minDeviceConfidence,
    fallbackProvider: settings.fallbackProvider,
  };
}

function resolveProviderUsed(result: any, requested: string, fallbackProvider: string): string {
  if (result.providerUsed) return result.providerUsed;
  if (result.provider === 'llm_fallback' || requested === 'llm_fallback') {
    if (['openai', 'claude', 'gemini'].includes(fallbackProvider)) return fallbackProvider;
    return 'openai';
  }
  return 'cv';
}

// ── 'analyze': floor raster → AI /analyze → persist rooms/zones/placements ──
async function handleAnalyze(data: any) {
  const floor = await M.Floor.findById(data.floorId);
  if (!floor?.raster?.key) return;
  const startedAt = new Date();

  const settingDoc = await M.Setting.findOne({ scope: 'tenant', tenantId: floor.tenantId, key: AI_SETTINGS_KEY }).lean();
  const aiSettings = normalizeAiSettings((settingDoc as any)?.value);
  const requested = data.provider ?? (aiSettings.fallbackProvider !== 'disabled' ? 'llm_fallback' : 'cv');

  const run = await M.AnalysisRun.create({
    tenantId: floor.tenantId,
    projectId: floor.projectId,
    floorId: floor._id,
    kind: 'full_analysis',
    status: 'running',
    jobId: floor.analysis?.jobId ? String(floor.analysis.jobId) : undefined,
    triggeredBy: data.triggeredBy ?? undefined,
    provider: requested === 'llm_fallback' ? (['openai', 'claude', 'gemini'].includes(aiSettings.fallbackProvider) ? aiSettings.fallbackProvider : 'openai') : 'cv',
    modelName: null,
    fallbackChain: requested === 'llm_fallback' ? ['cv_skipped', `llm_fallback:${aiSettings.fallbackProvider}`] : ['cv'],
    qcSettings: qcPayload(aiSettings),
    startedAt,
    warnings: [],
    errors: [],
  });

  await progress(data.floorId, 'preprocess', 10, 'Preparing image');
  floor.analysis = { ...floor.analysis, status: 'processing', latestRunId: run._id }; await floor.save();

  const imageUrl = await presignGet(floor.raster.key);
  await progress(data.floorId, 'detect', 40, 'Detecting rooms & symbols');

  const t0 = Date.now();
  let result: any;
  try {
    const res = await fetch(`${cfg.ai.url}/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        imageUrl, floorId: data.floorId, units: 'm',
        provider: requested, fallbackProvider: aiSettings.fallbackProvider,
        qc: {
          maxRoomsPerFloor: aiSettings.maxRoomsPerFloor,
          maxDevicesPerFloor: aiSettings.maxDevicesPerFloor,
          maxDevicesPerRoom: aiSettings.maxDevicesPerRoom,
          minRoomConfidence: aiSettings.minRoomConfidence,
          minDeviceConfidence: aiSettings.minDeviceConfidence,
        },
      }),
    });
    if (!res.ok) {
      const errText = `AI service HTTP ${res.status}`;
      await M.AnalysisRun.updateOne({ _id: run._id }, {
        status: 'failed', finishedAt: new Date(), durationMs: Date.now() - t0,
        errors: [errText],
      });
      floor.analysis = { ...floor.analysis, status: 'failed', error: errText, latestRunId: run._id };
      await floor.save();
      throw new Error(errText);
    }
    result = await res.json();
  } catch (e: any) {
    const msg = e?.message ?? 'Analysis failed';
    await M.AnalysisRun.updateOne({ _id: run._id }, {
      status: 'failed', finishedAt: new Date(), durationMs: Date.now() - t0, errors: [msg],
    });
    floor.analysis = { ...floor.analysis, status: 'failed', error: msg, latestRunId: run._id };
    await floor.save();
    throw e;
  }

  const durationMs = result.durationMs ?? (Date.now() - t0);
  const providerUsed = resolveProviderUsed(result, requested, aiSettings.fallbackProvider);
  const counts = countsFromQcSummary(result.qcSummary);

  await progress(data.floorId, 'persist', 75, 'Saving suggestions');
  // Re-analysis re-detects spaces: replace CV-detected rooms but PRESERVE the user's
  // manual rooms (source 'manual') so their work survives a re-run.
  await M.DetectedRoom.deleteMany({ floorId: floor._id, source: { $ne: 'manual' } });
  await M.DetectedZone.deleteMany({ floorId: floor._id });
  await M.Placement.deleteMany({ floorId: floor._id, source: 'ai', reviewed: false });

  // Map each space to a review lifecycle status, keeping AI output separate from
  // user-reviewed state. Rejected spaces are persisted (not dropped) for user review.
  const roomDocs = (result.rooms ?? []).map((r: any) => {
    const rejected = r.meta?.qcStatus === 'rejected';
    return {
      ...r,
      tenantId: floor.tenantId,
      floorId: floor._id,
      source: r.source ?? 'cv',
      reviewStatus: rejected ? 'rejected' : 'ai_detected',
      aiType: r.type ?? null,
      aiConfidence: typeof r.confidence === 'number' ? r.confidence : null,
      rejectionReason: rejected ? (r.meta?.rejectionReason ?? 'Withheld by quality control') : null,
    };
  });
  const acceptedRoomCount = roomDocs.filter((r: any) => r.reviewStatus !== 'rejected').length;
  if (roomDocs.length) await M.DetectedRoom.insertMany(roomDocs);
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

  await M.AnalysisRun.updateOne({ _id: run._id }, {
    status: 'done',
    finishedAt: new Date(),
    durationMs,
    provider: providerUsed,
    modelName: result.modelName ?? null,
    fallbackChain: result.fallbackChain?.length ? result.fallbackChain : run.fallbackChain,
    qcSummary: result.qcSummary ?? null,
    ...counts,
    warnings: result.warnings ?? [],
    errors: result.errors ?? [],
  });

  floor.counts = { rooms: acceptedRoomCount, placements: acceptedCount };
  // Persist the estimated drawing scale (auto-calibrated from door widths). Keep any
  // existing user-calibrated scale; otherwise record the estimate as uncalibrated.
  if (result.scale?.metersPerPixel && !floor.scale?.calibrated) {
    floor.scale = { metersPerPixel: result.scale.metersPerPixel, calibrated: false };
  }
  floor.analysis = {
    status: 'done',
    confidence: result.confidence,
    version: (floor.analysis?.version ?? 0) + 1,
    finishedAt: new Date(),
    qcSummary: result.qcSummary ?? null,
    rawRoomCount: result.rawRoomCount ?? result.qcSummary?.detectedSpaces ?? null,
    latestRunId: run._id,
  };
  await floor.save();
  await progress(data.floorId, 'done', 100, 'Analysis complete');
  return { rooms: floor.counts.rooms, placements: floor.counts.placements, runId: String(run._id) };
}

// ── 'export': render project PDF via Playwright → S3 ──
async function handleExport(data: any) {
  const exp = await M.Export.findById(data.exportId);
  if (!exp) return;
  exp.status = 'processing'; await exp.save();
  try {
    const tenantId = exp.tenantId; // tenant-scope every read (defense in depth)
    const project = await M.Project.findOne({ _id: data.projectId, tenantId }).lean();
    if (!project) throw new Error('Project not found for tenant');
    const floorFilter: any = { projectId: data.projectId, tenantId };
    if (exp.options?.floors?.length) floorFilter._id = { $in: exp.options.floors };
    const floors = await M.Floor.find(floorFilter).sort({ level: 1 }).lean();
    const data_ = await Promise.all(floors.map(async (f: any) => ({
      floor: f,
      rasterUrl: f.raster?.key ? await presignGet(f.raster.key) : null,
      placements: await M.Placement.find({ floorId: f._id, tenantId }).lean(),
      layers: await M.Layer.find({ floorId: f._id, tenantId }).sort({ order: 1 }).lean(),
    })));
    const devices = await M.DeviceLibrary.find({ enabled: true }).lean();
    const preparer = exp.createdBy ? await M.User.findById(exp.createdBy).lean() : null;
    const pdf = await renderProjectPdf({
      project, floors: data_, devices, options: exp.options,
      preparedBy: exp.options?.preparedBy ?? (preparer as any)?.name ?? null,
    });
    const key = `${exp.tenantId}/${data.projectId}/export/${randomUUID()}.pdf`;
    await putBuffer(key, pdf, 'application/pdf');
    exp.status = 'done'; exp.s3Key = key; exp.pages = floors.length + 1; exp.sizeBytes = pdf.length; exp.finishedAt = new Date();
    await exp.save();
    // Advance the canonical lifecycle to "exported" (unless already delivered/archived),
    // keeping the delivery mirror in sync.
    await M.Project.updateOne(
      { _id: data.projectId, status: { $nin: ['delivered', 'archived'] } },
      { $set: { 'stats.lastExportAt': new Date(), status: 'exported', 'delivery.status': 'exported', 'delivery.updatedAt': new Date() } },
    );
    await M.Project.updateOne(
      { _id: data.projectId, status: { $in: ['delivered', 'archived'] } },
      { $set: { 'stats.lastExportAt': new Date() } },
    );
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

  // Liveness heartbeat consumed by the admin health endpoint (key TTL > interval).
  const beat = () => connection.set('worker:heartbeat', JSON.stringify({ at: Date.now(), pid: process.pid }), 'EX', 60)
    .catch((e) => console.error('[worker] heartbeat failed', e?.message));
  await beat();
  setInterval(beat, 15000).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });

process.on('SIGTERM', async () => { await mongoose.disconnect(); process.exit(0); });
