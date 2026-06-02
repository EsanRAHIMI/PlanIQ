import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const ANALYSIS_QUEUE = 'analysis';
export const EXPORT_QUEUE = 'export';
export const REDIS = 'REDIS_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (c: ConfigService) => new IORedis(c.get<string>('redisUrl')!, { maxRetriesPerRequest: null }),
      inject: [ConfigService],
    },
    {
      provide: ANALYSIS_QUEUE,
      useFactory: (conn: IORedis) => new Queue(ANALYSIS_QUEUE, { connection: conn }),
      inject: [REDIS],
    },
    {
      provide: EXPORT_QUEUE,
      useFactory: (conn: IORedis) => new Queue(EXPORT_QUEUE, { connection: conn }),
      inject: [REDIS],
    },
  ],
  exports: [REDIS, ANALYSIS_QUEUE, EXPORT_QUEUE],
})
export class QueueModule {}
