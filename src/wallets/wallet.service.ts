import {
  EntityManager,
  MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import {
  DEFAULT_CURRENCY,
  Money,
  type MoneyProps,
} from '../domain/money/money.js';
import { Wallet } from '../domain/wallet/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../domain/ledger/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../domain/wager-transaction/wager-transaction.js';
import { wagerPayloadHash } from '../domain/wager/idempotency.js';
import { WalletEntity } from '../db/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../db/entities/wallet-ledger-entry.entity.js';

export const INTERNAL_OPENING_PROVIDER = 'jungle-internal';

export interface CreateWalletInput {
  playerId?: unknown;
  initialBalance?: { amount?: unknown; currency?: unknown } | null;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class InvalidCreateWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCreateWalletError';
  }
}

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(
      `a wallet already exists for player '${playerId}' and currency '${currency}'`,
    );
    this.name = 'WalletAlreadyExistsError';
  }
}

interface ParsedCreateWallet {
  playerId: string;
  initialBalance: Money;
}

export function parseCreateWallet(
  input: CreateWalletInput,
): ParsedCreateWallet {
  const playerId = input?.playerId;
  if (typeof playerId !== 'string' || playerId.trim().length === 0) {
    throw new InvalidCreateWalletError('playerId is required');
  }
  const normalizedPlayerId = playerId.trim();
  if (normalizedPlayerId.length > 64) {
    throw new InvalidCreateWalletError(
      'playerId must be at most 64 characters',
    );
  }

  const initial = input.initialBalance;
  if (initial === undefined || initial === null) {
    return {
      playerId: normalizedPlayerId,
      initialBalance: Money.zero(DEFAULT_CURRENCY),
    };
  }
  if (typeof initial !== 'object' || Array.isArray(initial)) {
    throw new InvalidCreateWalletError('initialBalance must be an object');
  }

  const { amount, currency } = initial;
  if (typeof amount !== 'string' || amount.length === 0) {
    throw new InvalidCreateWalletError(
      'initialBalance.amount is required as a decimal string',
    );
  }

  try {
    return {
      playerId: normalizedPlayerId,
      initialBalance: Money.from({
        amount,
        currency: (currency ?? DEFAULT_CURRENCY) as string,
      }),
    };
  } catch (error) {
    throw new InvalidCreateWalletError(
      `invalid initialBalance: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

@Injectable()
export class WalletService {
  constructor(private readonly orm: MikroORM) {}

  async create(input: CreateWalletInput): Promise<WalletView> {
    const { playerId, initialBalance } = parseCreateWallet(input);

    try {
      const em = this.orm.em.fork();
      const wallet = await em.transactional(async (em) => {
        const found = await em.findOne(WalletEntity, {
          playerId,
          currency: initialBalance.currency,
        });
        if (found) {
          throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
        }
        const opened = Wallet.open({
          id: Bun.randomUUIDv7(),
          playerId,
          initialBalance,
        });
        em.create(WalletEntity, {
          id: opened.id,
          playerId: opened.playerId,
          currency: opened.currency,
          balanceAmount: opened.balance.toJSON().amount,
          version: opened.version,
          createdAt: opened.createdAt,
          updatedAt: opened.updatedAt,
        });
        if (opened.balance.isPositive()) {
          this.persistOpening(em, opened);
        }
        return opened;
      });
      return toWalletView(wallet);
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
      }
      throw error;
    }
  }

  private persistOpening(em: EntityManager, wallet: Wallet): void {
    const balance = wallet.balance;
    const opening = WagerTransaction.create({
      id: Bun.randomUUIDv7(),
      providerId: INTERNAL_OPENING_PROVIDER,
      externalTransactionId: Bun.randomUUIDv7(),
      idempotencyKey: Bun.randomUUIDv7(),
      payloadHash: wagerPayloadHash({
        providerId: INTERNAL_OPENING_PROVIDER,
        externalTransactionId: wallet.id,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: '',
        gameId: '',
        kind: WagerTransactionKind.Opening,
        money: balance.toJSON(),
      }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: '',
      gameId: '',
      kind: WagerTransactionKind.Opening,
      money: balance,
      createdAt: wallet.createdAt,
    });
    opening.markProcessed(undefined, opening.createdAt);

    const zero = Money.zero(balance.currency);
    const entry = WalletLedgerEntry.create({
      id: Bun.randomUUIDv7(),
      walletId: wallet.id,
      transactionId: opening.id,
      direction: LedgerDirection.Credit,
      money: balance,
      balanceBefore: zero,
      balanceAfter: balance,
      createdAt: wallet.createdAt,
    });

    em.create(WagerTransactionEntity, {
      id: opening.id,
      providerId: opening.providerId,
      externalTransactionId: opening.externalTransactionId,
      idempotencyKey: opening.idempotencyKey,
      payloadHash: opening.payloadHash,
      walletId: opening.walletId,
      playerId: opening.playerId,
      roundId: opening.roundId,
      gameId: opening.gameId,
      kind: opening.kind,
      status: opening.status,
      moneyAmount: opening.money.toJSON().amount,
      moneyCurrency: opening.money.currency,
      createdAt: opening.createdAt,
      processedAt: opening.processedAt,
    });
    em.create(WalletLedgerEntryEntity, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      currency: entry.money.currency,
      moneyAmount: entry.money.toJSON().amount,
      balanceBeforeAmount: entry.balanceBefore.toJSON().amount,
      balanceAfterAmount: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });
  }
}
