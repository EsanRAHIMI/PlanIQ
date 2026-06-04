import { Module, Injectable, Controller, Get, Post, Patch, Delete, Param, Body, UsePipes, Query, NotFoundException, BadRequestException } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import {
  batchPlacementSchema, suggestPlacements, DEFAULT_RULE_CONFIG, runQualityPipeline,
  AI_SETTINGS_KEY, normalizeAiSettings, countsFromQcSummary,
} from '@planiq/shared';
import {
  MODELS, PlacementSchema, LayerSchema, DetectedRoomSchema, DetectedZoneSchema,
  FloorSchema, AnalysisRunSchema, SettingSchema,
} from '../../db/schemas';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, AuthUser } from '../../common/decorators';

function normalizeRoom(r: any) {
  // User-reviewed spaces (accepted / corrected / manual) are authoritative — bump their
  // confidence so the QC room filter keeps them rather than re-rejecting on stale CV scores.
  const userReviewed = r.source === 'manual' || r.reviewStatus === 'accepted' || r.reviewStatus === 'user_corrected';
  const conf = typeof r.confidence === 'number' ? r.confidence : 0.6;
  return {
    label: r.label ?? 'Space',
    rawLabel: r.rawLabel,
    type: r.type ?? 'corridor',
    polygon: r.polygon ?? [],
    centroid: Array.isArray(r.centroid) ? r.centroid : [0.5, 0.5],
    area: typeof r.area === 'number' ? r.area : 0.05,
    confidence: userReviewed ? Math.max(conf, 0.9) : conf,
    source: r.source ?? 'cv',
    reviewed: r.reviewed ?? userReviewed,
    meta: r.meta ?? {},   // carry doubleHeight etc. so the rule engine can honour it
  };
}

function normalizeZone(z: any) {
  return {
    type: z.type ?? 'outdoor',
    geometry: z.geometry ?? { kind: 'point', coords: [[0.5, 0.5]] },
    confidence: typeof z.confidence === 'number' ? z.confidence : 0.6,
    source: z.source ?? 'cv',
  };
}

@Injectable()
export class PlacementsService {
  constructor(
    @InjectModel(MODELS.Placement) private placements: Model<any>,
    @InjectModel(MODELS.Layer) private layers: Model<any>,
    @InjectModel(MODELS.DetectedRoom) private rooms: Model<any>,
    @InjectModel(MODELS.DetectedZone) private zones: Model<any>,
    @InjectModel(MODELS.Floor) private floors: Model<any>,
    @InjectModel(MODELS.AnalysisRun) private analysisRuns: Model<any>,
    @InjectModel(MODELS.Setting) private settings: Model<any>,
  ) {}

  async byFloor(user: AuthUser, floorId: string, debug = false) {
    const query: any = { floorId, tenantId: user.tenantId };
    const [allPlacements, layers, floor] = await Promise.all([
      this.placements.find(query).sort({ zIndex: 1 }).lean(),
      this.layers.find({ floorId, tenantId: user.tenantId }).sort({ order: 1 }).lean(),
      this.floors.findOne({ _id: floorId, tenantId: user.tenantId }).lean(),
    ]);
    const placements = debug
      ? allPlacements
      : allPlacements.filter((p: any) => !p.hidden && p.meta?.qcStatus !== 'rejected');
    return { placements, layers, qcSummary: floor?.analysis?.qcSummary ?? null, debug };
  }

  async create(user: AuthUser, floorId: string, dto: any) {
    const floor = await this.floors.findById(floorId).lean();
    return this.placements.create({ ...dto, floorId, tenantId: user.tenantId, projectId: floor?.projectId });
  }

  /** Batch upsert/delete — the editor's debounced autosave. */
  async batch(user: AuthUser, floorId: string, body: { upserts: any[]; deletes: string[] }) {
    const floor = await this.floors.findById(floorId).lean();
    const ops = body.upserts.map((p) => ({
      updateOne: {
        filter: { _id: p.id, tenantId: user.tenantId },
        update: { $set: { ...p, _id: undefined, floorId, tenantId: user.tenantId, projectId: floor?.projectId } },
        upsert: true,
      },
    }));
    if (ops.length) await this.placements.bulkWrite(ops as any);
    if (body.deletes?.length) await this.placements.deleteMany({ _id: { $in: body.deletes }, tenantId: user.tenantId });
    const count = await this.placements.countDocuments({ floorId });
    await this.floors.updateOne({ _id: floorId }, { 'counts.placements': count });
    return { ok: true, count };
  }

  async updateOne(user: AuthUser, id: string, dto: any) {
    return this.placements.findOneAndUpdate({ _id: id, tenantId: user.tenantId }, dto, { new: true });
  }

  async remove(user: AuthUser, id: string) {
    await this.placements.deleteOne({ _id: id, tenantId: user.tenantId });
    return { ok: true };
  }

  /** Re-run conservative rule engine + QC; replace unreviewed AI placements in DB. */
  async suggest(user: AuthUser, floorId: string) {
    const floor = await this.floors.findOne({ _id: floorId, tenantId: user.tenantId }).lean();
    if (!floor) throw new NotFoundException('Floor not found');

    const settingDoc = await this.settings.findOne({ scope: 'tenant', tenantId: user.tenantId, key: AI_SETTINGS_KEY }).lean();
    const aiSettings = normalizeAiSettings((settingDoc as any)?.value);
    const startedAt = new Date();
    const run = await this.analysisRuns.create({
      tenantId: user.tenantId,
      projectId: floor.projectId,
      floorId,
      kind: 'rules_resuggest',
      status: 'running',
      triggeredBy: user.id,
      provider: 'rules',
      modelName: '@planiq/shared rules + QC',
      fallbackChain: ['rules_engine', 'typescript_mirror'],
      qcSettings: aiSettings,
      startedAt,
    });

    // Re-suggest from the user's reviewed picture: only ACTIVE (non-rejected) spaces feed
    // the rule engine, so corrections and accept/reject decisions drive the placements.
    const [roomsRaw, zonesRaw] = await Promise.all([
      this.rooms.find({ floorId, tenantId: user.tenantId, reviewStatus: { $ne: 'rejected' } }).lean(),
      this.zones.find({ floorId, tenantId: user.tenantId }).lean(),
    ]);

    if (!roomsRaw.length) {
      const anyRooms = await this.rooms.countDocuments({ floorId, tenantId: user.tenantId });
      await this.analysisRuns.updateOne({ _id: run._id }, {
        status: 'failed',
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        errors: [anyRooms ? 'All spaces are rejected' : 'No detected rooms on this floor'],
      });
      throw new BadRequestException(
        anyRooms
          ? 'All spaces on this floor are rejected. Accept or add at least one space, then re-run suggestions.'
          : 'No detected spaces on this floor. Run Full AI Analysis or add spaces manually before re-suggesting devices.',
      );
    }

    const rooms = roomsRaw.map(normalizeRoom);
    const zones = zonesRaw.map(normalizeZone);
    const raw = suggestPlacements(rooms as any, zones as any, DEFAULT_RULE_CONFIG);
    const { placements, summary } = runQualityPipeline(rooms as any, zones as any, raw);
    const accepted = placements.filter((p) => !p.hidden);

    const removed = await this.placements.deleteMany({
      floorId, tenantId: user.tenantId, source: 'ai', reviewed: false,
    });

    let persisted: any[] = [];
    if (accepted.length) {
      const docs = accepted.map((p) => ({
        deviceCode: p.deviceCode,
        label: p.label,
        position: p.position,
        rotation: p.rotation ?? 0,
        scale: p.scale ?? 1,
        locked: p.locked ?? false,
        hidden: false,
        source: 'ai',
        reviewed: false,
        rationale: p.rationale,
        confidence: p.confidence,
        props: p.props ?? {},
        meta: p.meta ?? {},
        zIndex: p.zIndex ?? 0,
        floorId,
        tenantId: user.tenantId,
        projectId: floor.projectId,
      }));
      persisted = await this.placements.insertMany(docs);
    }

    const visibleCount = await this.placements.countDocuments({
      floorId, tenantId: user.tenantId, hidden: { $ne: true },
    });
    const counts = countsFromQcSummary(summary);
    const finishedAt = new Date();
    await this.analysisRuns.updateOne({ _id: run._id }, {
      status: 'done',
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      qcSummary: summary,
      ...counts,
      warnings: [],
      errors: [],
    });

    await this.floors.updateOne(
      { _id: floorId },
      { 'counts.placements': visibleCount, 'analysis.qcSummary': summary, 'analysis.latestRunId': run._id },
    );

    return {
      placements: persisted.map((doc: any) => ({
        ...doc.toObject?.() ?? doc,
        id: String(doc._id),
      })),
      summary,
      replaced: removed.deletedCount ?? 0,
      roomCount: rooms.length,
      analysisRun: {
        id: String(run._id),
        provider: 'rules',
        modelName: '@planiq/shared rules + QC',
        fallbackChain: ['rules_engine', 'typescript_mirror'],
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        ...counts,
      },
    };
  }
}

@ApiTags('placements') @ApiBearerAuth()
@Controller()
export class PlacementsController {
  constructor(private svc: PlacementsService) {}

  @Get('floors/:floorId/placements')
  list(@CurrentUser() u: AuthUser, @Param('floorId') f: string, @Query('debug') debug?: string) {
    return this.svc.byFloor(u, f, debug === '1' || debug === 'true');
  }

  @Post('floors/:floorId/placements')
  create(@CurrentUser() u: AuthUser, @Param('floorId') f: string, @Body() dto: any) { return this.svc.create(u, f, dto); }

  @Patch('floors/:floorId/placements') @UsePipes(new ZodValidationPipe(batchPlacementSchema))
  batch(@CurrentUser() u: AuthUser, @Param('floorId') f: string, @Body() body: any) { return this.svc.batch(u, f, body); }

  @Post('floors/:floorId/placements/suggest')
  suggest(@CurrentUser() u: AuthUser, @Param('floorId') f: string) { return this.svc.suggest(u, f); }

  @Patch('placements/:id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any) { return this.svc.updateOne(u, id, dto); }

  @Delete('placements/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.remove(u, id); }
}

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.Placement, schema: PlacementSchema },
    { name: MODELS.Layer, schema: LayerSchema },
    { name: MODELS.DetectedRoom, schema: DetectedRoomSchema },
    { name: MODELS.DetectedZone, schema: DetectedZoneSchema },
    { name: MODELS.Floor, schema: FloorSchema },
    { name: MODELS.AnalysisRun, schema: AnalysisRunSchema },
    { name: MODELS.Setting, schema: SettingSchema },
  ])],
  controllers: [PlacementsController],
  providers: [PlacementsService],
})
export class PlacementsModule {}
