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
import { Wallet, type WalletState } from '../domain/wallet/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../domain/ledger/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../domain/wager-transaction/wager-transaction.js';
import { wagerPayloadHash } from '../domain/wager/idempotency.js';
import { isUuid } from '../common/id/is-uuid.js';
import { WalletEntity } from '../db/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../db/entities/wallet-ledger-entry.entity.js';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseLedgerLimit,
} from './ledger-cursor.js';

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

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`wallet '${walletId}' does not exist`);
    this.name = 'WalletNotFoundError';
  }
}

export interface LedgerEntryView {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export interface WalletLedgerPage {
  walletId: string;
  entries: LedgerEntryView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface LedgerPageOptions {
  cursor?: string;
  limit?: unknown;
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

interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface LedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  currency: string;
  moneyAmount: string;
  balanceBeforeAmount: string;
  balanceAfterAmount: string;
  createdAt: Date;
}

function toWalletState(row: WalletRow): WalletState {
  return {
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: { amount: row.balanceAmount, currency: row.currency },
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLedgerEntryView(row: LedgerEntryRow): LedgerEntryView {
  const currency = row.currency;
  return {
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction,
    money: { amount: row.moneyAmount, currency },
    balanceBefore: { amount: row.balanceBeforeAmount, currency },
    balanceAfter: { amount: row.balanceAfterAmount, currency },
    createdAt: row.createdAt,
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

  async getById(walletId: string): Promise<WalletView> {
    if (!isUuid(walletId)) {
      throw new WalletNotFoundError(walletId);
    }
    const em = this.orm.em.fork();
    const row = (await em.findOne(WalletEntity, {
      id: walletId,
    })) as unknown as WalletRow | null;
    if (!row) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(Wallet.rehydrate(toWalletState(row)));
  }

  async ledger(
    walletId: string,
    options: LedgerPageOptions = {},
  ): Promise<WalletLedgerPage> {
    if (!isUuid(walletId)) {
      throw new WalletNotFoundError(walletId);
    }
    const limit = parseLedgerLimit(options.limit);
    const cursor = options.cursor
      ? decodeLedgerCursor(options.cursor)
      : undefined;

    const em = this.orm.em.fork();
    const walletRow = (await em.findOne(WalletEntity, {
      id: walletId,
    })) as unknown as WalletRow | null;
    if (!walletRow) {
      throw new WalletNotFoundError(walletId);
    }

    const where: Record<string, unknown> = { walletId };
    if (cursor) {
      where.$or = [
        { createdAt: { $gt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { $gt: cursor.id } },
      ];
    }
    const rows = (await em.find(WalletLedgerEntryEntity, where, {
      orderBy: { createdAt: 'ASC', id: 'ASC' },
      limit: limit + 1,
    })) as unknown as LedgerEntryRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const entries = pageRows.map(toLedgerEntryView);

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeLedgerCursor({
        createdAt: last.createdAt,
        id: last.id,
      });
    }
    return { walletId, entries, nextCursor, hasMore };
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
