import {
  Module, Injectable, Controller, Get, Post, Patch, Param, Body, Inject,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import {
  DEVICE_BY_CODE, CRITICAL_DEVICE_CODES, type DeliveryStatus,
  type ExportOptions, type ChecklistItem,
  PROJECT_STATUSES, canTransitionProject, deliveryMirror, projectStatusFromDelivery,
} from '@planiq/shared';
import {
  MODELS, ExportSchema, ProjectSchema, FloorSchema, PlacementSchema, UserSchema,
} from '../../db/schemas';
import { EXPORT_QUEUE } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import { CurrentUser, AuthUser } from '../../common/decorators';
import { assertProjectMember } from '../../common/project-access';

/** A device counts toward the deliverable when it's not hidden and not QC-rejected. */
const isDeliverable = (p: any) =>
  !p.hidden && p?.meta?.qcStatus !== 'rejected' && !(p.confidence != null && p.confidence < 0.62);

function sanitizeOptions(o: any): ExportOptions {
  const str = (v: any, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  return {
    floors: Array.isArray(o?.floors) ? o.floors.filter((x: any) => typeof x === 'string') : undefined,
    includeLegend: o?.includeLegend !== false,
    includeSchedule: o?.includeSchedule !== false,
    includeAiSummary: o?.includeAiSummary !== false,
    style: o?.style === 'detailed' ? 'detailed' : 'standard',
    clientName: str(o?.clientName, 200),
    preparedBy: str(o?.preparedBy, 200),
    notes: str(o?.notes, 4000),
    versionName: str(o?.versionName, 120),
  };
}

@Injectable()
export class ExportsService {
  constructor(
    @InjectModel(MODELS.Export) private exports: Model<any>,
    @InjectModel(MODELS.Project) private projects: Model<any>,
    @Inject(EXPORT_QUEUE) private queue: Queue,
    private storage: StorageService,
  ) {}

  async create(user: AuthUser, projectId: string, options: any) {
    const project = await this.projects.findOne({ _id: projectId, tenantId: user.tenantId }).lean();
    if (!project) throw new NotFoundException('Project not found');
    assertProjectMember(user, project as any, 'editor');
    const exp = await this.exports.create({
      tenantId: user.tenantId, projectId, status: 'queued', createdBy: user.id,
      options: sanitizeOptions(options),
    });
    const job = await this.queue.add('export', { exportId: String(exp._id), projectId, tenantId: user.tenantId }, { attempts: 2 });
    exp.jobId = job.id; await exp.save();
    return { exportId: exp._id, jobId: job.id, status: 'queued' };
  }

  list(user: AuthUser, projectId: string) {
    return this.exports.find({ projectId, tenantId: user.tenantId }).sort({ createdAt: -1 }).lean();
  }

  async get(user: AuthUser, id: string) {
    const exp = await this.exports.findOne({ _id: id, tenantId: user.tenantId }).lean<any>();
    if (!exp) throw new NotFoundException();
    const downloadUrl = exp.s3Key ? await this.storage.presignGet(exp.s3Key) : null;
    return { ...exp, downloadUrl };
  }
}

@Injectable()
export class DeliveryService {
  constructor(
    @InjectModel(MODELS.Project) private projects: Model<any>,
    @InjectModel(MODELS.Floor) private floors: Model<any>,
    @InjectModel(MODELS.Placement) private placements: Model<any>,
    @InjectModel(MODELS.Export) private exports: Model<any>,
    @InjectModel(MODELS.User) private users: Model<any>,
    private storage: StorageService,
  ) {}

  private async requireProject(user: AuthUser, projectId: string, min: 'viewer' | 'editor' | 'manager' = 'viewer') {
    const project = await this.projects.findOne({ _id: projectId, tenantId: user.tenantId }).lean<any>();
    if (!project) throw new NotFoundException('Project not found');
    assertProjectMember(user, project, min);
    return project;
  }

  /** Consolidated delivery view: summary, analytics, checklist, history, status. */
  async overview(user: AuthUser, projectId: string) {
    const project = await this.requireProject(user, projectId);
    const scope = { projectId, tenantId: user.tenantId };
    const [floors, placements, exportsRaw] = await Promise.all([
      this.floors.find(scope).sort({ level: 1 }).lean(),
      this.placements.find(scope).lean(),
      this.exports.find(scope).sort({ createdAt: -1 }).limit(20).lean(),
    ]);

    const deliverable = placements.filter(isDeliverable);

    // Per-floor info
    const byFloor = new Map<string, any[]>();
    deliverable.forEach((p: any) => {
      const k = String(p.floorId);
      if (!byFloor.has(k)) byFloor.set(k, []);
      byFloor.get(k)!.push(p);
    });
    const floorInfo = floors.map((f: any) => ({
      id: String(f._id), name: f.name, kind: f.kind, level: f.level,
      analysisStatus: f.analysis?.status ?? 'none',
      confidence: f.analysis?.confidence ?? null,
      rooms: f.counts?.rooms ?? 0,
      devices: (byFloor.get(String(f._id)) ?? []).length,
    }));

    // Device count by category
    const byCategory: Record<string, number> = {};
    deliverable.forEach((p: any) => {
      const cat = DEVICE_BY_CODE[p.deviceCode]?.category ?? 'other';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    });

    // AI confidence summary
    const doneFloors = floors.filter((f: any) => f.analysis?.status === 'done' && typeof f.analysis?.confidence === 'number');
    const avgConfidence = doneFloors.length
      ? +(doneFloors.reduce((s: number, f: any) => s + f.analysis.confidence, 0) / doneFloors.length).toFixed(3)
      : null;
    let acceptedSuggestions = 0, rejectedSuggestions = 0;
    floors.forEach((f: any) => {
      const q = f.analysis?.qcSummary;
      if (q) { acceptedSuggestions += q.acceptedPlacements ?? 0; rejectedSuggestions += q.rejectedPlacements ?? 0; }
    });

    // Last edited
    const placementEdited = placements.reduce((m: number, p: any) => Math.max(m, +new Date(p.updatedAt ?? 0)), 0);
    const lastEditedAt = new Date(Math.max(placementEdited, +new Date(project.updatedAt ?? 0))).toISOString();

    // Export status + history
    const userIds = [...new Set(exportsRaw.map((e: any) => String(e.createdBy)).filter(Boolean))];
    const usersById = new Map<string, string>(
      (await this.users.find({ _id: { $in: userIds } }).select('name').lean())
        .map((u: any) => [String(u._id), u.name]),
    );
    const history = await Promise.all(exportsRaw.map(async (e: any) => ({
      id: String(e._id),
      status: e.status,
      versionName: e.options?.versionName ?? null,
      style: e.options?.style ?? 'standard',
      floors: e.options?.floors?.length ?? floors.length,
      pages: e.pages ?? null,
      sizeBytes: e.sizeBytes ?? null,
      exportedBy: usersById.get(String(e.createdBy)) ?? null,
      createdAt: e.createdAt,
      finishedAt: e.finishedAt ?? null,
      error: e.error ?? null,
      downloadUrl: e.status === 'done' && e.s3Key ? await this.storage.presignGet(e.s3Key) : null,
    })));
    const latestExport = history[0] ?? null;

    return {
      summary: {
        name: project.name, code: project.code ?? null,
        client: project.client ?? null,
        floors: floors.length, devices: deliverable.length, lastEditedAt,
      },
      floors: floorInfo,
      deviceByCategory: byCategory,
      ai: { avgConfidence, acceptedSuggestions, rejectedSuggestions },
      exportStatus: latestExport?.status ?? null,
      // Derived from the single source of truth (project.status) — never read the raw
      // mirror, so even stale rows are corrected on read.
      lifecycleStatus: (project.status ?? 'draft'),
      deliveryStatus: deliveryMirror(project.status ?? 'draft') as DeliveryStatus,
      checklist: this.buildChecklist(floors, placements, deliverable, byFloor),
      history,
    };
  }

  private buildChecklist(floors: any[], placements: any[], deliverable: any[], byFloor: Map<string, any[]>): ChecklistItem[] {
    const items: ChecklistItem[] = [];

    const notDone = floors.filter((f: any) => f.analysis?.status !== 'done');
    items.push({
      id: 'analyzed',
      label: 'All floors analyzed',
      status: floors.length === 0 ? 'fail' : notDone.length === 0 ? 'pass' : 'warn',
      detail: floors.length === 0 ? 'No floors uploaded yet'
        : notDone.length ? `${notDone.length} floor(s) not analyzed: ${notDone.map((f: any) => f.name).join(', ')}` : undefined,
    });

    const failed = floors.filter((f: any) => f.analysis?.status === 'failed');
    items.push({
      id: 'no-failed',
      label: 'No failed AI jobs',
      status: failed.length === 0 ? 'pass' : 'fail',
      detail: failed.length ? `${failed.length} floor(s) failed analysis` : undefined,
    });

    const inFlight = floors.filter((f: any) => ['queued', 'processing'].includes(f.analysis?.status));
    items.push({
      id: 'saved',
      label: 'All edits saved (no analysis running)',
      status: inFlight.length === 0 ? 'pass' : 'warn',
      detail: inFlight.length ? `${inFlight.length} floor(s) still processing` : undefined,
    });

    const hiddenCritical = placements.filter((p: any) => p.hidden && CRITICAL_DEVICE_CODES.includes(p.deviceCode));
    items.push({
      id: 'hidden-critical',
      label: 'No hidden critical devices',
      status: hiddenCritical.length === 0 ? 'pass' : 'warn',
      detail: hiddenCritical.length ? `${hiddenCritical.length} critical device(s) hidden (CCTV/AP/rack/gate/lock)` : undefined,
    });

    const emptyFloors = floors.filter((f: any) => (byFloor.get(String(f._id)) ?? []).length === 0);
    items.push({
      id: 'count-sanity',
      label: 'Device count sanity check',
      status: deliverable.length === 0 ? 'fail' : emptyFloors.length ? 'warn' : 'pass',
      detail: deliverable.length === 0 ? 'No devices placed on any floor'
        : emptyFloors.length ? `${emptyFloors.length} floor(s) have no devices: ${emptyFloors.map((f: any) => f.name).join(', ')}` : undefined,
    });

    // Coverage: floors missing security (CCTV) or wireless (WIFI_AP)
    const coverageGaps: string[] = [];
    floors.forEach((f: any) => {
      if (f.kind === 'site') return;
      const pls = byFloor.get(String(f._id)) ?? [];
      const codes = new Set(pls.map((p: any) => p.deviceCode));
      const missing: string[] = [];
      if (!codes.has('CCTV') && !codes.has('CCTV_DOME')) missing.push('CCTV');
      if (!codes.has('WIFI_AP')) missing.push('Wi-Fi');
      if (missing.length) coverageGaps.push(`${f.name}: ${missing.join(' & ')}`);
    });
    items.push({
      id: 'coverage',
      label: 'Coverage warnings',
      status: coverageGaps.length === 0 ? 'pass' : 'warn',
      detail: coverageGaps.length ? `Possible gaps — ${coverageGaps.join('; ')}` : undefined,
    });

    return items;
  }

  /** Legacy delivery endpoint — now translates into the canonical project lifecycle so the
   * single source of truth (project.status) and the delivery mirror stay consistent.
   * Accepts either a canonical project status or a legacy delivery status. */
  async setStatus(user: AuthUser, projectId: string, status: string) {
    const project = await this.projects.findOne({ _id: projectId, tenantId: user.tenantId });
    if (!project) throw new NotFoundException('Project not found');
    assertProjectMember(user, project as any, 'manager');
    const canonical = (PROJECT_STATUSES as readonly string[]).includes(status)
      ? status : projectStatusFromDelivery(status);
    const from = project.status ?? 'draft';
    if (!canTransitionProject(from, canonical)) {
      throw new BadRequestException(`Cannot move project from "${from}" to "${canonical}"`);
    }
    const now = new Date();
    const prev = typeof project.delivery?.toObject === 'function' ? project.delivery.toObject() : (project.delivery ?? {});
    project.status = canonical;
    project.delivery = {
      ...prev, status: deliveryMirror(canonical), updatedBy: user.id, updatedAt: now,
      ...(canonical === 'delivered' ? { deliveredAt: now } : {}),
    };
    await project.save();
    return { ok: true, status: canonical, deliveryStatus: deliveryMirror(canonical) };
  }
}

@ApiTags('exports') @ApiBearerAuth()
@Controller()
export class ExportsController {
  constructor(private svc: ExportsService, private delivery: DeliveryService) {}
  @Post('projects/:projectId/export') create(@CurrentUser() u: AuthUser, @Param('projectId') p: string, @Body() b: any) { return this.svc.create(u, p, b ?? {}); }
  @Get('projects/:projectId/exports') list(@CurrentUser() u: AuthUser, @Param('projectId') p: string) { return this.svc.list(u, p); }
  @Get('exports/:id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.get(u, id); }

  @Get('projects/:projectId/delivery')
  overview(@CurrentUser() u: AuthUser, @Param('projectId') p: string) { return this.delivery.overview(u, p); }
  @Patch('projects/:projectId/delivery/status')
  setStatus(@CurrentUser() u: AuthUser, @Param('projectId') p: string, @Body() b: { status: string }) { return this.delivery.setStatus(u, p, b?.status); }
}

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.Export, schema: ExportSchema },
    { name: MODELS.Project, schema: ProjectSchema },
    { name: MODELS.Floor, schema: FloorSchema },
    { name: MODELS.Placement, schema: PlacementSchema },
    { name: MODELS.User, schema: UserSchema },
  ])],
  controllers: [ExportsController],
  providers: [ExportsService, DeliveryService],
})
export class ExportsModule {}
