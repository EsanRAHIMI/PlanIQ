import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from './decorators';

const RANK: Record<string, number> = { viewer: 0, editor: 1, manager: 2 };

/**
 * Project-level authorization. Mirrors ProjectsService.assertMember so any service that
 * already loaded a project can enforce membership consistently — the project list is
 * membership-scoped, so by-id mutations must be too. Global admins and the owner bypass.
 */
export function assertProjectMember(
  user: AuthUser,
  project: { ownerId?: any; members?: { userId: any; role: string }[] },
  min: 'viewer' | 'editor' | 'manager' = 'viewer',
): void {
  if (user.globalRole === 'admin' || user.globalRole === 'superadmin') return;
  if (project.ownerId != null && String(project.ownerId) === user.id) return;
  const m = project.members?.find((x) => String(x.userId) === user.id);
  if (!m) throw new ForbiddenException('You are not a member of this project');
  if ((RANK[m.role] ?? 0) < RANK[min]) throw new ForbiddenException(`This action requires the "${min}" project role`);
}
