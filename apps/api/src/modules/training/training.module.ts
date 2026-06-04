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
  type ModelStatus,
} from '@planiq/shared';
import { MODELS, TrainingSampleSchema, TrainingDatasetSchema, ModelVersionSchema, PlacementPriorsSchema, PlacementFeedbackSchema } from '../../db/schemas';
import { StorageService } from '../storage/storage.service';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, AuthUser, Roles } from '../../common/decorators';

const ALLOWED_MIME: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

@Injectable()
export class TrainingService {
  constructor(
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

  // ── Learned priors ───────────────────────────────────────────────────────--
  async recomputePriors(user: AuthUser) {
    const samples = await this.samples.find({ tenantId: user.tenantId }).select('annotations').lean();
    const priors = learnPriors(samples.map((s: any) => ({ annotations: s.annotations ?? [] })));
    const version = ((await this.priors.findOne({ tenantId: user.tenantId }).sort({ version: -1 }).lean() as any)?.version ?? 0) + 1;
    const doc = await this.priors.create({ tenantId: user.tenantId, version, sampleN: priors.sampleN, perSpace: priors.perSpace, createdBy: user.id });
    return { version, sampleN: priors.sampleN, spaceTypes: Object.keys(priors.perSpace).length, priors: doc.perSpace };
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
