import { Module, Injectable, Controller, Get, Post, Param, Body, Inject, NotFoundException } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import { MODELS, ExportSchema } from '../../db/schemas';
import { EXPORT_QUEUE } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import { CurrentUser, AuthUser } from '../../common/decorators';

@Injectable()
export class ExportsService {
  constructor(
    @InjectModel(MODELS.Export) private exports: Model<any>,
    @Inject(EXPORT_QUEUE) private queue: Queue,
    private storage: StorageService,
  ) {}

  async create(user: AuthUser, projectId: string, options: any) {
    const exp = await this.exports.create({
      tenantId: user.tenantId, projectId, status: 'queued', createdBy: user.id,
      options: { includeLegend: true, includeSchedule: true, ...options },
    });
    const job = await this.queue.add('export', { exportId: String(exp._id), projectId, tenantId: user.tenantId }, { attempts: 2 });
    exp.jobId = job.id; await exp.save();
    return { exportId: exp._id, jobId: job.id, status: 'queued' };
  }

  list(user: AuthUser, projectId: string) {
    return this.exports.find({ projectId, tenantId: user.tenantId }).sort({ createdAt: -1 }).lean();
  }

  async get(user: AuthUser, id: string) {
    const exp = await this.exports.findOne({ _id: id, tenantId: user.tenantId }).lean();
    if (!exp) throw new NotFoundException();
    const downloadUrl = exp.s3Key ? await this.storage.presignGet(exp.s3Key) : null;
    return { ...exp, downloadUrl };
  }
}

@ApiTags('exports') @ApiBearerAuth()
@Controller()
export class ExportsController {
  constructor(private svc: ExportsService) {}
  @Post('projects/:projectId/export') create(@CurrentUser() u: AuthUser, @Param('projectId') p: string, @Body() b: any) { return this.svc.create(u, p, b ?? {}); }
  @Get('projects/:projectId/exports') list(@CurrentUser() u: AuthUser, @Param('projectId') p: string) { return this.svc.list(u, p); }
  @Get('exports/:id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.get(u, id); }
}

@Module({
  imports: [MongooseModule.forFeature([{ name: MODELS.Export, schema: ExportSchema }])],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
