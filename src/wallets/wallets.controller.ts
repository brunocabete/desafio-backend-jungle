import { Body, Controller, Post } from '@nestjs/common';
import { httpError } from '../common/http/api-error.js';
import {
  InvalidCreateWalletError,
  WalletAlreadyExistsError,
  WalletService,
  type CreateWalletInput,
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
}
