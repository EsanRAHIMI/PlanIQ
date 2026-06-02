import { Module, Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import IORedis from 'ioredis';
import { Public } from '../../common/decorators';
import { REDIS } from '../queue/queue.module';
import { AiService } from '../ai/ai.service';
import { StorageService } from '../storage/storage.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private mongo: Connection,
    @Inject(REDIS) private redis: IORedis,
    private ai: AiService,
    private storage: StorageService,
  ) {}

  @Public() @Get()
  live() { return { status: 'ok', uptime: process.uptime(), version: process.env.npm_package_version ?? '0.1.0' }; }

  @Public() @Get('ready')
  async ready() {
    const [mongo, redis, ai] = await Promise.all([
      Promise.resolve(this.mongo.readyState === 1),
      this.redis.ping().then(() => true).catch(() => false),
      this.ai.health(),
    ]);
    const ok = mongo && redis && ai;
    return { status: ok ? 'ready' : 'degraded', checks: { mongo, redis, ai } };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
