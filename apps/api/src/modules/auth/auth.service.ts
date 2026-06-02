import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { MODELS } from '../../db/schemas';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(MODELS.User) private users: Model<any>,
    @InjectModel(MODELS.Tenant) private tenants: Model<any>,
    @InjectModel(MODELS.RefreshSession) private sessions: Model<any>,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  private get jwtCfg() { return this.config.get('jwt') as any; }
  private hash(t: string) { return createHash('sha256').update(t).digest('hex'); }

  async register(dto: { tenantName: string; name: string; email: string; password: string }, ctx: { ip?: string; ua?: string }) {
    const exists = await this.users.findOne({ email: dto.email.toLowerCase() });
    if (exists) throw new ConflictException('Email already registered');
    const slug = dto.tenantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + randomUUID().slice(0, 6);
    const tenant = await this.tenants.create({ name: dto.tenantName, slug });
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const user = await this.users.create({
      tenantId: tenant._id, email: dto.email.toLowerCase(), passwordHash, name: dto.name, globalRole: 'admin',
    });
    return this.issue(user, ctx);
  }

  async login(dto: { email: string; password: string }, ctx: { ip?: string; ua?: string }) {
    const user = await this.users.findOne({ email: dto.email.toLowerCase() });
    if (!user || user.status === 'suspended') throw new UnauthorizedException('Invalid credentials');
    const ok = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    user.lastLoginAt = new Date(); await user.save();
    return this.issue(user, ctx);
  }

  private async issue(user: any, ctx: { ip?: string; ua?: string }) {
    const payload = { sub: String(user._id), tid: String(user.tenantId), email: user.email, role: user.globalRole };
    const accessToken = await this.jwt.signAsync(payload, { secret: this.jwtCfg.accessSecret, expiresIn: this.jwtCfg.accessTtl });
    const refreshToken = randomUUID() + '.' + randomUUID();
    const ttlDays = parseInt(this.jwtCfg.refreshTtl) || 7;
    await this.sessions.create({
      userId: user._id, tokenHash: this.hash(refreshToken), userAgent: ctx.ua, ip: ctx.ip,
      expiresAt: new Date(Date.now() + ttlDays * 864e5),
    });
    return {
      accessToken, refreshToken,
      user: { id: user._id, name: user.name, email: user.email, globalRole: user.globalRole, tenantId: user.tenantId },
    };
  }

  async refresh(token: string, ctx: { ip?: string; ua?: string }) {
    if (!token) throw new UnauthorizedException('No refresh token');
    const session = await this.sessions.findOne({ tokenHash: this.hash(token), revokedAt: null });
    if (!session || session.expiresAt < new Date()) throw new UnauthorizedException('Invalid refresh token');
    const user = await this.users.findById(session.userId);
    if (!user) throw new UnauthorizedException();
    session.revokedAt = new Date(); await session.save(); // rotation
    return this.issue(user, ctx);
  }

  async logout(token: string) {
    if (token) await this.sessions.updateOne({ tokenHash: this.hash(token) }, { revokedAt: new Date() });
  }

  async me(userId: string) {
    const user = await this.users.findById(userId).lean();
    if (!user) throw new UnauthorizedException();
    const tenant = await this.tenants.findById(user.tenantId).lean();
    return { user: { id: user._id, name: user.name, email: user.email, globalRole: user.globalRole }, tenant };
  }
}
