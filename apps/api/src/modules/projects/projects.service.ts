import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { canTransitionProject, deliveryMirror } from '@planiq/shared';
import { MODELS } from '../../db/schemas';
import type { AuthUser } from '../../common/decorators';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectModel(MODELS.Project) private projects: Model<any>,
    @InjectModel(MODELS.Floor) private floors: Model<any>,
  ) {}

  async list(user: AuthUser, q?: string, page = 1, limit = 20) {
    const filter: any = {
      tenantId: user.tenantId,
      $or: [{ ownerId: user.id }, { 'members.userId': user.id }],
    };
    if (user.globalRole === 'admin' || user.globalRole === 'superadmin') delete filter.$or;
    if (q) filter.$text = { $search: q };
    const [items, total] = await Promise.all([
      this.projects.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.projects.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }

  async create(user: AuthUser, dto: any) {
    return this.projects.create({ ...dto, tenantId: user.tenantId, ownerId: user.id });
  }

  async get(user: AuthUser, id: string) {
    const project = await this.projects.findOne({ _id: id, tenantId: user.tenantId }).lean();
    if (!project) throw new NotFoundException('Project not found');
    this.assertMember(user, project);
    const floors = await this.floors.find({ projectId: id }).sort({ level: 1 }).lean();
    return { ...project, floors };
  }

  async update(user: AuthUser, id: string, dto: any) {
    const project = await this.projects.findOne({ _id: id, tenantId: user.tenantId });
    if (!project) throw new NotFoundException();
    this.assertMember(user, project, 'manager');
    // Route any status change through the single canonical transition path so
    // project.status and the delivery mirror never diverge.
    if (dto.status !== undefined) {
      this.applyStatus(project, dto.status, user);
      const { status, ...rest } = dto;
      Object.assign(project, rest);
    } else {
      Object.assign(project, dto);
    }
    await project.save();
    return project;
  }

  /** Single source of truth for lifecycle changes. Validates the transition and keeps the
   * legacy delivery.status mirror in sync. */
  async setStatus(user: AuthUser, id: string, toStatus: string) {
    const project = await this.projects.findOne({ _id: id, tenantId: user.tenantId });
    if (!project) throw new NotFoundException('Project not found');
    this.assertMember(user, project, 'manager');
    this.applyStatus(project, toStatus, user);
    await project.save();
    return project;
  }

  private applyStatus(project: any, toStatus: string, user: AuthUser) {
    const from = project.status ?? 'draft';
    if (!canTransitionProject(from, toStatus)) {
      throw new BadRequestException(`Cannot move project from "${from}" to "${toStatus}"`);
    }
    const now = new Date();
    const prevDelivery = typeof project.delivery?.toObject === 'function'
      ? project.delivery.toObject() : (project.delivery ?? {});
    project.status = toStatus;
    project.delivery = {
      ...prevDelivery,
      status: deliveryMirror(toStatus),
      updatedBy: user.id,
      updatedAt: now,
      ...(toStatus === 'delivered' ? { deliveredAt: now } : {}),
    };
  }

  async remove(user: AuthUser, id: string) {
    const project = await this.projects.findOne({ _id: id, tenantId: user.tenantId });
    if (!project) throw new NotFoundException();
    this.assertMember(user, project, 'manager');
    project.deletedAt = new Date(); await project.save();
    return { ok: true };
  }

  async addMember(user: AuthUser, id: string, body: { userId: string; role: string }) {
    const project = await this.projects.findOne({ _id: id, tenantId: user.tenantId });
    if (!project) throw new NotFoundException();
    this.assertMember(user, project, 'manager');
    project.members = project.members.filter((m: any) => String(m.userId) !== body.userId);
    project.members.push({ userId: new Types.ObjectId(body.userId), role: body.role });
    await project.save();
    return project;
  }

  assertMember(user: AuthUser, project: any, min: 'viewer' | 'editor' | 'manager' = 'viewer') {
    if (['admin', 'superadmin'].includes(user.globalRole)) return;
    if (String(project.ownerId) === user.id) return;
    const m = project.members?.find((m: any) => String(m.userId) === user.id);
    if (!m) throw new ForbiddenException('Not a project member');
    const rank = { viewer: 0, editor: 1, manager: 2 };
    if (rank[m.role as keyof typeof rank] < rank[min]) throw new ForbiddenException('Insufficient project role');
  }
}
