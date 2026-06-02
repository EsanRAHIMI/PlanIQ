import { Module, Injectable, Controller, Get, Post, Param, Body, NotFoundException } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { MODELS, VersionSchema, PlacementSchema, DetectedRoomSchema, DetectedZoneSchema, FloorSchema } from '../../db/schemas';
import { CurrentUser, AuthUser } from '../../common/decorators';

@Injectable()
export class VersionsService {
  constructor(
    @InjectModel(MODELS.Version) private versions: Model<any>,
    @InjectModel(MODELS.Placement) private placements: Model<any>,
    @InjectModel(MODELS.DetectedRoom) private rooms: Model<any>,
    @InjectModel(MODELS.DetectedZone) private zones: Model<any>,
    @InjectModel(MODELS.Floor) private floors: Model<any>,
  ) {}

  list(user: AuthUser, floorId: string) {
    return this.versions.find({ floorId, tenantId: user.tenantId }).sort({ number: -1 }).select('-snapshot').lean();
  }

  async snapshot(user: AuthUser, floorId: string, body: { label?: string; note?: string }) {
    const floor = await this.floors.findById(floorId).lean();
    if (!floor) throw new NotFoundException();
    const [placements, rooms, zones, last] = await Promise.all([
      this.placements.find({ floorId }).lean(),
      this.rooms.find({ floorId }).lean(),
      this.zones.find({ floorId }).lean(),
      this.versions.findOne({ floorId }).sort({ number: -1 }).lean(),
    ]);
    return this.versions.create({
      tenantId: user.tenantId, floorId, projectId: floor.projectId,
      number: (last?.number ?? 0) + 1, label: body.label, note: body.note, createdBy: user.id,
      snapshot: { placements, rooms, zones },
    });
  }

  get(user: AuthUser, id: string) { return this.versions.findOne({ _id: id, tenantId: user.tenantId }).lean(); }

  async restore(user: AuthUser, id: string) {
    const v = await this.versions.findOne({ _id: id, tenantId: user.tenantId }).lean();
    if (!v) throw new NotFoundException();
    await this.snapshot(user, String(v.floorId), { label: 'Auto-snapshot before restore' });
    await this.placements.deleteMany({ floorId: v.floorId });
    if (v.snapshot.placements?.length) {
      await this.placements.insertMany(v.snapshot.placements.map((p: any) => ({ ...p, _id: undefined })));
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
  ])],
  controllers: [VersionsController],
  providers: [VersionsService],
})
export class VersionsModule {}
