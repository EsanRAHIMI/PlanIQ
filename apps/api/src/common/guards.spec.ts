import { RolesGuard } from './guards';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';

function ctx(user: any, required: string[] | undefined): ExecutionContext {
  return {
    getHandler: () => ({}), getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

describe('RolesGuard', () => {
  const reflector = new Reflector();
  let guard: RolesGuard;
  beforeEach(() => { guard = new RolesGuard(reflector); });

  it('allows when no roles required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(ctx({ globalRole: 'viewer' }, undefined))).toBe(true);
  });

  it('allows when user rank >= required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['editor']);
    expect(guard.canActivate(ctx({ globalRole: 'admin' }, ['editor']))).toBe(true);
  });

  it('forbids when user rank < required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);
    expect(() => guard.canActivate(ctx({ globalRole: 'editor' }, ['admin']))).toThrow(ForbiddenException);
  });
});
