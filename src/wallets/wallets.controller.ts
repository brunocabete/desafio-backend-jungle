import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { httpError } from '../common/http/api-error.js';
import {
  InvalidLedgerCursorError,
  InvalidLedgerLimitError,
} from './ledger-cursor.js';
import {
  InvalidCreateWalletError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  WalletService,
  type CreateWalletInput,
  type ReconciliationView,
  type WalletLedgerPage,
  type WalletView,
} from './wallet.service.js';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletService: WalletService) {}

  @Post()
  async create(@Body() body: CreateWalletInput): Promise<WalletView> {
    try {
      return await this.walletService.create(body);
    } catch (error) {
      if (error instanceof InvalidCreateWalletError) {
        return httpError(400, 'INVALID_PAYLOAD', error.message);
      }
      if (error instanceof WalletAlreadyExistsError) {
        return httpError(409, 'WALLET_ALREADY_EXISTS', error.message);
      }
      throw error;
    }
  }

  @Get(':walletId')
  async getById(@Param('walletId') walletId: string): Promise<WalletView> {
    try {
      return await this.walletService.getById(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        return httpError(404, 'WALLET_NOT_FOUND', error.message);
      }
      throw error;
    }
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<WalletLedgerPage> {
    try {
      return await this.walletService.ledger(walletId, {
        cursor: typeof cursor === 'string' ? cursor : undefined,
        limit,
      });
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        return httpError(404, 'WALLET_NOT_FOUND', error.message);
      }
      if (
        error instanceof InvalidLedgerCursorError ||
        error instanceof InvalidLedgerLimitError
      ) {
        return httpError(400, 'INVALID_PAYLOAD', error.message);
      }
      throw error;
    }
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param('walletId') walletId: string,
  ): Promise<ReconciliationView> {
    try {
      return await this.walletService.reconcile(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        return httpError(404, 'WALLET_NOT_FOUND', error.message);
      }
      throw error;
    }
  }
}
