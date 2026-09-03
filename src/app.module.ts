import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { CorrelationIdMiddleware } from './common/correlation/correlation-id.middleware.js';
import { DecimalConfigModule } from './common/decimal/decimal-config.module.js';
import mikroOrmConfig from './mikro-orm.config.js';
import { WalletModule } from './wallets/wallet.module.js';
import { WageringModule } from './wagering/wagering.module.js';

@Module({
  imports: [
    DecimalConfigModule,
    MikroOrmModule.forRoot(mikroOrmConfig),
    WalletModule,
    WageringModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
