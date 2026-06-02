import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { GlobalRole } from '@planiq/shared';
import { IS_PUBLIC, ROLES_KEY } from './decorators';

/** JWT guard that respects @Public(). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) { super(); }
  canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    return super.canActivate(ctx);
  }
  handleRequest(err: any, user: any) {
    if (err || !user) throw new UnauthorizedException('Authentication required');
    return user;
  }
}

const ROLE_RANK: Record<GlobalRole, number> = {
  viewer: 0, editor: 1, manager: 2, admin: 3, superadmin: 4,
};

/** Global RBAC: user's role rank must be >= the lowest required role. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<GlobalRole[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user) throw new UnauthorizedException();
    const minRank = Math.min(...required.map((r) => ROLE_RANK[r]));
    if (ROLE_RANK[user.globalRole] < minRank) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
