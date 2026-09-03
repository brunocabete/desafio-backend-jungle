import { Module } from '@nestjs/common';
import { WagerTransactionService } from './wager-transaction.service.js';
import { WagerTransactionsController } from './wager-transactions.controller.js';

@Module({
  controllers: [WagerTransactionsController],
  providers: [WagerTransactionService],
})
export class WageringModule {}
