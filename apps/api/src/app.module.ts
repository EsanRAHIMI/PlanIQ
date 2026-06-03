import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration';
import { validateEnv } from './config/validation';
import { ENV_FILE_PATHS } from './config/env-bootstrap';
import { JwtAuthGuard, RolesGuard } from './common/guards';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { StorageModule } from './modules/storage/storage.module';
import { AiModule } from './modules/ai/ai.module';
import { QueueModule } from './modules/queue/queue.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { FloorsModule } from './modules/floors/floors.module';
import { AssetsModule } from './modules/assets/assets.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { AnalysisRunsModule } from './modules/analysis-runs/analysis-runs.module';
import { PlacementsModule } from './modules/placements/placements.module';
import { DevicesModule } from './modules/devices/devices.module';
import { VersionsModule } from './modules/versions/versions.module';
import { ExportsModule } from './modules/exports/exports.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';

function prettyTransportIfAvailable(nodeEnv: string) {
  if (nodeEnv === 'production') return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty' };
  } catch {
    // Graceful dev fallback: keep structured logs if pretty transport isn't installed.
    return undefined;
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [...ENV_FILE_PATHS],
      load: [configuration],
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        pinoHttp: {
          level: c.get('logLevel'),
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          transport: prettyTransportIfAvailable(c.get('nodeEnv')),
        },
      }),
    }),
    MongooseModule.forRootAsync({ inject: [ConfigService], useFactory: (c: ConfigService) => ({ uri: c.get('mongoUri') }) }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => [{ ttl: (c.get('limits') as any).rateWindow * 1000, limit: (c.get('limits') as any).rateMax }],
    }),
    StorageModule, AiModule, QueueModule,
    AuthModule, ProjectsModule, FloorsModule, AssetsModule, AnalysisModule,
    PlacementsModule, DevicesModule, VersionsModule, ExportsModule, AnalysisRunsModule,
    AdminModule, HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
