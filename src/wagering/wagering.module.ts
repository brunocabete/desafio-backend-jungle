import { Module } from '@nestjs/common';
import { PendingReferenceScheduler } from './pending-reference.scheduler.js';
import { WagerTransactionService } from './wager-transaction.service.js';
import {
  ProviderWageringTransactionsController,
  WagerTransactionsController,
} from './wager-transactions.controller.js';

@Module({
  controllers: [
    WagerTransactionsController,
    ProviderWageringTransactionsController,
  ],
  providers: [WagerTransactionService, PendingReferenceScheduler],
})
export class WageringModule {}
