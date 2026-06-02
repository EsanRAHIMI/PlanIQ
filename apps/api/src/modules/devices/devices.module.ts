import { Module, Injectable, Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { MongooseModule, InjectModel } from '@nestjs/mongoose';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { MODELS, DeviceLibrarySchema } from '../../db/schemas';
import { CurrentUser, AuthUser, Roles } from '../../common/decorators';

@Injectable()
export class DevicesService {
  constructor(@InjectModel(MODELS.DeviceLibrary) private devices: Model<any>) {}

  /** Tenant overrides merged over the global (null-tenant) catalog. */
  async catalog(user: AuthUser) {
    const docs = await this.devices.find({ $or: [{ tenantId: null }, { tenantId: user.tenantId }], enabled: true }).sort({ order: 1 }).lean();
    const byCode = new Map<string, any>();
    for (const d of docs) if (!byCode.has(d.code) || d.tenantId) byCode.set(d.code, d);
    return [...byCode.values()].sort((a, b) => a.order - b.order);
  }
  create(user: AuthUser, dto: any) { return this.devices.create({ ...dto, tenantId: user.tenantId }); }
  update(user: AuthUser, id: string, dto: any) { return this.devices.findOneAndUpdate({ _id: id, tenantId: user.tenantId }, dto, { new: true }); }
  async disable(user: AuthUser, id: string) { await this.devices.updateOne({ _id: id, tenantId: user.tenantId }, { enabled: false }); return { ok: true }; }
}

@ApiTags('devices') @ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private svc: DevicesService) {}
  @Get() catalog(@CurrentUser() u: AuthUser) { return this.svc.catalog(u); }
  @Post() @Roles('admin') create(@CurrentUser() u: AuthUser, @Body() dto: any) { return this.svc.create(u, dto); }
  @Patch(':id') @Roles('admin') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any) { return this.svc.update(u, id, dto); }
  @Delete(':id') @Roles('admin') disable(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.disable(u, id); }
}

@Module({
  imports: [MongooseModule.forFeature([{ name: MODELS.DeviceLibrary, schema: DeviceLibrarySchema }])],
  controllers: [DevicesController],
  providers: [DevicesService],
})
export class DevicesModule {}
