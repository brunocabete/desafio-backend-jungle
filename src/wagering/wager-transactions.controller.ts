import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { httpError } from '../common/http/api-error.js';
import { WagerTransactionStatus } from '../domain/wager-transaction/wager-transaction.js';
import {
  InvalidWagerPayloadError,
  WagerIdempotencyConflictError,
  WagerTransactionService,
  WagerWalletNotFoundError,
} from './wager-transaction.service.js';
import type { WagerSubmitView } from './wager-transaction.service.js';

@Controller('wagering')
export class WagerTransactionsController {
  constructor(
    private readonly wagerTransactionService: WagerTransactionService,
  ) {}

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerSubmitView> {
    try {
      const view = await this.wagerTransactionService.submit({
        ...(body as Record<string, unknown>),
        idempotencyKey,
      });
      if (view.status === WagerTransactionStatus.PendingReference) {
        res.status(HttpStatus.ACCEPTED);
      } else if (view.status === WagerTransactionStatus.Rejected) {
        res.status(HttpStatus.UNPROCESSABLE_ENTITY);
      }
      return view;
    } catch (error) {
      if (error instanceof InvalidWagerPayloadError) {
        return httpError(400, 'INVALID_PAYLOAD', error.message);
      }
      if (error instanceof WagerWalletNotFoundError) {
        return httpError(404, 'WALLET_NOT_FOUND', error.message);
      }
      if (error instanceof WagerIdempotencyConflictError) {
        return httpError(409, 'IDEMPOTENCY_CONFLICT', error.message);
      }
      throw error;
    }
  }
}
