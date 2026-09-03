import { Module } from '@nestjs/common';
import { PendingReferenceScheduler } from './pending-reference.scheduler.js';
import { WagerTransactionService } from './wager-transaction.service.js';
import { WagerTransactionsController } from './wager-transactions.controller.js';

@Module({
  controllers: [WagerTransactionsController],
  providers: [WagerTransactionService, PendingReferenceScheduler],
})
export class WageringModule {}
