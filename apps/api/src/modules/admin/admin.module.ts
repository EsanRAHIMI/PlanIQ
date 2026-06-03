import {
  Module, Injectable, Controller, Get, Patch, Post, Query, Param, Body, Inject,
  ForbiddenException, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { MongooseModule, InjectModel, InjectConnection } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model, Connection } from 'mongoose';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  AiSettings, GlobalRole, AI_SETTINGS_KEY, AI_SETTINGS_BOUNDS, FALLBACK_PROVIDERS, normalizeAiSettings,
} from '@planiq/shared';
import {
  MODELS, AuditLogSchema, SettingSchema, UserSchema, ProjectSchema, TenantSchema,
  FloorSchema, PlanAssetSchema, ExportSchema, PlacementSchema,
} from '../../db/schemas';
import { CurrentUser, AuthUser, Roles } from '../../common/decorators';
import { ANALYSIS_QUEUE, EXPORT_QUEUE, REDIS } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import { AiService } from '../ai/ai.service';

const ROLE_RANK: Record<GlobalRole, number> = { viewer: 0, editor: 1, manager: 2, admin: 3, superadmin: 4 };
const JOB_STATES = ['active', 'waiting', 'delayed', 'failed', 'completed'] as const;
type JobState = (typeof JOB_STATES)[number];

@Injectable()
export class AuditService {
  constructor(@InjectModel(MODELS.AuditLog) private logs: Model<any>) {}
  record(tenantId: string, actorId: string, action: string, target: any, diff?: any, ctx?: { ip?: string; ua?: string }) {
    return this.logs.create({ tenantId, actorId, action, target, diff, ip: ctx?.ip, userAgent: ctx?.ua });
  }
  list(tenantId: string, page = 1, limit = 50) {
    return this.logs.find({ tenantId }).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean();
  }
}

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(MODELS.User) private users: Model<any>,
    @InjectModel(MODELS.Project) private projects: Model<any>,
    @InjectModel(MODELS.Tenant) private tenants: Model<any>,
    @InjectModel(MODELS.Setting) private settings: Model<any>,
    @InjectModel(MODELS.Floor) private floors: Model<any>,
    @InjectModel(MODELS.PlanAsset) private assets: Model<any>,
    @InjectModel(MODELS.Export) private exports: Model<any>,
    @InjectModel(MODELS.Placement) private placements: Model<any>,
    @InjectConnection() private conn: Connection,
    @Inject(ANALYSIS_QUEUE) private analysisQueue: Queue,
    @Inject(EXPORT_QUEUE) private exportQueue: Queue,
    @Inject(REDIS) private redis: IORedis,
    private storage: StorageService,
    private ai: AiService,
    private audit: AuditService,
  ) {}

  private scope(user: AuthUser): Record<string, unknown> {
    return user.globalRole === 'superadmin' ? {} : { tenantId: user.tenantId };
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────
  async overview(user: AuthUser) {
    const s = this.scope(user);
    const aiBase = { ...s, source: 'ai' };
    const [
      users, projects, floors, uploads, exportsCount, placements,
      suggested, accepted, manual, tenants, jobsA, jobsE, rejectedCount,
    ] = await Promise.all([
      this.users.countDocuments(s),
      this.projects.countDocuments(s),
      this.floors.countDocuments(s),
      this.assets.countDocuments({ ...s, kind: 'source' }),
      this.exports.countDocuments(s),
      this.placements.countDocuments(s),
      this.placements.countDocuments(aiBase),
      this.placements.countDocuments({ ...aiBase, hidden: { $ne: true }, 'meta.qcStatus': { $ne: 'rejected' } }),
      this.placements.countDocuments({ ...s, source: 'manual' }),
      user.globalRole === 'superadmin' ? this.tenants.countDocuments({}) : Promise.resolve(1),
      this.analysisQueue.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed'),
      this.exportQueue.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed'),
      this.placements.countDocuments({ ...aiBase, $or: [{ hidden: true }, { 'meta.qcStatus': 'rejected' }] }),
    ]);
    const acceptanceRatio = suggested > 0 ? +(accepted / suggested).toFixed(3) : null;
    return {
      kpis: { users, tenants, projects, floors, uploads, exports: exportsCount, placements, manualPlacements: manual },
      ai: { suggested, accepted, rejected: rejectedCount, acceptanceRatio },
      jobs: { analysis: jobsA, export: jobsE },
    };
  }

  // ── Health ────────────────────────────────────────────────────────────────
  async health() {
    const [redisOk, aiOk, s3Ok, heartbeatRaw] = await Promise.all([
      this.redis.ping().then(() => true).catch(() => false),
      this.ai.health(),
      this.storage.health(),
      this.redis.get('worker:heartbeat').catch(() => null),
    ]);
    const mongoOk = this.conn.readyState === 1;
    let worker = { ok: false, lastBeatMs: null as number | null };
    if (heartbeatRaw) {
      try {
        const hb = JSON.parse(heartbeatRaw);
        const age = Date.now() - (hb.at ?? 0);
        worker = { ok: age < 60_000, lastBeatMs: age };
      } catch { /* ignore malformed heartbeat */ }
    }
    const services = { mongo: mongoOk, redis: redisOk, ai: aiOk, s3: s3Ok, worker: worker.ok };
    return { status: Object.values(services).every(Boolean) ? 'healthy' : 'degraded', services, worker };
  }

  // ── Queue / jobs ────────────────────────────────────────────────────────────
  private queueByName(name: string): Queue {
    if (name === 'export') return this.exportQueue;
    if (name === 'analysis') return this.analysisQueue;
    throw new BadRequestException('Unknown queue');
  }

  async jobs(user: AuthUser, queueName = 'analysis', state?: string, limit = 25) {
    const q = this.queueByName(queueName);
    const states = (state ? [state] : [...JOB_STATES]).filter((x) => (JOB_STATES as readonly string[]).includes(x)) as JobState[];
    const out: any[] = [];
    for (const st of states) {
      const jobs = await q.getJobs([st], 0, limit - 1);
      for (const j of jobs) {
        const data = j.data ?? {};
        if (user.globalRole !== 'superadmin' && data.tenantId && String(data.tenantId) !== String(user.tenantId)) continue;
        out.push({
          id: j.id, name: j.name, queue: queueName, state: st,
          floorId: data.floorId ?? null, projectId: data.projectId ?? null, exportId: data.exportId ?? null,
          attemptsMade: j.attemptsMade, failedReason: j.failedReason ?? null,
          timestamp: j.timestamp, processedOn: j.processedOn ?? null, finishedOn: j.finishedOn ?? null,
        });
      }
    }
    return out.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, limit);
  }

  async retryJob(user: AuthUser, queueName: string, id: string) {
    const q = this.queueByName(queueName);
    const job = await q.getJob(id);
    if (!job) throw new NotFoundException('Job not found');
    if (user.globalRole !== 'superadmin' && job.data?.tenantId && String(job.data.tenantId) !== String(user.tenantId)) {
      throw new ForbiddenException('Job belongs to another tenant');
    }
    await job.retry();
    await this.audit.record(user.tenantId, user.id, 'job.retry', { type: queueName, id });
    return { ok: true };
  }

  // ── Error monitoring ──────────────────────────────────────────────────────
  async errors(user: AuthUser) {
    const s = this.scope(user);
    const [floors, exports] = await Promise.all([
      this.floors.find({ ...s, 'analysis.status': 'failed' })
        .select('name projectId analysis.error analysis.finishedAt updatedAt').sort({ updatedAt: -1 }).limit(25).lean(),
      this.exports.find({ ...s, status: 'failed' })
        .select('projectId error createdAt updatedAt').sort({ updatedAt: -1 }).limit(25).lean(),
    ]);
    return {
      analysis: floors.map((f: any) => ({ id: String(f._id), name: f.name, projectId: f.projectId, error: f.analysis?.error, at: f.analysis?.finishedAt ?? f.updatedAt })),
      exports: exports.map((e: any) => ({ id: String(e._id), projectId: e.projectId, error: e.error, at: e.updatedAt ?? e.createdAt })),
    };
  }

  // ── User management ──────────────────────────────────────────────────────
  listUsers(user: AuthUser) {
    return this.users.find(this.scope(user)).select('-passwordHash -mfa').sort({ createdAt: -1 }).limit(200).lean();
  }

  async updateUser(actor: AuthUser, id: string, patch: { status?: string; globalRole?: GlobalRole }) {
    const filter = actor.globalRole === 'superadmin' ? { _id: id } : { _id: id, tenantId: actor.tenantId };
    const target = await this.users.findOne(filter);
    if (!target) throw new NotFoundException('User not found');
    if (String(target._id) === actor.id) throw new ForbiddenException('You cannot modify your own account');

    const before = { status: target.status, globalRole: target.globalRole };
    if (patch.status) {
      if (!['active', 'suspended'].includes(patch.status)) throw new BadRequestException('Invalid status');
      target.status = patch.status;
    }
    if (patch.globalRole) {
      if (!(patch.globalRole in ROLE_RANK)) throw new BadRequestException('Invalid role');
      if (ROLE_RANK[patch.globalRole] > ROLE_RANK[actor.globalRole]) {
        throw new ForbiddenException('Cannot grant a role above your own');
      }
      target.globalRole = patch.globalRole;
    }
    await target.save();
    await this.audit.record(actor.tenantId, actor.id, 'user.update', { type: 'user', id }, { before, after: { status: target.status, globalRole: target.globalRole } });
    const obj = target.toObject(); delete obj.passwordHash; delete obj.mfa;
    return obj;
  }

  // ── Tenant management (superadmin) ──────────────────────────────────────────
  async listTenants(user: AuthUser) {
    if (user.globalRole !== 'superadmin') throw new ForbiddenException('Superadmin only');
    const tenants = await this.tenants.find({}).sort({ createdAt: -1 }).lean();
    return Promise.all(tenants.map(async (t: any) => ({
      ...t,
      counts: {
        users: await this.users.countDocuments({ tenantId: t._id }),
        projects: await this.projects.countDocuments({ tenantId: t._id }),
      },
    })));
  }

  // ── AI / QC settings ──────────────────────────────────────────────────────
  async getAiSettings(user: AuthUser): Promise<AiSettings> {
    const doc = await this.settings.findOne({ scope: 'tenant', tenantId: user.tenantId, key: AI_SETTINGS_KEY }).lean<any>();
    return normalizeAiSettings(doc?.value);
  }

  async setAiSettings(user: AuthUser, patch: Partial<AiSettings>) {
    const current = await this.getAiSettings(user);
    // Surface clearly-invalid input rather than silently clamping.
    for (const [k, bounds] of Object.entries(AI_SETTINGS_BOUNDS)) {
      const v = (patch as any)[k];
      if (v != null && (typeof v !== 'number' || v < bounds[0] || v > bounds[1])) {
        throw new BadRequestException(`${k} must be a number in [${bounds[0]}, ${bounds[1]}]`);
      }
    }
    if (patch.fallbackProvider && !FALLBACK_PROVIDERS.includes(patch.fallbackProvider)) {
      throw new BadRequestException('Invalid fallbackProvider');
    }
    const next = normalizeAiSettings({ ...current, ...patch });
    await this.settings.findOneAndUpdate(
      { scope: 'tenant', tenantId: user.tenantId, key: AI_SETTINGS_KEY },
      { value: next }, { upsert: true, new: true },
    );
    await this.audit.record(user.tenantId, user.id, 'ai-settings.update', { type: 'setting', id: AI_SETTINGS_KEY }, { before: current, after: next });
    return next;
  }

  // ── Generic settings (kept) ──────────────────────────────────────────────
  getSettings(user: AuthUser) {
    return this.settings.find({ $or: [{ scope: 'system' }, { scope: 'tenant', tenantId: user.tenantId }] }).lean();
  }
  async setSetting(user: AuthUser, key: string, value: any) {
    const r = await this.settings.findOneAndUpdate(
      { scope: 'tenant', tenantId: user.tenantId, key }, { value }, { upsert: true, new: true });
    await this.audit.record(user.tenantId, user.id, 'setting.update', { type: 'setting', id: key }, { after: value });
    return r;
  }
}

@ApiTags('admin') @ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService, private audit: AuditService) {}

  @Get('overview') @Roles('admin') overview(@CurrentUser() u: AuthUser) { return this.admin.overview(u); }
  @Get('health') @Roles('admin') health() { return this.admin.health(); }

  @Get('jobs') @Roles('admin')
  jobs(@CurrentUser() u: AuthUser, @Query('queue') queue = 'analysis', @Query('state') state?: string) {
    return this.admin.jobs(u, queue, state);
  }
  @Post('jobs/:queue/:id/retry') @Roles('admin')
  retry(@CurrentUser() u: AuthUser, @Param('queue') queue: string, @Param('id') id: string) {
    return this.admin.retryJob(u, queue, id);
  }

  @Get('errors') @Roles('admin') errors(@CurrentUser() u: AuthUser) { return this.admin.errors(u); }

  @Get('users') @Roles('admin') users(@CurrentUser() u: AuthUser) { return this.admin.listUsers(u); }
  @Patch('users/:id') @Roles('admin')
  updateUser(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) { return this.admin.updateUser(u, id, b ?? {}); }

  @Get('tenants') @Roles('superadmin') tenants(@CurrentUser() u: AuthUser) { return this.admin.listTenants(u); }

  @Get('ai-settings') @Roles('admin') aiSettings(@CurrentUser() u: AuthUser) { return this.admin.getAiSettings(u); }
  @Patch('ai-settings') @Roles('admin') setAiSettings(@CurrentUser() u: AuthUser, @Body() b: any) { return this.admin.setAiSettings(u, b ?? {}); }

  @Get('audit-logs') @Roles('admin')
  logs(@CurrentUser() u: AuthUser, @Query('page') p = 1, @Query('limit') l = 50) { return this.audit.list(u.tenantId, +p, +l); }

  @Get('settings') @Roles('admin') settings(@CurrentUser() u: AuthUser) { return this.admin.getSettings(u); }
  @Patch('settings') @Roles('admin') setSetting(@CurrentUser() u: AuthUser, @Body() b: { key: string; value: any }) { return this.admin.setSetting(u, b.key, b.value); }
}

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.AuditLog, schema: AuditLogSchema },
    { name: MODELS.Setting, schema: SettingSchema },
    { name: MODELS.User, schema: UserSchema },
    { name: MODELS.Project, schema: ProjectSchema },
    { name: MODELS.Tenant, schema: TenantSchema },
    { name: MODELS.Floor, schema: FloorSchema },
    { name: MODELS.PlanAsset, schema: PlanAssetSchema },
    { name: MODELS.Export, schema: ExportSchema },
    { name: MODELS.Placement, schema: PlacementSchema },
  ])],
  controllers: [AdminController],
  providers: [AdminService, AuditService],
  exports: [AuditService],
})
export class AdminModule {}
