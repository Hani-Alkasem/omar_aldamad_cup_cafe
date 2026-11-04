import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Shared app configuration for main.ts and the e2e tests. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api/v1', { exclude: ['docs', 'docs-json'] });
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','), credentials: false });
  app.enableShutdownHooks();
  // CSV uploads arrive as raw text (5 MB is about 50,000 asset rows; the importer caps at 5,000).
  (app as NestExpressApplication).useBodyParser('text', { type: ['text/csv', 'application/csv'], limit: '5mb' });
  // Behind a reverse proxy, req.ip (used by the token rate limiter) must come from X-Forwarded-For.
  // Set TRUST_PROXY to the hop count or subnet of your proxies, never "true" on an exposed port.
  if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.getHttpAdapter().getInstance().set('trust proxy', /^\d+$/.test(v) ? Number(v) : v);
  }

  const config = new DocumentBuilder()
    .setTitle('ITAM Platform API')
    .setDescription('Assets, racks (DCIM), IPAM and CMDB. Errors share one shape: { statusCode, code, message, details }.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  return app;
}
