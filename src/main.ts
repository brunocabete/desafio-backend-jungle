import './common/config/load-env.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { JsonLogger } from './common/logging/json.logger.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new JsonLogger(),
  });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
