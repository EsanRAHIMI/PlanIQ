import { Module, Injectable, Controller, Get, Patch, Post, Query, Param, Body, Inject } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import {
  MODELS, AuditLogSchema, SettingSchema, UserSchema, ProjectSchema, TenantSchema,
} from '../../db/schemas';
import { CurrentUser, AuthUser, Roles } from '../../common/decorators';
import { ANALYSIS_QUEUE } from '../queue/queue.module';

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
    @Inject(ANALYSIS_QUEUE) private queue: Queue,
  ) {}

  async stats(user: AuthUser) {
    const scope = user.globalRole === 'superadmin' ? {} : { tenantId: user.tenantId };
    const [users, projects, tenants, counts] = await Promise.all([
      this.users.countDocuments(scope),
      this.projects.countDocuments(scope),
      user.globalRole === 'superadmin' ? this.tenants.countDocuments({}) : 1,
      this.queue.getJobCounts('active', 'waiting', 'completed', 'failed'),
    ]);
    return { users, projects, tenants, jobs: counts };
  }

  async getSettings(user: AuthUser) {
    return this.settings.find({ $or: [{ scope: 'system' }, { scope: 'tenant', tenantId: user.tenantId }] }).lean();
  }
  async setSetting(user: AuthUser, key: string, value: any) {
    return this.settings.findOneAndUpdate(
      { scope: 'tenant', tenantId: user.tenantId, key }, { value }, { upsert: true, new: true });
  }
  async retryJob(id: string) { const j = await this.queue.getJob(id); if (j) await j.retry(); return { ok: !!j }; }
}

@ApiTags('admin') @ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService, private audit: AuditService) {}
  @Get('stats') @Roles('admin') stats(@CurrentUser() u: AuthUser) { return this.admin.stats(u); }
  @Get('audit-logs') @Roles('admin') logs(@CurrentUser() u: AuthUser, @Query('page') p = 1, @Query('limit') l = 50) { return this.audit.list(u.tenantId, +p, +l); }
  @Get('settings') @Roles('admin') settings(@CurrentUser() u: AuthUser) { return this.admin.getSettings(u); }
  @Patch('settings') @Roles('admin') setSetting(@CurrentUser() u: AuthUser, @Body() b: { key: string; value: any }) { return this.admin.setSetting(u, b.key, b.value); }
  @Post('jobs/:id/retry') @Roles('admin') retry(@Param('id') id: string) { return this.admin.retryJob(id); }
}

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.AuditLog, schema: AuditLogSchema },
    { name: MODELS.Setting, schema: SettingSchema },
    { name: MODELS.User, schema: UserSchema },
    { name: MODELS.Project, schema: ProjectSchema },
    { name: MODELS.Tenant, schema: TenantSchema },
  ])],
  controllers: [AdminController],
  providers: [AdminService, AuditService],
  exports: [AuditService],
})
export class AdminModule {}
