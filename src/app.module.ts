import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CorrelationIdMiddleware } from './common/correlation/correlation-id.middleware.js';
import { DecimalConfigModule } from './common/decimal/decimal-config.module.js';

@Module({ imports: [DecimalConfigModule] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
