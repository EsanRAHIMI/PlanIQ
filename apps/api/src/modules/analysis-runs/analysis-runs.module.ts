import { Module, Injectable, Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { countsFromQcSummary, type AnalysisRunTrace } from '@planiq/shared';
import { MODELS, AnalysisRunSchema, FloorSchema, ProjectSchema } from '../../db/schemas';
import { CurrentUser, AuthUser, Roles } from '../../common/decorators';

function toTrace(doc: any, floor?: any, project?: any): AnalysisRunTrace {
  const qc = doc.qcSummary ?? null;
  const fromSummary = countsFromQcSummary(qc);
  return {
    id: String(doc._id),
    tenantId: String(doc.tenantId),
    projectId: String(doc.projectId),
    floorId: String(doc.floorId),
    floorName: floor?.name,
    projectName: project?.name,
    kind: doc.kind,
    status: doc.status,
    jobId: doc.jobId ?? null,
    triggeredBy: doc.triggeredBy ? String(doc.triggeredBy) : null,
    provider: doc.provider,
    modelName: doc.modelName ?? null,
    fallbackChain: doc.fallbackChain ?? [],
    qcSettings: doc.qcSettings ?? {},
    startedAt: doc.startedAt?.toISOString?.() ?? doc.startedAt,
    finishedAt: doc.finishedAt?.toISOString?.() ?? doc.finishedAt ?? null,
    durationMs: doc.durationMs ?? null,
    detectedSpaces: doc.detectedSpaces ?? fromSummary.detectedSpaces,
    acceptedSpaces: doc.acceptedSpaces ?? fromSummary.acceptedSpaces,
    rejectedSpaces: doc.rejectedSpaces ?? fromSummary.rejectedSpaces,
    acceptedDevices: doc.acceptedDevices ?? fromSummary.acceptedDevices,
    rejectedDevices: doc.rejectedDevices ?? fromSummary.rejectedDevices,
    qcSummary: qc,
    errors: doc.errors ?? [],
    warnings: doc.warnings ?? [],
  };
}

@Injectable()
export class AnalysisRunsService {
  constructor(
    @InjectModel(MODELS.AnalysisRun) private runs: Model<any>,
    @InjectModel(MODELS.Floor) private floors: Model<any>,
    @InjectModel(MODELS.Project) private projects: Model<any>,
  ) {}

  private scope(user: AuthUser): Record<string, unknown> {
    return user.globalRole === 'superadmin' ? {} : { tenantId: user.tenantId };
  }

  async listForFloor(user: AuthUser, floorId: string, limit = 20) {
    const floor = await this.floors.findOne({ _id: floorId, ...this.scope(user) }).lean();
    if (!floor) throw new NotFoundException('Floor not found');
    const project = await this.projects.findById(floor.projectId).select('name').lean();
    const docs = await this.runs.find({ floorId, ...this.scope(user) })
      .sort({ startedAt: -1 }).limit(limit).lean();
    return docs.map((d) => toTrace(d, floor, project));
  }

  async latestForFloor(user: AuthUser, floorId: string) {
    const list = await this.listForFloor(user, floorId, 1);
    return list[0] ?? null;
  }

  async getById(user: AuthUser, id: string) {
    const doc = await this.runs.findOne({ _id: id, ...this.scope(user) }).lean();
    if (!doc) throw new NotFoundException('Analysis run not found');
    const [floor, project] = await Promise.all([
      this.floors.findById(doc.floorId).select('name').lean(),
      this.projects.findById(doc.projectId).select('name').lean(),
    ]);
    return toTrace(doc, floor, project);
  }

  async listAdmin(user: AuthUser, limit = 50, floorId?: string) {
    const filter: any = { ...this.scope(user) };
    if (floorId) filter.floorId = floorId;
    const docs = await this.runs.find(filter).sort({ startedAt: -1 }).limit(limit).lean();
    const floorIds = [...new Set(docs.map((d) => String(d.floorId)))];
    const projectIds = [...new Set(docs.map((d) => String(d.projectId)))];
    const [floors, projects] = await Promise.all([
      this.floors.find({ _id: { $in: floorIds } }).select('name').lean(),
      this.projects.find({ _id: { $in: projectIds } }).select('name').lean(),
    ]);
    const floorMap = new Map(floors.map((f: any) => [String(f._id), f]));
    const projectMap = new Map(projects.map((p: any) => [String(p._id), p]));
    return docs.map((d) => toTrace(d, floorMap.get(String(d.floorId)), projectMap.get(String(d.projectId))));
  }
}

@ApiTags('analysis-runs') @ApiBearerAuth()
@Controller()
export class AnalysisRunsController {
  constructor(private svc: AnalysisRunsService) {}

  @Get('floors/:floorId/analysis/runs')
  listFloor(@CurrentUser() u: AuthUser, @Param('floorId') f: string) {
    return this.svc.listForFloor(u, f);
  }

  @Get('floors/:floorId/analysis/runs/latest')
  latestFloor(@CurrentUser() u: AuthUser, @Param('floorId') f: string) {
    return this.svc.latestForFloor(u, f);
  }

  @Get('analysis-runs/:id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.getById(u, id);
  }

  @Get('admin/analysis-runs') @Roles('admin')
  adminList(
    @CurrentUser() u: AuthUser,
    @Query('limit') limit = '50',
    @Query('floorId') floorId?: string,
  ) {
    return this.svc.listAdmin(u, Math.min(200, +limit || 50), floorId);
  }
}

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.AnalysisRun, schema: AnalysisRunSchema },
    { name: MODELS.Floor, schema: FloorSchema },
    { name: MODELS.Project, schema: ProjectSchema },
  ])],
  controllers: [AnalysisRunsController],
  providers: [AnalysisRunsService],
  exports: [AnalysisRunsService],
})
export class AnalysisRunsModule {}
