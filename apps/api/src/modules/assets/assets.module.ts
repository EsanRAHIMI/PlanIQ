import {
  Module, Injectable, Controller, Post, Get, Param, Body, Inject,
  BadRequestException, NotFoundException, PayloadTooLargeException,
} from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import { MODELS, PlanAssetSchema, FloorSchema } from '../../db/schemas';
import { StorageService } from '../storage/storage.service';
import { ANALYSIS_QUEUE } from '../queue/queue.module';
import { CurrentUser, AuthUser } from '../../common/decorators';

const ALLOWED: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
};

@Injectable()
export class AssetsService {
  constructor(
    @InjectModel(MODELS.PlanAsset) private assets: Model<any>,
    @InjectModel(MODELS.Floor) private floors: Model<any>,
    private storage: StorageService,
    private config: ConfigService,
    @Inject(ANALYSIS_QUEUE) private queue: Queue,
  ) {}

  async createUploadUrl(user: AuthUser, projectId: string, dto: { fileName: string; mime: string; sizeBytes: number; floorId?: string }) {
    const ext = ALLOWED[dto.mime];
    if (!ext) throw new BadRequestException('Unsupported file type. Allowed: PDF, PNG, JPG');
    const maxBytes = (this.config.get('limits') as any).uploadMaxMb * 1024 * 1024;
    if (dto.sizeBytes > maxBytes) throw new PayloadTooLargeException(`Max upload size is ${(this.config.get('limits') as any).uploadMaxMb}MB`);

    const key = this.storage.key(user.tenantId, projectId, 'source', ext);
    const asset = await this.assets.create({
      tenantId: user.tenantId, projectId, floorId: dto.floorId, kind: 'source',
      originalName: dto.fileName, mime: dto.mime, ext, s3Key: key, sizeBytes: dto.sizeBytes, status: 'pending',
    });
    const uploadUrl = await this.storage.presignPut(key, dto.mime);
    return { assetId: asset._id, uploadUrl, s3Key: key, headers: { 'Content-Type': dto.mime } };
  }

  async complete(user: AuthUser, assetId: string) {
    const asset = await this.assets.findOne({ _id: assetId, tenantId: user.tenantId });
    if (!asset) throw new NotFoundException('Asset not found');
    if (!(await this.storage.exists(asset.s3Key))) throw new BadRequestException('Upload not found in storage');
    asset.status = 'uploaded'; await asset.save();

    // Enqueue processing: worker rasterizes pages → creates floors → enqueues per-floor analysis.
    const job = await this.queue.add('process', {
      assetId: String(asset._id), projectId: String(asset.projectId), tenantId: user.tenantId,
      floorId: asset.floorId ? String(asset.floorId) : undefined,
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

    return { assetId: asset._id, jobId: job.id, status: 'queued' };
  }

  async downloadUrl(user: AuthUser, assetId: string) {
    const asset = await this.assets.findOne({ _id: assetId, tenantId: user.tenantId });
    if (!asset) throw new NotFoundException();
    return { url: await this.storage.presignGet(asset.s3Key) };
  }

  async processingStatus(user: AuthUser, assetId: string) {
    const asset = await this.assets.findOne({ _id: assetId, tenantId: user.tenantId }).lean();
    if (!asset) throw new NotFoundException('Asset not found');

    const floors = await this.floors.find({ 'raster.assetId': asset._id }).sort({ level: 1 }).lean();
    const analysisStatuses = floors.map((f: any) => f.analysis?.status ?? 'none');
    const allAnalysisDone = floors.length > 0
      && analysisStatuses.every((s: string) => s === 'done' || s === 'failed');

    return {
      assetId: String(asset._id),
      status: asset.status,
      projectId: String(asset.projectId),
      processingComplete: asset.status === 'scanned',
      floors: floors.map((f: any) => ({
        id: String(f._id),
        name: f.name,
        analysisStatus: f.analysis?.status ?? 'none',
      })),
      allAnalysisDone,
    };
  }
}

@ApiTags('assets') @ApiBearerAuth()
@Controller()
export class AssetsController {
  constructor(private svc: AssetsService) {}

  @Post('projects/:projectId/floors/upload-url')
  uploadUrl(@CurrentUser() u: AuthUser, @Param('projectId') p: string, @Body() dto: any) {
    return this.svc.createUploadUrl(u, p, dto);
  }

  @Post('assets/:assetId/complete')
  complete(@CurrentUser() u: AuthUser, @Param('assetId') a: string) { return this.svc.complete(u, a); }

  @Get('assets/:assetId/status')
  status(@CurrentUser() u: AuthUser, @Param('assetId') a: string) { return this.svc.processingStatus(u, a); }

  @Get('assets/:assetId/download-url')
  download(@CurrentUser() u: AuthUser, @Param('assetId') a: string) { return this.svc.downloadUrl(u, a); }
}

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.PlanAsset, schema: PlanAssetSchema },
    { name: MODELS.Floor, schema: FloorSchema },
  ])],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
