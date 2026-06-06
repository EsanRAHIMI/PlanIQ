import { Module, Injectable, NotFoundException, Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { MODELS, FloorSchema, LayerSchema, ProjectSchema } from '../../db/schemas';
import { DEFAULT_LAYERS } from '@planiq/shared';
import { CurrentUser, AuthUser } from '../../common/decorators';
import { StorageService } from '../storage/storage.service';
import { assertProjectMember } from '../../common/project-access';

@Injectable()
export class FloorsService {
  constructor(
    @InjectModel(MODELS.Floor) private floors: Model<any>,
    @InjectModel(MODELS.Layer) private layers: Model<any>,
    @InjectModel(MODELS.Project) private projects: Model<any>,
    private storage: StorageService,
  ) {}

  private async assertProject(user: AuthUser, projectId: string, min: 'viewer' | 'editor' | 'manager' = 'viewer') {
    const project = await this.projects.findOne({ _id: projectId, tenantId: user.tenantId }).lean<any>();
    if (!project) throw new NotFoundException('Project not found');
    assertProjectMember(user, project, min);
    return project;
  }

  private async assertFloor(user: AuthUser, floorId: string, min: 'viewer' | 'editor' | 'manager' = 'viewer') {
    const floor = await this.floors.findOne({ _id: floorId, tenantId: user.tenantId }).lean<any>();
    if (!floor) throw new NotFoundException('Floor not found');
    await this.assertProject(user, String(floor.projectId), min);
    return floor;
  }

  async list(user: AuthUser, projectId: string) {
    await this.assertProject(user, projectId, 'viewer');
    return this.floors.find({ projectId, tenantId: user.tenantId }).sort({ level: 1 }).lean();
  }

  /** Floor doc + a presigned URL for its raster image (used by the editor). */
  async get(user: AuthUser, floorId: string) {
    const floor = await this.assertFloor(user, floorId, 'viewer');
    const rasterUrl = floor.raster?.key ? await this.storage.presignGet(floor.raster.key) : null;
    return { ...floor, rasterUrl };
  }

  async create(user: AuthUser, projectId: string, dto: { name: string; kind?: string; level?: number }) {
    await this.assertProject(user, projectId, 'editor');
    const floor = await this.floors.create({ ...dto, projectId, tenantId: user.tenantId });
    await this.seedLayers(user.tenantId, String(floor._id));
    return floor;
  }

  async seedLayers(tenantId: string, floorId: string) {
    const docs = DEFAULT_LAYERS.map((l, i) => ({ tenantId, floorId, name: l.name, color: l.color, order: i, visible: true }));
    await this.layers.insertMany(docs);
  }

  async update(user: AuthUser, floorId: string, dto: any) {
    await this.assertFloor(user, floorId, 'editor');
    const f = await this.floors.findOneAndUpdate({ _id: floorId, tenantId: user.tenantId }, dto, { new: true });
    if (!f) throw new NotFoundException('Floor not found');
    return f;
  }

  async remove(user: AuthUser, floorId: string) {
    await this.assertFloor(user, floorId, 'editor');
    const f = await this.floors.findOne({ _id: floorId, tenantId: user.tenantId });
    if (!f) throw new NotFoundException();
    f.deletedAt = new Date(); await f.save();
    return { ok: true };
  }
}

@ApiTags('floors') @ApiBearerAuth()
@Controller()
export class FloorsController {
  constructor(private svc: FloorsService) {}

  @Get('projects/:projectId/floors')
  list(@CurrentUser() u: AuthUser, @Param('projectId') p: string) { return this.svc.list(u, p); }

  @Get('floors/:floorId')
  get(@CurrentUser() u: AuthUser, @Param('floorId') f: string) { return this.svc.get(u, f); }

  @Post('projects/:projectId/floors')
  create(@CurrentUser() u: AuthUser, @Param('projectId') p: string, @Body() dto: any) { return this.svc.create(u, p, dto); }

  @Patch('floors/:floorId')
  update(@CurrentUser() u: AuthUser, @Param('floorId') f: string, @Body() dto: any) { return this.svc.update(u, f, dto); }

  @Delete('floors/:floorId')
  remove(@CurrentUser() u: AuthUser, @Param('floorId') f: string) { return this.svc.remove(u, f); }
}

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.Floor, schema: FloorSchema },
    { name: MODELS.Layer, schema: LayerSchema },
    { name: MODELS.Project, schema: ProjectSchema },
  ])],
  controllers: [FloorsController],
  providers: [FloorsService],
  exports: [FloorsService],
})
export class FloorsModule {}
