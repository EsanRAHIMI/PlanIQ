import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { assertPlaniqSharedBuilt } from './config/ensure-shared';

async function bootstrap() {
  assertPlaniqSharedBuilt();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const prefix = process.env.API_PREFIX ?? '/api/v1';
  app.setGlobalPrefix(prefix);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? true, credentials: true });
  // Zod validates request DTOs on many routes; keep body shape intact for those handlers.
  app.useGlobalPipes(new ValidationPipe({ whitelist: false, transform: true, forbidNonWhitelisted: false }));

  const swagger = new DocumentBuilder()
    .setTitle('PlanIQ API').setDescription('Automatic device placement on villa floor plans')
    .setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup(`${prefix}/docs`, app, SwaggerModule.createDocument(app, swagger));

  const port = parseInt(process.env.API_PORT ?? '4000', 10);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`PlanIQ API on :${port}${prefix} (docs at ${prefix}/docs)`);
}
bootstrap();
