import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Param, Body, Query, UsePipes,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import {
  createSampleSchema, updateSampleSchema, saveAnnotationsSchema, annotationSchema,
  uploadRoleSchema, exportDatasetSchema, feedbackSchema, modelStatusSchema,
  yoloLabelLine, dataYaml, learnPriors, canTransition, DEVICE_CLASSES,
  inferFloorType, deviceCountMetrics, yoloStatus, ENGINEER_DEVICE_CLASSES,
  type ModelStatus,
} from '@planiq/shared';
import { MODELS, TrainingProjectSchema, TrainingSampleSchema, TrainingDatasetSchema, ModelVersionSchema, PlacementPriorsSchema, PlacementFeedbackSchema } from '../../db/schemas';
import { StorageService } from '../storage/storage.service';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, AuthUser, Roles } from '../../common/decorators';

const ALLOWED_MIME: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

@Injectable()
export class TrainingService {
  constructor(
    @InjectModel(MODELS.TrainingProject) private projects: Model<any>,
    @InjectModel(MODELS.TrainingSample) private samples: Model<any>,
    @InjectModel(MODELS.TrainingDataset) private datasets: Model<any>,
    @InjectModel(MODELS.ModelVersion) private models: Model<any>,
    @InjectModel(MODELS.PlacementPriors) private priors: Model<any>,
    @InjectModel(MODELS.PlacementFeedback) private feedback: Model<any>,
    private storage: StorageService,
    private config: ConfigService,
  ) {}

  private trainingKey(tenantId: string, kind: string, ext: string): string {
    return this.storage.key(tenantId, 'training', kind, ext);
  }

  private aiUrl(): string {
    return (this.config.get('ai') as any)?.url ?? 'http://localhost:8000';
  }

  // ── YOLO perception-layer status (first-class, optional) ────────────────────
  async yoloStatus(user: AuthUser) {
    const models = await this.models.find({ tenantId: user.tenantId }).select('status version').lean();
    let aiHealth: any = null;
    try { aiHealth = await (await fetch(`${this.aiUrl()}/health`)).json(); } catch { /* AI service optional */ }
    return {
      ...yoloStatus(models as unknown as { status: ModelStatus }[]),
      weightsLoaded: !!aiHealth?.yolo?.weightsLoaded,
      ocrEngine: aiHealth?.ocrEngine ?? null,
      note: 'YOLO is optional. Inactive → system runs on OCR + geometry + rules + priors. '
          + 'Active (a model in production) → improves detection confidence & candidate generation only.',
    };
  }

  // ── Samples ───────────────────────────────────────────────────────────────
  createSample(user: AuthUser, dto: any) {
    return this.samples.create({ ...dto, tenantId: user.tenantId, createdBy: user.id, status: 'draft' });
  }

  listSamples(user: AuthUser) {
    return this.samples.find({ tenantId: user.tenantId })
      .select('name projectType floorKind drawingType engineer date status split counts before.s3Key after.s3Key')
      .sort({ createdAt: -1 }).lean();
  }

  async getSample(user: AuthUser, id: string) {
    const s = await this.samples.findOne({ _id: id, tenantId: user.tenantId }).lean() as any;
    if (!s) throw new NotFoundException('Training sample not found');
    const sign = async (k?: string) => (k ? this.storage.presignGet(k, 1800) : null);
    return { ...s, beforeUrl: await sign(s.before?.s3Key), afterUrl: await sign(s.after?.s3Key) };
  }

  async updateSample(user: AuthUser, id: string, dto: any) {
    const s = await this.samples.findOneAndUpdate({ _id: id, tenantId: user.tenantId }, dto, { new: true }).lean();
    if (!s) throw new NotFoundException('Training sample not found');
    return s;
  }

  async deleteSample(user: AuthUser, id: string) {
    const r = await this.samples.updateOne({ _id: id, tenantId: user.tenantId }, { deletedAt: new Date() });
    if (!r.matchedCount) throw new NotFoundException('Training sample not found');
    return { ok: true };
  }

  // ── BEFORE/AFTER upload ─────────────────────────────────────────────────────
  async uploadUrl(user: AuthUser, id: string, dto: { role: 'before' | 'after'; mime: string }) {
    const ext = ALLOWED_MIME[dto.mime];
    if (!ext) throw new BadRequestException('Unsupported file type. Allowed: PDF, PNG, JPG');
    const s = await this.samples.findOne({ _id: id, tenantId: user.tenantId });
    if (!s) throw new NotFoundException('Training sample not found');
    const key = this.trainingKey(user.tenantId, `${dto.role}`, ext);
    s[dto.role] = { s3Key: key, mime: dto.mime };
    await s.save();
    return { uploadUrl: await this.storage.presignPut(key, dto.mime), s3Key: key, headers: { 'Content-Type': dto.mime } };
  }

  async complete(user: AuthUser, id: string, dto: { role: 'before' | 'after'; width?: number; height?: number }) {
    const s = await this.samples.findOne({ _id: id, tenantId: user.tenantId });
    if (!s) throw new NotFoundException('Training sample not found');
    const slot = s[dto.role];
    if (!slot?.s3Key || !(await this.storage.exists(slot.s3Key))) throw new BadRequestException('Upload not found in storage');
    if (dto.width) slot.width = dto.width;
    if (dto.height) slot.height = dto.height;
    s[dto.role] = slot;
    // Coarse alignment / scale-orientation check when both plans have dims.
    if (s.before?.width && s.after?.width) {
      const arB = s.before.width / Math.max(1, s.before.height);
      const arA = s.after.width / Math.max(1, s.after.height);
      const sameOrientation = (arB >= 1) === (arA >= 1);
      const sameScale = Math.abs(arB - arA) < 0.05;
      s.alignment = {
        scale: s.before.width / Math.max(1, s.after.width),
        dx: 0, dy: 0, rotation: 0, sameScale, sameOrientation,
      };
    }
    if (s.status === 'draft') s.status = 'uploaded';
    await s.save();
    return { ok: true, status: s.status, alignment: s.alignment };
  }

  /** Heuristic device extraction on the AFTER plan (AI service). Graceful if unavailable. */
  async extract(user: AuthUser, id: string) {
    const s = await this.samples.findOne({ _id: id, tenantId: user.tenantId });
    if (!s?.after?.s3Key) throw new BadRequestException('Upload an AFTER plan first');
    let boxes: any[] = [];
    try {
      const url = await this.storage.presignGet(s.after.s3Key, 600);
      const ai = this.config.get('ai') as any;
      const res = await fetch(`${ai.url}/extract-devices`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageUrl: url }),
      });
      if (res.ok) boxes = ((await res.json()) as any).boxes ?? [];
    } catch {
      // detector not available yet — admin annotates from scratch
    }
    // seed heuristic annotations (kept separate from human/confirmed)
    const seeded = boxes
      .filter((b) => DEVICE_CLASSES.includes(b.deviceCode))
      .map((b) => ({ deviceCode: b.deviceCode, bboxNorm: b.bboxNorm, source: 'heuristic', status: 'pending' }));
    s.annotations = [...(s.annotations ?? []).filter((a: any) => a.source !== 'heuristic'), ...seeded];
    if (s.status === 'uploaded' && seeded.length) s.status = 'annotated';
    await s.save();
    return { seeded: seeded.length, total: s.annotations.length, detectorAvailable: boxes.length > 0 };
  }

  // ── Annotations ───────────────────────────────────────────────────────────--
  async saveAnnotations(user: AuthUser, id: string, annotations: any[]) {
    const s = await this.samples.findOne({ _id: id, tenantId: user.tenantId });
    if (!s) throw new NotFoundException('Training sample not found');
    s.annotations = annotations.map((a) => ({
      deviceCode: a.deviceCode, bboxNorm: a.bboxNorm, spaceTypeHint: a.spaceTypeHint,
      source: a.source ?? 'human', status: a.status ?? 'confirmed',
      reviewedBy: user.id, reviewedAt: new Date(),
    }));
    s.counts = { devices: s.annotations.filter((a: any) => a.status !== 'false_positive').length };
    s.status = 'reviewed';
    await s.save();
    return { ok: true, count: s.counts.devices, status: s.status };
  }

  // ── YOLO dataset export ───────────────────────────────────────────────────--
  async exportDataset(user: AuthUser, dto: { sampleIds?: string[]; valRatio: number }) {
    const filter: any = { tenantId: user.tenantId, 'after.s3Key': { $exists: true } };
    if (dto.sampleIds?.length) filter._id = { $in: dto.sampleIds };
    const samples = await this.samples.find(filter).lean();
    const usable = samples.filter((s: any) => (s.annotations ?? []).some((a: any) => a.status !== 'false_positive'));
    if (!usable.length) throw new BadRequestException('No reviewed samples with confirmed annotations to export');

    const classCounts: Record<string, number> = {};
    const images = usable.map((s: any, i: number) => {
      const labels: string[] = [];
      for (const a of s.annotations) {
        if (a.status === 'false_positive') continue;
        const line = yoloLabelLine(a);
        if (line) { labels.push(line); classCounts[a.deviceCode] = (classCounts[a.deviceCode] ?? 0) + 1; }
      }
      const split = i % Math.round(1 / Math.max(0.05, dto.valRatio)) === 0 ? 'val' : 'train';
      return { sampleId: String(s._id), name: s.name, imageKey: s.after.s3Key,
               width: s.after?.width, height: s.after?.height, split, labels };
    });
    const trainN = images.filter((im) => im.split === 'train').length;
    const valN = images.length - trainN;

    const version = (await this.datasets.countDocuments({ tenantId: user.tenantId })) + 1;
    const manifestKey = this.trainingKey(user.tenantId, 'dataset-manifest', 'json');
    const dataYamlKey = this.trainingKey(user.tenantId, 'dataset-datayaml', 'yaml');
    await this.storage.putBuffer(manifestKey, Buffer.from(JSON.stringify({ version, images }, null, 2)), 'application/json');
    await this.storage.putBuffer(dataYamlKey, Buffer.from(dataYaml()), 'text/yaml');

    const ds = await this.datasets.create({
      tenantId: user.tenantId, version, sampleIds: usable.map((s: any) => s._id),
      split: { train: trainN, val: valN }, classCounts, manifestKey, dataYamlKey, createdBy: user.id,
    });
    await this.samples.updateMany({ _id: { $in: usable.map((s: any) => s._id) } }, { status: 'in_dataset' });
    return { datasetId: String(ds._id), version, samples: images.length, split: { train: trainN, val: valN }, classCounts };
  }

  listDatasets(user: AuthUser) {
    return this.datasets.find({ tenantId: user.tenantId }).sort({ version: -1 }).lean();
  }

  // ── Multi-floor training projects (old_plans importer; repeatable, no hard-coded names) ──
  private async aiMultipart(path: string, buf: Buffer, filename: string, field = 'file'): Promise<any> {
    const fd = new FormData();
    fd.append(field, new Blob([new Uint8Array(buf)], { type: 'application/pdf' }), filename);
    const r = await fetch(`${this.aiUrl()}${path}`, { method: 'POST', body: fd as any });
    if (!r.ok) throw new BadRequestException(`AI ${path} failed (${r.status})`);
    return r.json();
  }

  private async uploadPageImage(tenantId: string, page: any, role: string, n: number, i: number): Promise<string> {
    const key = this.storage.key(tenantId, 'training', `ex${n}-p${i}-${role}`, 'png');
    await this.storage.putBuffer(key, Buffer.from(page.b64, 'base64'), 'image/png');
    return key;
  }

  /** Scan a folder of BEFORE/AFTER villa PDFs → TrainingProject + per-floor TrainingSample.
   *  Idempotent (skips already-imported projects). Floor type from AFTER title; engineer
   *  placements from the AFTER vector text layer. */
  async importProjects(user: AuthUser, dto: { folder?: string }) {
    const fs = await import('fs'); const path = await import('path');
    const folder = dto?.folder || (this.config.get('training') as any)?.oldPlansDir || 'old_plans';
    if (!fs.existsSync(folder)) throw new BadRequestException(`folder not found: ${folder}`);
    const files = fs.readdirSync(folder).filter((f) => /\.pdf$/i.test(f));
    const pairs = new Map<number, { before?: string; after?: string }>();
    for (const f of files) {
      const m = f.match(/example\s*(\d+)/i); if (!m) continue;
      const role = /after/i.test(f) ? 'after' : /before/i.test(f) ? 'before' : null;
      if (!role) continue;
      const e = pairs.get(Number(m[1])) ?? {}; (e as any)[role] = f; pairs.set(Number(m[1]), e);
    }
    const out: any[] = [];
    for (const [n, p] of [...pairs.entries()].sort((a, b) => a[0] - b[0])) {
      if (!p.before || !p.after) { out.push({ name: `Example ${n}`, skipped: 'missing before/after' }); continue; }
      const name = `Example ${n}`;
      if (await this.projects.findOne({ tenantId: user.tenantId, name, deletedAt: null })) { out.push({ name, skipped: 'exists' }); continue; }
      const beforeBuf = fs.readFileSync(path.join(folder, p.before));
      const afterBuf = fs.readFileSync(path.join(folder, p.after));
      const beforePages = (await this.aiMultipart('/ingest', beforeBuf, p.before)).pages ?? [];
      const afterPages = (await this.aiMultipart('/ingest', afterBuf, p.after)).pages ?? [];
      const engineer = await this.aiMultipart('/extract-after-text', afterBuf, p.after); // {floors:[...]}
      const pageCount = Math.min(beforePages.length, afterPages.length) || Math.max(beforePages.length, afterPages.length);
      const proj = await this.projects.create({
        tenantId: user.tenantId, name, source: 'import', beforeFile: p.before, afterFile: p.after,
        pageCount, pageCountMatch: beforePages.length === afterPages.length, status: 'imported', createdBy: user.id,
      });
      const floorTypes: string[] = [];
      let engineerDevices = 0;
      for (let i = 1; i <= pageCount; i++) {
        const bp = beforePages[i - 1]; const ap = afterPages[i - 1];
        const fl = engineer.floors?.[i - 1] ?? { devices: [], deviceCounts: {} };
        const titleText = (fl.devices ?? []).map((d: any) => d.rawText).join(' ');
        const { floorType, source } = inferFloorType(titleText, i, pageCount);
        floorTypes.push(floorType);
        const annotations = (fl.devices ?? [])
          .filter((d: any) => DEVICE_CLASSES.includes(d.deviceCode))
          .map((d: any) => ({ deviceCode: d.deviceCode, bboxNorm: [Math.max(0, d.x - 0.01), Math.max(0, d.y - 0.01), 0.02, 0.02],
            source: 'engineer_vector', status: 'confirmed', rawText: d.rawText }));
        engineerDevices += annotations.length;
        await this.samples.create({
          tenantId: user.tenantId, name: `${name} — ${floorType}`, projectId: proj._id, pageIndex: i, pageCount,
          floorType, floorTypeSource: source, matchConfidence: beforePages.length === afterPages.length ? 1 : 0.5,
          before: bp ? { s3Key: await this.uploadPageImage(user.tenantId, bp, 'before', n, i), width: bp.width, height: bp.height } : undefined,
          after: ap ? { s3Key: await this.uploadPageImage(user.tenantId, ap, 'after', n, i), width: ap.width, height: ap.height } : undefined,
          annotations, counts: { devices: annotations.length },
          status: annotations.length ? 'reviewed' : 'uploaded', createdBy: user.id,
        });
      }
      proj.floorTypes = floorTypes; await proj.save();
      out.push({ name, pages: pageCount, floorTypes, engineerDevices });
    }
    return { imported: out.filter((o) => !o.skipped).length, total: out.length, projects: out };
  }

  async listProjects(user: AuthUser) {
    return this.projects.find({ tenantId: user.tenantId, deletedAt: null }).sort({ name: 1 }).lean();
  }

  async getProject(user: AuthUser, id: string) {
    const proj = await this.projects.findOne({ _id: id, tenantId: user.tenantId }).lean() as any;
    if (!proj) throw new NotFoundException('Training project not found');
    const floors = await this.samples.find({ tenantId: user.tenantId, projectId: id })
      .select('name pageIndex floorType floorTypeSource matchConfidence counts prediction evalMetrics annotations status')
      .sort({ pageIndex: 1 }).lean();
    return { ...proj, floors };
  }

  async setFloorType(user: AuthUser, sampleId: string, floorType: string) {
    const s = await this.samples.findOneAndUpdate(
      { _id: sampleId, tenantId: user.tenantId }, { floorType, floorTypeSource: 'manual' }, { new: true }).lean();
    if (!s) throw new NotFoundException('Floor not found');
    return { ok: true, floorType };
  }

  /** Run the AI pipeline on every BEFORE floor of a project (priors + floorType applied). */
  async runProjectAI(user: AuthUser, id: string) {
    const floors = await this.samples.find({ tenantId: user.tenantId, projectId: id }).sort({ pageIndex: 1 });
    if (!floors.length) throw new NotFoundException('No floors for project');
    const priorsDoc = await this.priors.findOne({ tenantId: user.tenantId }).sort({ version: -1 }).lean() as any;
    const yolo = await this.yoloStatus(user);
    let n = 0;
    for (const f of floors) {
      if (!f.before?.s3Key) continue;
      const imageUrl = await this.storage.presignGet(f.before.s3Key, 1800);
      const r = await fetch(`${this.aiUrl()}/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageUrl, floorType: f.floorType, priors: priorsDoc ?? undefined, detectorActive: yolo.active }),
      });
      if (!r.ok) continue;
      const res: any = await r.json();
      const counts: Record<string, number> = {};
      for (const pl of res.placements ?? []) counts[pl.deviceCode] = (counts[pl.deviceCode] ?? 0) + 1;
      f.prediction = { deviceCounts: counts, placements: (res.placements ?? []).map((p: any) => ({ deviceCode: p.deviceCode, position: p.position })),
        acceptedRooms: (res.rooms ?? []).length, qcSummary: res.qcSummary };
      await f.save(); n++;
    }
    await this.projects.updateOne({ _id: id, tenantId: user.tenantId }, { status: 'analyzed' });
    return { floorsAnalyzed: n };
  }

  /** Compare AI prediction vs engineer GT per floor and aggregate to project metrics. */
  async evaluateProject(user: AuthUser, id: string) {
    const floors = await this.samples.find({ tenantId: user.tenantId, projectId: id }).sort({ pageIndex: 1 });
    const projTruth: Record<string, number> = {}; const projPred: Record<string, number> = {};
    const perFloor: any[] = [];
    for (const f of floors) {
      const truth: Record<string, number> = {};
      for (const a of f.annotations ?? []) if (a.status !== 'false_positive') truth[a.deviceCode] = (truth[a.deviceCode] ?? 0) + 1;
      const pred: Record<string, number> = (f.prediction?.deviceCounts ?? {});
      const m = deviceCountMetrics(truth, pred);
      f.evalMetrics = m.micro; await f.save();
      for (const [c, v] of Object.entries(truth)) projTruth[c] = (projTruth[c] ?? 0) + (v as number);
      for (const [c, v] of Object.entries(pred)) if ((ENGINEER_DEVICE_CLASSES as readonly string[]).includes(c)) projPred[c] = (projPred[c] ?? 0) + (v as number);
      perFloor.push({ pageIndex: f.pageIndex, floorType: f.floorType, ...m.micro });
    }
    const projectMetrics = deviceCountMetrics(projTruth, projPred);
    await this.projects.updateOne({ _id: id, tenantId: user.tenantId }, { status: 'evaluated', metrics: projectMetrics.micro });
    return { project: projectMetrics, perFloor };
  }

  // ── Learned priors (now floor-aware: per room-type AND per floor-type) ──────--
  async recomputePriors(user: AuthUser) {
    const samples = await this.samples.find({ tenantId: user.tenantId })
      .select('annotations floorType').lean();
    // perSpace priors from annotations (spaceTypeHint where available).
    const priors = learnPriors(samples.map((s: any) => ({ annotations: s.annotations ?? [] })));
    // perFloorType priors: device counts per floor type (drives roof-exclusion / site-access).
    const perFloorType: Record<string, Record<string, number>> = {};
    for (const s of samples as any[]) {
      const ft = s.floorType ?? 'unknown';
      for (const a of s.annotations ?? []) {
        if (a.status === 'false_positive') continue;
        (perFloorType[ft] ??= {})[a.deviceCode] = (perFloorType[ft]?.[a.deviceCode] ?? 0) + 1;
      }
    }
    const version = ((await this.priors.findOne({ tenantId: user.tenantId }).sort({ version: -1 }).lean() as any)?.version ?? 0) + 1;
    const doc = await this.priors.create({
      tenantId: user.tenantId, version, sampleN: priors.sampleN,
      perSpace: { ...priors.perSpace, _perFloorType: perFloorType } as any, createdBy: user.id,
    });
    return { version, sampleN: priors.sampleN, spaceTypes: Object.keys(priors.perSpace).length,
      floorTypes: Object.keys(perFloorType), priors: doc.perSpace };
  }

  async getPriors(user: AuthUser) {
    return (await this.priors.findOne({ tenantId: user.tenantId }).sort({ version: -1 }).lean()) ?? { perSpace: {}, sampleN: 0 };
  }

  // ── Models + promotion ─────────────────────────────────────────────────────
  async createModel(user: AuthUser, dto: { datasetId?: string; baseModel?: string; notes?: string }) {
    const version = (await this.models.countDocuments({ tenantId: user.tenantId })) + 1;
    return this.models.create({ tenantId: user.tenantId, version, datasetId: dto.datasetId, baseModel: dto.baseModel ?? 'yolo11n', notes: dto.notes, status: 'draft', trainedBy: user.id });
  }
  listModels(user: AuthUser) { return this.models.find({ tenantId: user.tenantId }).sort({ version: -1 }).lean(); }

  async setModelStatus(user: AuthUser, id: string, status: ModelStatus, notes?: string) {
    const m = await this.models.findOne({ _id: id, tenantId: user.tenantId });
    if (!m) throw new NotFoundException('Model not found');
    if (!canTransition(m.status, status)) throw new BadRequestException(`Cannot move model from ${m.status} → ${status}`);
    // Only one production model per tenant.
    if (status === 'production') {
      await this.models.updateMany({ tenantId: user.tenantId, status: 'production' }, { status: 'archived' });
      m.approvedBy = user.id;
    }
    m.status = status; if (notes) m.notes = notes;
    await m.save();
    return { id: String(m._id), status: m.status };
  }

  async trainModel(user: AuthUser, id: string) {
    const m = await this.models.findOne({ _id: id, tenantId: user.tenantId });
    if (!m) throw new NotFoundException('Model not found');
    if (!canTransition(m.status, 'training')) throw new BadRequestException(`Model is ${m.status}; cannot start training`);
    m.status = 'training'; await m.save();
    // Training runs on a GPU worker (ultralytics). Dataset manifest + data.yaml are in S3;
    // services/ai/training/train.py consumes them. Enqueue wiring is environment-specific.
    return { id: String(m._id), status: 'training', note: 'Queued — requires a GPU training worker (see services/ai/training/train.py).' };
  }

  // ── Evaluation (ground-truth summary; full pipeline eval via run_eval.py) ────
  async evalSample(user: AuthUser, id: string) {
    const s = await this.samples.findOne({ _id: id, tenantId: user.tenantId }).lean() as any;
    if (!s) throw new NotFoundException('Training sample not found');
    const truth: Record<string, number> = {};
    const bySpace: Record<string, Record<string, number>> = {};
    for (const a of (s.annotations ?? []) as any[]) {
      if (a.status === 'false_positive') continue;
      truth[a.deviceCode] = (truth[a.deviceCode] ?? 0) + 1;
      const sp = a.spaceTypeHint || 'unknown';
      (bySpace[sp] ??= {})[a.deviceCode] = (bySpace[sp]?.[a.deviceCode] ?? 0) + 1;
    }
    return {
      sampleId: id, name: s.name,
      groundTruthByClass: truth,
      groundTruthBySpace: bySpace,
      totalDevices: Object.values(truth).reduce((a, b) => a + b, 0),
      note: 'Full rule-engine-vs-ground-truth precision/recall runs offline via services/ai/eval/run_eval.py --sample.',
    };
  }

  // ── Feedback loop ────────────────────────────────────────────────────────--
  recordFeedback(user: AuthUser, dto: any) {
    return this.feedback.create({ ...dto, tenantId: user.tenantId, userId: user.id, at: new Date() });
  }

  async feedbackStats(user: AuthUser) {
    const all = await this.feedback.find({ tenantId: user.tenantId }).select('deviceCode action').lean();
    const stats: Record<string, Record<string, number>> = {};
    for (const f of all as any[]) {
      (stats[f.deviceCode] ??= {})[f.action] = (stats[f.deviceCode]?.[f.action] ?? 0) + 1;
    }
    const perDevice = Object.entries(stats).map(([code, actions]) => {
      const acc = actions.accepted ?? 0; const rej = (actions.rejected ?? 0) + (actions.deleted ?? 0);
      const tot = acc + rej;
      return { deviceCode: code, accepted: acc, rejected: rej, moved: actions.moved ?? 0, acceptRate: tot ? +(acc / tot).toFixed(2) : null };
    });
    return { total: all.length, perDevice };
  }
}

@ApiTags('training') @ApiBearerAuth()
@Roles('admin')
@Controller('training')
export class TrainingController {
  constructor(private svc: TrainingService) {}

  @Post('samples') @UsePipes(new ZodValidationPipe(createSampleSchema))
  create(@CurrentUser() u: AuthUser, @Body() b: any) { return this.svc.createSample(u, b); }
  @Get('samples') list(@CurrentUser() u: AuthUser) { return this.svc.listSamples(u); }
  @Get('samples/:id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.getSample(u, id); }
  @Patch('samples/:id') @UsePipes(new ZodValidationPipe(updateSampleSchema))
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) { return this.svc.updateSample(u, id, b); }
  @Delete('samples/:id') del(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.deleteSample(u, id); }

  @Post('samples/:id/upload-url') @UsePipes(new ZodValidationPipe(uploadRoleSchema))
  uploadUrl(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) { return this.svc.uploadUrl(u, id, b); }
  @Post('samples/:id/complete') complete(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) { return this.svc.complete(u, id, b); }
  @Post('samples/:id/extract') extract(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.extract(u, id); }

  @Post('samples/:id/annotations') @UsePipes(new ZodValidationPipe(saveAnnotationsSchema))
  saveAnno(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) { return this.svc.saveAnnotations(u, id, b.annotations); }
  @Post('eval/:id') evalSample(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.evalSample(u, id); }

  @Post('datasets/export') @UsePipes(new ZodValidationPipe(exportDatasetSchema))
  exportDs(@CurrentUser() u: AuthUser, @Body() b: any) { return this.svc.exportDataset(u, b); }
  @Get('datasets') datasets(@CurrentUser() u: AuthUser) { return this.svc.listDatasets(u); }

  // ── Multi-floor training projects ──
  @Post('projects/import') importProjects(@CurrentUser() u: AuthUser, @Body() b: any) { return this.svc.importProjects(u, b ?? {}); }
  @Get('projects') projects(@CurrentUser() u: AuthUser) { return this.svc.listProjects(u); }
  @Get('projects/:id') project(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.getProject(u, id); }
  @Post('projects/:id/run-ai') runAi(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.runProjectAI(u, id); }
  @Post('projects/:id/evaluate') evaluate(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.evaluateProject(u, id); }
  @Patch('projects/:id/floors/:sid') setFloorType(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('sid') sid: string, @Body() b: any) { return this.svc.setFloorType(u, sid, b?.floorType); }

  @Get('yolo/status') yolo(@CurrentUser() u: AuthUser) { return this.svc.yoloStatus(u); }

  @Post('priors/recompute') recompute(@CurrentUser() u: AuthUser) { return this.svc.recomputePriors(u); }
  @Get('priors') priors(@CurrentUser() u: AuthUser) { return this.svc.getPriors(u); }

  @Post('models') createModel(@CurrentUser() u: AuthUser, @Body() b: any) { return this.svc.createModel(u, b ?? {}); }
  @Get('models') models(@CurrentUser() u: AuthUser) { return this.svc.listModels(u); }
  @Patch('models/:id/status') @UsePipes(new ZodValidationPipe(modelStatusSchema))
  setStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) { return this.svc.setModelStatus(u, id, b.status, b.notes); }
  @Post('models/:id/train') train(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.trainModel(u, id); }

  @Post('feedback') @UsePipes(new ZodValidationPipe(feedbackSchema))
  feedback(@CurrentUser() u: AuthUser, @Body() b: any) { return this.svc.recordFeedback(u, b); }
  @Get('feedback/stats') feedbackStats(@CurrentUser() u: AuthUser) { return this.svc.feedbackStats(u); }
}

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.TrainingProject, schema: TrainingProjectSchema },
    { name: MODELS.TrainingSample, schema: TrainingSampleSchema },
    { name: MODELS.TrainingDataset, schema: TrainingDatasetSchema },
    { name: MODELS.ModelVersion, schema: ModelVersionSchema },
    { name: MODELS.PlacementPriors, schema: PlacementPriorsSchema },
    { name: MODELS.PlacementFeedback, schema: PlacementFeedbackSchema },
  ])],
  controllers: [TrainingController],
  providers: [TrainingService],
})
export class TrainingModule {}
