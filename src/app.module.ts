import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { HttpExceptionFilter } from './common/http/http-exception.filter.js';
import { CorrelationIdMiddleware } from './common/correlation/correlation-id.middleware.js';
import { DecimalConfigModule } from './common/decimal/decimal-config.module.js';
import { MetricsModule } from './common/metrics/metrics.module.js';
import mikroOrmConfig from './mikro-orm.config.js';
import { HealthModule } from './health/health.module.js';
import { WalletModule } from './wallets/wallet.module.js';
import { WageringModule } from './wagering/wagering.module.js';
import { SqsModule } from './sqs/wager-sqs.module.js';
import { OutboxModule } from './outbox/outbox.module.js';

@Module({
  imports: [
    DecimalConfigModule,
    MetricsModule,
    MikroOrmModule.forRoot(mikroOrmConfig),
    HealthModule,
    WalletModule,
    WageringModule,
    SqsModule,
    OutboxModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
