import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { CorrelationIdMiddleware } from './common/correlation/correlation-id.middleware.js';
import { DecimalConfigModule } from './common/decimal/decimal-config.module.js';
import mikroOrmConfig from './mikro-orm.config.js';

@Module({
  imports: [DecimalConfigModule, MikroOrmModule.forRoot(mikroOrmConfig)],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
