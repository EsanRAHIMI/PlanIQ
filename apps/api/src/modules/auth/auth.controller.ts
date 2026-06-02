import { Body, Controller, Get, Post, Req, Res, UsePipes, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { registerSchema, loginSchema } from '@planiq/shared';
import { AuthService } from './auth.service';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { Public, CurrentUser, AuthUser } from '../../common/decorators';

const REFRESH_COOKIE = 'planiq_rt';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private config: ConfigService) {}

  private setCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true, secure: this.config.get('nodeEnv') === 'production', sameSite: 'strict',
      domain: (this.config.get('jwt') as any).cookieDomain, path: '/api/v1/auth', maxAge: 7 * 864e5,
    });
  }
  private ctx(req: Request) { return { ip: req.ip, ua: req.headers['user-agent'] }; }

  @Public() @Post('register') @UsePipes(new ZodValidationPipe(registerSchema))
  async register(@Body() dto: any, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.register(dto, this.ctx(req));
    this.setCookie(res, r.refreshToken);
    return { user: r.user, accessToken: r.accessToken };
  }

  @Public() @Post('login') @HttpCode(200) @UsePipes(new ZodValidationPipe(loginSchema))
  async login(@Body() dto: any, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(dto, this.ctx(req));
    this.setCookie(res, r.refreshToken);
    return { user: r.user, accessToken: r.accessToken };
  }

  @Public() @Post('refresh') @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], this.ctx(req));
    this.setCookie(res, r.refreshToken);
    return { accessToken: r.accessToken };
  }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) { return this.auth.me(user.id); }
}
