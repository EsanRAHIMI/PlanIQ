import { Module, Injectable, Controller, Get, Post, Param, Body, NotFoundException } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { MODELS, VersionSchema, PlacementSchema, DetectedRoomSchema, DetectedZoneSchema, FloorSchema, ProjectSchema } from '../../db/schemas';
import { CurrentUser, AuthUser } from '../../common/decorators';
import { assertProjectMember } from '../../common/project-access';

@Injectable()
export class VersionsService {
  constructor(
    @InjectModel(MODELS.Version) private versions: Model<any>,
    @InjectModel(MODELS.Placement) private placements: Model<any>,
    @InjectModel(MODELS.DetectedRoom) private rooms: Model<any>,
    @InjectModel(MODELS.DetectedZone) private zones: Model<any>,
    @InjectModel(MODELS.Floor) private floors: Model<any>,
    @InjectModel(MODELS.Project) private projects: Model<any>,
  ) {}

  private async assertFloor(user: AuthUser, floorId: string, min: 'viewer' | 'editor' | 'manager' = 'viewer') {
    const floor = await this.floors.findOne({ _id: floorId, tenantId: user.tenantId }).lean<any>();
    if (!floor) throw new NotFoundException('Floor not found');
    const project = await this.projects.findOne({ _id: floor.projectId, tenantId: user.tenantId }).lean<any>();
    if (!project) throw new NotFoundException('Project not found');
    assertProjectMember(user, project, min);
    return floor;
  }

  async list(user: AuthUser, floorId: string) {
    await this.assertFloor(user, floorId, 'viewer');
    return this.versions.find({ floorId, tenantId: user.tenantId }).sort({ number: -1 }).select('-snapshot').lean();
  }

  async snapshot(user: AuthUser, floorId: string, body: { label?: string; note?: string }) {
    const floor = await this.assertFloor(user, floorId, 'editor');
    const [placements, rooms, zones, last] = await Promise.all([
      this.placements.find({ floorId, tenantId: user.tenantId }).lean(),
      this.rooms.find({ floorId, tenantId: user.tenantId }).lean(),
      this.zones.find({ floorId, tenantId: user.tenantId }).lean(),
      this.versions.findOne({ floorId, tenantId: user.tenantId }).sort({ number: -1 }).lean<any>(),
    ]);
    return this.versions.create({
      tenantId: user.tenantId, floorId, projectId: floor.projectId,
      number: (last?.number ?? 0) + 1, label: body.label, note: body.note, createdBy: user.id,
      snapshot: { placements, rooms, zones },
    });
  }

  async get(user: AuthUser, id: string) {
    const v = await this.versions.findOne({ _id: id, tenantId: user.tenantId }).lean<any>();
    if (!v) throw new NotFoundException('Version not found');
    await this.assertFloor(user, String(v.floorId), 'viewer');
    return v;
  }

  async restore(user: AuthUser, id: string) {
    const v = await this.versions.findOne({ _id: id, tenantId: user.tenantId }).lean<any>();
    if (!v) throw new NotFoundException('Version not found');
    await this.assertFloor(user, String(v.floorId), 'editor');     // restore destroys current devices
    await this.snapshot(user, String(v.floorId), { label: 'Auto-snapshot before restore' });
    await this.placements.deleteMany({ floorId: v.floorId, tenantId: user.tenantId });
    if (v.snapshot.placements?.length) {
      await this.placements.insertMany(v.snapshot.placements.map((p: any) => ({ ...p, _id: undefined, tenantId: user.tenantId })));
    }
    return { ok: true, restored: v.number };
  }
}

@ApiTags('versions') @ApiBearerAuth()
@Controller()
export class VersionsController {
  constructor(private svc: VersionsService) {}
  @Get('floors/:floorId/versions') list(@CurrentUser() u: AuthUser, @Param('floorId') f: string) { return this.svc.list(u, f); }
  @Post('floors/:floorId/versions') snap(@CurrentUser() u: AuthUser, @Param('floorId') f: string, @Body() b: any) { return this.svc.snapshot(u, f, b ?? {}); }
  @Get('versions/:id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.get(u, id); }
  @Post('versions/:id/restore') restore(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.restore(u, id); }
}

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.Version, schema: VersionSchema },
    { name: MODELS.Placement, schema: PlacementSchema },
    { name: MODELS.DetectedRoom, schema: DetectedRoomSchema },
    { name: MODELS.DetectedZone, schema: DetectedZoneSchema },
    { name: MODELS.Floor, schema: FloorSchema },
    { name: MODELS.Project, schema: ProjectSchema },
  ])],
  controllers: [VersionsController],
  providers: [VersionsService],
})
export class VersionsModule {}
