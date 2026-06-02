import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { GlobalRole, ProjectRole } from '@planiq/shared';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: GlobalRole[]) => SetMetadata(ROLES_KEY, roles);

export const PROJECT_ROLES_KEY = 'projectRoles';
export const ProjectRoles = (...roles: ProjectRole[]) => SetMetadata(PROJECT_ROLES_KEY, roles);

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  globalRole: GlobalRole;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
