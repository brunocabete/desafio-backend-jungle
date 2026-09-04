import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { httpError } from '../common/http/api-error.js';
import { WagerTransactionStatus } from '../domain/wager-transaction/wager-transaction.js';
import {
  InvalidWagerPayloadError,
  WagerIdempotencyConflictError,
  WagerTransactionNotFoundError,
  WagerTransactionService,
  WagerWalletNotFoundError,
} from './wager-transaction.service.js';
import type {
  WagerSubmitView,
  WagerTransactionView,
} from './wager-transaction.service.js';

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

  @Get('transactions/:transactionId')
  async getById(
    @Param('transactionId') transactionId: string,
  ): Promise<WagerTransactionView> {
    try {
      return await this.wagerTransactionService.findById(transactionId);
    } catch (error) {
      if (error instanceof WagerTransactionNotFoundError) {
        return httpError(404, 'TRANSACTION_NOT_FOUND', error.message);
      }
      throw error;
    }
  }
}

@Controller('providers')
export class ProviderWageringTransactionsController {
  constructor(
    private readonly wagerTransactionService: WagerTransactionService,
  ) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async getByProviderExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    try {
      return await this.wagerTransactionService.findByProviderExternal(
        providerId,
        externalTransactionId,
      );
    } catch (error) {
      if (error instanceof WagerTransactionNotFoundError) {
        return httpError(404, 'TRANSACTION_NOT_FOUND', error.message);
      }
      throw error;
    }
  }
}
