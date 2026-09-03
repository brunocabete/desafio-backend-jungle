import { Module } from '@nestjs/common';
import { WalletsController } from './wallets.controller.js';
import { WalletService } from './wallet.service.js';

@Module({
  controllers: [WalletsController],
  providers: [WalletService],
})
export class WalletModule {}
