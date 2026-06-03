import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Param, Body, UsePipes, Inject, Res, Sse, NotFoundException,
} from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Observable, interval, map, switchMap, from } from 'rxjs';
import {
  AI_SETTINGS_KEY, normalizeAiSettings, type AiCapabilities,
  createRoomSchema, updateRoomSchema,
} from '@planiq/shared';
import { MODELS, FloorSchema, DetectedRoomSchema, DetectedZoneSchema, SettingSchema } from '../../db/schemas';
import { ANALYSIS_QUEUE, REDIS } from '../queue/queue.module';
import { AiModule } from '../ai/ai.module';
import { AiService } from '../ai/ai.service';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, AuthUser } from '../../common/decorators';

/** A square box (normalized) around a centroid — used when the user adds a space manually. */
function defaultBox(centroid: [number, number], half = 0.05): number[][] {
  const [cx, cy] = centroid;
  const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
  const x1 = Math.min(1, cx + half), y1 = Math.min(1, cy + half);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** Shoelace area of a normalized polygon (0..1 of plan area). */
function polygonArea(poly: number[][]): number {
  if (!poly || poly.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

const ROOM_LABELS: Record<string, string> = {
  bedroom: 'Bedroom', master_bedroom: 'Master Bedroom', maid_room: 'Maid Room', majlis: 'Majlis',
  living_room: 'Living Room', sitting_area: 'Sitting Area', dining: 'Dining', kitchen: 'Kitchen',
  corridor: 'Corridor', entrance: 'Entrance', main_door: 'Main Door', outdoor: 'Outdoor', garden: 'Garden',
  parking: 'Parking', gate: 'Gate', staircase: 'Staircase', lift: 'Lift', bathroom: 'Bathroom',
  store: 'Store', service_area: 'Service Area', roof: 'Roof',
};

@Injectable()
export class AnalysisService {
  constructor(
    @InjectModel(MODELS.Floor) private floors: Model<any>,
    @InjectModel(MODELS.DetectedRoom) private rooms: Model<any>,
    @InjectModel(MODELS.DetectedZone) private zones: Model<any>,
    @InjectModel(MODELS.Setting) private settings: Model<any>,
    @Inject(ANALYSIS_QUEUE) private queue: Queue,
    @Inject(REDIS) private redis: IORedis,
    private ai: AiService,
  ) {}

  async trigger(user: AuthUser, floorId: string, body: { force?: boolean; provider?: 'cv' | 'llm_fallback' }) {
    const floor = await this.floors.findOne({ _id: floorId, tenantId: user.tenantId });
    if (!floor) throw new NotFoundException('Floor not found');
    const job = await this.queue.add('analyze', {
      floorId, tenantId: user.tenantId, provider: body.provider ?? 'cv',
      triggeredBy: user.id,
    }, { attempts: 2 });
    floor.analysis = { ...floor.analysis, status: 'queued', jobId: job.id }; await floor.save();
    return { jobId: job.id };
  }

  async status(user: AuthUser, floorId: string) {
    const floor = await this.floors.findOne({ _id: floorId, tenantId: user.tenantId }).lean();
    if (!floor) throw new NotFoundException();
    return floor.analysis;
  }

  rooms_(user: AuthUser, floorId: string) { return this.rooms.find({ floorId, tenantId: user.tenantId }).sort({ area: -1 }).lean(); }
  zones_(user: AuthUser, floorId: string) { return this.zones.find({ floorId, tenantId: user.tenantId }).lean(); }

  /** Create a space the AI missed. Manual spaces are user-owned and survive re-analysis. */
  async createRoom(user: AuthUser, floorId: string, dto: any) {
    const floor = await this.floors.findOne({ _id: floorId, tenantId: user.tenantId }).lean();
    if (!floor) throw new NotFoundException('Floor not found');
    const centroid = (dto.centroid as [number, number]) ?? [0.5, 0.5];
    const polygon = dto.polygon ?? defaultBox(centroid);
    return this.rooms.create({
      tenantId: user.tenantId,
      floorId,
      label: dto.label ?? ROOM_LABELS[dto.type] ?? dto.type,
      type: dto.type,
      polygon,
      centroid,
      area: typeof dto.area === 'number' ? dto.area : (polygonArea(polygon) || 0.04),
      confidence: 1,
      source: 'manual',
      reviewStatus: 'accepted',
      reviewed: true,
      aiType: null,
      aiConfidence: null,
      rejectionReason: null,
      reviewedBy: user.id,
      reviewedAt: new Date(),
    });
  }

  /** Edit a space: change type (→ user_corrected, original AI type preserved), accept/reject,
   * rename, or move/reshape. Keeps AI output separate from the user-reviewed state. */
  async updateRoom(user: AuthUser, id: string, dto: any) {
    const room = await this.rooms.findOne({ _id: id, tenantId: user.tenantId });
    if (!room) throw new NotFoundException('Space not found');
    const patch: Record<string, unknown> = { reviewedBy: user.id, reviewedAt: new Date(), reviewed: true };

    if (dto.label !== undefined) patch.label = dto.label;
    if (dto.centroid) patch.centroid = dto.centroid;
    if (dto.polygon) { patch.polygon = dto.polygon; patch.area = polygonArea(dto.polygon) || room.area; }

    if (dto.type && dto.type !== room.type) {
      patch.type = dto.type;
      if (room.aiType == null && room.source !== 'manual') patch.aiType = room.type; // preserve original AI class once
      patch.reviewStatus = 'user_corrected';
    }
    if (dto.reviewStatus) {
      patch.reviewStatus = dto.reviewStatus;
      if (dto.reviewStatus !== 'rejected') patch.rejectionReason = null;
    }
    return this.rooms.findOneAndUpdate({ _id: id, tenantId: user.tenantId }, patch, { new: true }).lean();
  }

  async removeRoom(user: AuthUser, id: string) {
    const res = await this.rooms.deleteOne({ _id: id, tenantId: user.tenantId });
    if (!res.deletedCount) throw new NotFoundException('Space not found');
    return { ok: true };
  }

  /** SSE progress: reads the latest progress published by the worker on redis key. */
  stream(floorId: string): Observable<MessageEvent> {
    return interval(1000).pipe(
      switchMap(() => from(this.redis.get(`analysis:progress:${floorId}`))),
      map((raw) => ({ data: raw ? JSON.parse(raw) : { stage: 'pending', pct: 0 } }) as MessageEvent),
    );
  }

  /** Editor-facing: which engines are available before the user clicks Run. */
  async capabilities(user: AuthUser): Promise<AiCapabilities> {
    const doc = await this.settings.findOne({ scope: 'tenant', tenantId: user.tenantId, key: AI_SETTINGS_KEY }).lean();
    const aiSettings = normalizeAiSettings((doc as any)?.value);
    const health = await this.ai.getHealthInfo();
    return {
      aiServiceOk: health.ok,
      yoloWeightsAvailable: !!health.weights,
      yoloWeightsPath: health.weights ?? null,
      fallbackProvider: aiSettings.fallbackProvider,
    };
  }
}

@ApiTags('analysis') @ApiBearerAuth()
@Controller()
export class AnalysisController {
  constructor(private svc: AnalysisService) {}

  @Post('floors/:floorId/analysis')
  trigger(@CurrentUser() u: AuthUser, @Param('floorId') f: string, @Body() b: any) { return this.svc.trigger(u, f, b ?? {}); }

  @Get('floors/:floorId/analysis')
  status(@CurrentUser() u: AuthUser, @Param('floorId') f: string) { return this.svc.status(u, f); }

  @Get('ai/capabilities')
  capabilities(@CurrentUser() u: AuthUser) { return this.svc.capabilities(u); }

  @Get('floors/:floorId/rooms')
  rooms(@CurrentUser() u: AuthUser, @Param('floorId') f: string) { return this.svc.rooms_(u, f); }

  @Post('floors/:floorId/rooms') @UsePipes(new ZodValidationPipe(createRoomSchema))
  createRoom(@CurrentUser() u: AuthUser, @Param('floorId') f: string, @Body() b: any) { return this.svc.createRoom(u, f, b); }

  @Patch('rooms/:id') @UsePipes(new ZodValidationPipe(updateRoomSchema))
  updateRoom(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) { return this.svc.updateRoom(u, id, b); }

  @Delete('rooms/:id')
  removeRoom(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.removeRoom(u, id); }

  @Get('floors/:floorId/zones')
  zones(@CurrentUser() u: AuthUser, @Param('floorId') f: string) { return this.svc.zones_(u, f); }

  @Sse('floors/:floorId/analysis/stream')
  stream(@Param('floorId') f: string) { return this.svc.stream(f); }
}

@Module({
  imports: [
    AiModule,
    MongooseModule.forFeature([
    { name: MODELS.Floor, schema: FloorSchema },
    { name: MODELS.DetectedRoom, schema: DetectedRoomSchema },
    { name: MODELS.DetectedZone, schema: DetectedZoneSchema },
    { name: MODELS.Setting, schema: SettingSchema },
  ])],
  controllers: [AnalysisController],
  providers: [AnalysisService],
})
export class AnalysisModule {}
