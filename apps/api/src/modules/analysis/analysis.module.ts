import {
  Module, Injectable, Controller, Get, Post, Param, Body, Inject, Res, Sse, NotFoundException,
} from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Observable, interval, map, switchMap, from } from 'rxjs';
import { AI_SETTINGS_KEY, normalizeAiSettings, type AiCapabilities } from '@planiq/shared';
import { MODELS, FloorSchema, DetectedRoomSchema, DetectedZoneSchema, SettingSchema } from '../../db/schemas';
import { ANALYSIS_QUEUE, REDIS } from '../queue/queue.module';
import { AiModule } from '../ai/ai.module';
import { AiService } from '../ai/ai.service';
import { CurrentUser, AuthUser } from '../../common/decorators';

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

  rooms_(user: AuthUser, floorId: string) { return this.rooms.find({ floorId, tenantId: user.tenantId }).lean(); }
  zones_(user: AuthUser, floorId: string) { return this.zones.find({ floorId, tenantId: user.tenantId }).lean(); }

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
