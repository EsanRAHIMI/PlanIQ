import { Module, Injectable, Controller, Get, Post, Patch, Delete, Param, Body, UsePipes, Query, NotFoundException, BadRequestException } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { batchPlacementSchema, suggestPlacements, DEFAULT_RULE_CONFIG, runQualityPipeline } from '@planiq/shared';
import { MODELS, PlacementSchema, LayerSchema, DetectedRoomSchema, DetectedZoneSchema, FloorSchema } from '../../db/schemas';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, AuthUser } from '../../common/decorators';

function normalizeRoom(r: any) {
  return {
    label: r.label ?? 'Space',
    rawLabel: r.rawLabel,
    type: r.type ?? 'corridor',
    polygon: r.polygon ?? [],
    centroid: Array.isArray(r.centroid) ? r.centroid : [0.5, 0.5],
    area: typeof r.area === 'number' ? r.area : 0.05,
    confidence: typeof r.confidence === 'number' ? r.confidence : 0.6,
    source: r.source ?? 'cv',
    reviewed: r.reviewed ?? false,
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

    const [roomsRaw, zonesRaw] = await Promise.all([
      this.rooms.find({ floorId, tenantId: user.tenantId }).lean(),
      this.zones.find({ floorId, tenantId: user.tenantId }).lean(),
    ]);

    if (!roomsRaw.length) {
      throw new BadRequestException(
        'No detected rooms on this floor. Upload a plan or run floor analysis before re-suggesting devices.',
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
    await this.floors.updateOne(
      { _id: floorId },
      { 'counts.placements': visibleCount, 'analysis.qcSummary': summary },
    );

    return {
      placements: persisted.map((doc: any) => ({
        ...doc.toObject?.() ?? doc,
        id: String(doc._id),
      })),
      summary,
      replaced: removed.deletedCount ?? 0,
      roomCount: rooms.length,
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
  ])],
  controllers: [PlacementsController],
  providers: [PlacementsService],
})
export class PlacementsModule {}
