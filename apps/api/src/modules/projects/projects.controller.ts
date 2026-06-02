import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { createProjectSchema } from '@planiq/shared';
import { ProjectsService } from './projects.service';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, AuthUser } from '../../common/decorators';

@ApiTags('projects') @ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private svc: ProjectsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('q') q?: string, @Query('page') page = 1, @Query('limit') limit = 20) {
    return this.svc.list(user, q, +page, +limit);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(createProjectSchema)) dto: any) { return this.svc.create(user, dto); }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.svc.get(user, id); }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) { return this.svc.update(user, id, dto); }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.svc.remove(user, id); }

  @Post(':id/members')
  addMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) { return this.svc.addMember(user, id, body); }
}
