import {
  EntityManager,
  LockMode,
  MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import {
  Money,
  DEFAULT_CURRENCY,
  type MoneyProps,
} from '../domain/money/money.js';
import { Wallet, type WalletState } from '../domain/wallet/wallet.js';
import type { FailureCode as FailureCodeType } from '../domain/failure-code.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from '../domain/wager-transaction/wager-transaction.js';
import {
  WalletLedgerEntry,
  LedgerDirection,
} from '../domain/ledger/wallet-ledger-entry.js';
import {
  applyWagerTransaction,
  type WagerApplyResult,
} from '../domain/wager/wager-transaction-applier.js';
import { wagerPayloadHash } from '../domain/wager/idempotency.js';
import { WalletEntity } from '../db/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../db/entities/wallet-ledger-entry.entity.js';

const MAX_PROVIDER_ID = 64;
const MAX_EXTERNAL_ID = 128;
const MAX_PLAYER_ID = 64;
const MAX_ROUND_ID = 128;
const MAX_GAME_ID = 128;
const MAX_IDEMPOTENCY_KEY = 255;
const MAX_REFERENCE = 128;

const KIND_BY_CODE: Record<string, WagerTransactionKind> = {
  BET: WagerTransactionKind.Bet,
  WIN: WagerTransactionKind.Win,
  LOSS: WagerTransactionKind.Loss,
  REFUND: WagerTransactionKind.Refund,
  ROLLBACK: WagerTransactionKind.Rollback,
  OPENING: WagerTransactionKind.Opening,
};

const REFERENCEABLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

const REVERSAL_KINDS = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export interface WagerSubmitView {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCodeType;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

export interface NormalizedWagerSubmit {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export class InvalidWagerPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerPayloadError';
  }
}

export class WagerWalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`wallet '${walletId}' does not exist`);
    this.name = 'WagerWalletNotFoundError';
  }
}

export class WagerIdempotencyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(
      `idempotency key '${idempotencyKey}' was already used with a different payload`,
    );
    this.name = 'WagerIdempotencyConflictError';
  }
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new InvalidWagerPayloadError(`${field} is required as a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidWagerPayloadError(`${field} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new InvalidWagerPayloadError(
      `${field} must be at most ${maxLength} characters`,
    );
  }
  return trimmed;
}

function parseMoney(value: unknown): MoneyProps {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidWagerPayloadError(
      'money must be an object with amount and currency',
    );
  }
  const { amount, currency } = value as {
    amount?: unknown;
    currency?: unknown;
  };
  try {
    const money = Money.from({
      amount: requiredString(amount, 'money.amount', 64),
      currency: (currency ?? DEFAULT_CURRENCY) as string,
    });
    return money.toJSON();
  } catch (error) {
    throw new InvalidWagerPayloadError(
      `invalid money: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function normalizeWagerSubmit(input: unknown): NormalizedWagerSubmit {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InvalidWagerPayloadError('request body must be an object');
  }
  const body = input as Record<string, unknown>;

  const idempotencyKey = requiredString(
    body.idempotencyKey,
    'idempotencyKey',
    MAX_IDEMPOTENCY_KEY,
  );
  const providerId = requiredString(
    body.providerId,
    'providerId',
    MAX_PROVIDER_ID,
  );
  const externalTransactionId = requiredString(
    body.externalTransactionId,
    'externalTransactionId',
    MAX_EXTERNAL_ID,
  );
  const playerId = requiredString(body.playerId, 'playerId', MAX_PLAYER_ID);
  const walletId = requiredString(body.walletId, 'walletId', MAX_PROVIDER_ID);
  const roundId = requiredString(body.roundId, 'roundId', MAX_ROUND_ID);
  const gameId = requiredString(body.gameId, 'gameId', MAX_GAME_ID);
  const money = parseMoney(body.money);

  const rawKind = body.kind;
  if (typeof rawKind !== 'string' || rawKind.trim().length === 0) {
    throw new InvalidWagerPayloadError('kind is required');
  }
  const kind = KIND_BY_CODE[rawKind.trim().toUpperCase()];
  if (!kind) {
    throw new InvalidWagerPayloadError(
      `unsupported transaction kind '${rawKind}'`,
    );
  }

  let referenceExternalTransactionId: string | undefined;
  const reference = body.referenceExternalTransactionId;
  if (reference !== undefined && reference !== null) {
    referenceExternalTransactionId = requiredString(
      reference,
      'referenceExternalTransactionId',
      MAX_REFERENCE,
    );
  }

  if (
    (kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback) &&
    !referenceExternalTransactionId
  ) {
    throw new InvalidWagerPayloadError(
      `transaction kind ${kind} requires referenceExternalTransactionId`,
    );
  }
  if (kind === WagerTransactionKind.Opening && referenceExternalTransactionId) {
    throw new InvalidWagerPayloadError(
      'OPENING transactions cannot carry a reference',
    );
  }

  const payloadHash = wagerPayloadHash({
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money,
    ...(referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId }
      : {}),
  });

  return {
    providerId,
    externalTransactionId,
    idempotencyKey,
    payloadHash,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money,
    referenceExternalTransactionId,
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

interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  moneyAmount: string;
  moneyCurrency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  createdAt: Date;
  processedAt: Date | null;
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

function toWagerState(row: WagerTransactionRow): WagerTransactionState {
  return {
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: { amount: row.moneyAmount, currency: row.moneyCurrency },
    referenceExternalTransactionId:
      row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: row.failureCode as FailureCodeType | undefined,
    processedAt: row.processedAt ?? undefined,
  };
}

interface WagerTransactionRowProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  moneyAmount: string;
  moneyCurrency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

interface LedgerRowProps {
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

function toWagerRowProps(
  transaction: WagerTransaction,
): WagerTransactionRowProps {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    moneyAmount: transaction.money.toJSON().amount,
    moneyCurrency: transaction.money.currency,
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}

function toLedgerRowProps(entry: WalletLedgerEntry): LedgerRowProps {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    currency: entry.money.currency,
    moneyAmount: entry.money.toJSON().amount,
    balanceBeforeAmount: entry.balanceBefore.toJSON().amount,
    balanceAfterAmount: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

function isReferenceable(kind: WagerTransactionKind): boolean {
  return REFERENCEABLE_KINDS.has(kind);
}

@Injectable()
export class WagerTransactionService {
  constructor(private readonly orm: MikroORM) {}

  async submit(request: unknown): Promise<WagerSubmitView> {
    const normalized = normalizeWagerSubmit(request);
    try {
      return await this.process(normalized);
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        return this.resolveExisting(normalized);
      }
      throw error;
    }
  }

  private async process(
    normalized: NormalizedWagerSubmit,
  ): Promise<WagerSubmitView> {
    const em = this.orm.em.fork();
    return em.transactional(async (em) => {
      const existing = await this.findByIdempotency(em, normalized);
      if (existing) {
        return this.viewForExisting(em, existing, normalized);
      }

      const walletRow = (await em.findOne(
        WalletEntity,
        { id: normalized.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      )) as unknown as WalletRow | null;
      if (!walletRow) {
        throw new WagerWalletNotFoundError(normalized.walletId);
      }

      const afterLock = await this.findByIdempotency(em, normalized);
      if (afterLock) {
        return this.viewForExisting(em, afterLock, normalized);
      }

      const wallet = Wallet.rehydrate(toWalletState(walletRow));
      if (wallet.playerId !== normalized.playerId) {
        throw new InvalidWagerPayloadError(
          `playerId '${normalized.playerId}' does not own wallet '${normalized.walletId}'`,
        );
      }

      const now = new Date();
      const transaction = WagerTransaction.create({
        id: Bun.randomUUIDv7(),
        providerId: normalized.providerId,
        externalTransactionId: normalized.externalTransactionId,
        idempotencyKey: normalized.idempotencyKey,
        payloadHash: normalized.payloadHash,
        walletId: normalized.walletId,
        playerId: normalized.playerId,
        roundId: normalized.roundId,
        gameId: normalized.gameId,
        kind: normalized.kind,
        money: Money.from(normalized.money),
        referenceExternalTransactionId:
          normalized.referenceExternalTransactionId,
        createdAt: now,
      });
      const txRow = em.create(
        WagerTransactionEntity,
        toWagerRowProps(transaction),
      ) as unknown as WagerTransactionRow;

      let reference: WagerTransaction | undefined;
      if (transaction.requiresReference()) {
        const referenceRow = (await em.findOne(WagerTransactionEntity, {
          providerId: normalized.providerId,
          externalTransactionId: normalized.referenceExternalTransactionId,
        })) as unknown as WagerTransactionRow | null;
        reference = referenceRow
          ? WagerTransaction.rehydrate(toWagerState(referenceRow))
          : undefined;
      }

      let referenceAlreadyReversed = false;
      if (reference && reference.status === WagerTransactionStatus.Processed) {
        referenceAlreadyReversed = await this.hasProcessedReversal(
          em,
          reference,
        );
      }

      const result = applyWagerTransaction({
        wallet,
        transaction,
        reference,
        referenceAlreadyReversed,
        now,
      });

      this.syncWagerRow(txRow, transaction);
      this.syncWalletRow(walletRow, wallet);

      if (result.kind === 'processed' && result.entry) {
        em.create(WalletLedgerEntryEntity, toLedgerRowProps(result.entry));
      }

      if (transaction.isTerminal() && isReferenceable(transaction.kind)) {
        await this.resolveDependents(em, walletRow, wallet, transaction, now);
      }

      return this.viewFor(wallet, transaction, result, false);
    });
  }

  private async resolveDependents(
    em: EntityManager,
    walletRow: WalletRow,
    wallet: Wallet,
    processedReference: WagerTransaction,
    now: Date,
  ): Promise<void> {
    const queue: WagerTransaction[] = [processedReference];
    const reversedReferenceIds = new Set<string>();
    const handledIds = new Set<string>();

    while (queue.length > 0) {
      const reference = queue.shift() as WagerTransaction;
      const dependents = (await em.find(
        WagerTransactionEntity,
        {
          providerId: reference.providerId,
          walletId: reference.walletId,
          referenceExternalTransactionId: reference.externalTransactionId,
          status: WagerTransactionStatus.PendingReference,
        },
        { orderBy: { createdAt: 'ASC' } },
      )) as unknown as WagerTransactionRow[];

      for (const dependentRow of dependents) {
        if (handledIds.has(dependentRow.id)) {
          continue;
        }
        handledIds.add(dependentRow.id);

        const dependent = WagerTransaction.rehydrate(
          toWagerState(dependentRow),
        );
        const referenceAlreadyReversed =
          reversedReferenceIds.has(reference.id) ||
          (await this.hasProcessedReversal(em, reference));

        const result = applyWagerTransaction({
          wallet,
          transaction: dependent,
          reference,
          referenceAlreadyReversed,
          now,
        });

        this.syncWagerRow(dependentRow, dependent);

        if (result.kind === 'processed') {
          reversedReferenceIds.add(reference.id);
          this.syncWalletRow(walletRow, wallet);
          if (result.entry) {
            em.create(WalletLedgerEntryEntity, toLedgerRowProps(result.entry));
          }
          if (isReferenceable(dependent.kind)) {
            queue.push(dependent);
          }
        }
      }
    }
  }

  private async hasProcessedReversal(
    em: EntityManager,
    reference: WagerTransaction,
  ): Promise<boolean> {
    const count = await em.count(WagerTransactionEntity, {
      providerId: reference.providerId,
      referenceTransactionId: reference.id,
      status: WagerTransactionStatus.Processed,
      kind: { $in: REVERSAL_KINDS },
    });
    return count > 0;
  }

  private syncWagerRow(
    row: WagerTransactionRow,
    transaction: WagerTransaction,
  ): void {
    row.status = transaction.status;
    row.referenceTransactionId = transaction.referenceTransactionId ?? null;
    row.failureCode = transaction.failureCode ?? null;
    row.processedAt = transaction.processedAt ?? null;
  }

  private syncWalletRow(row: WalletRow, wallet: Wallet): void {
    row.balanceAmount = wallet.balance.toJSON().amount;
    row.version = wallet.version;
    row.updatedAt = wallet.updatedAt;
  }

  private viewFor(
    wallet: Wallet,
    transaction: WagerTransaction,
    result: WagerApplyResult,
    idempotentReplay: boolean,
  ): WagerSubmitView {
    const view: WagerSubmitView = {
      transactionId: transaction.id,
      status: transaction.status,
      idempotentReplay,
    };
    if (result.kind === 'rejected') {
      view.failureCode = result.failureCode;
    }
    if (transaction.status !== WagerTransactionStatus.PendingReference) {
      view.balance = wallet.balance.toJSON();
    }
    return view;
  }

  private async viewForExisting(
    em: EntityManager,
    row: WagerTransactionRow,
    normalized: NormalizedWagerSubmit,
  ): Promise<WagerSubmitView> {
    const transaction = WagerTransaction.rehydrate(toWagerState(row));
    if (!transaction.matchesPayload(normalized.payloadHash)) {
      throw new WagerIdempotencyConflictError(normalized.idempotencyKey);
    }

    const view: WagerSubmitView = {
      transactionId: transaction.id,
      status: transaction.status,
      idempotentReplay: true,
    };
    if (transaction.status === WagerTransactionStatus.Rejected) {
      view.failureCode = transaction.failureCode;
    }
    if (transaction.status !== WagerTransactionStatus.PendingReference) {
      view.balance = await this.balanceObservedFor(em, transaction);
    }
    return view;
  }

  private async resolveExisting(
    normalized: NormalizedWagerSubmit,
  ): Promise<WagerSubmitView> {
    const em = this.orm.em.fork();
    const byKey = (await em.findOne(WagerTransactionEntity, {
      providerId: normalized.providerId,
      idempotencyKey: normalized.idempotencyKey,
    })) as unknown as WagerTransactionRow | null;
    const byExternal = (await em.findOne(WagerTransactionEntity, {
      providerId: normalized.providerId,
      externalTransactionId: normalized.externalTransactionId,
    })) as unknown as WagerTransactionRow | null;
    const existing = byKey ?? byExternal;
    if (!existing) {
      throw new Error(
        'idempotency conflict could not be resolved against an existing row',
      );
    }
    return this.viewForExisting(em, existing, normalized);
  }

  private findByIdempotency(
    em: EntityManager,
    normalized: NormalizedWagerSubmit,
  ): Promise<WagerTransactionRow | null> {
    return em.findOne(WagerTransactionEntity, {
      providerId: normalized.providerId,
      idempotencyKey: normalized.idempotencyKey,
    }) as unknown as Promise<WagerTransactionRow | null>;
  }

  private async balanceObservedFor(
    em: EntityManager,
    transaction: WagerTransaction,
  ): Promise<MoneyProps> {
    const ownEntry = (await em.findOne(WalletLedgerEntryEntity, {
      transactionId: transaction.id,
    })) as unknown as { balanceAfterAmount: string } | null;
    if (ownEntry) {
      return {
        amount: ownEntry.balanceAfterAmount,
        currency: transaction.money.currency,
      };
    }
    return this.balanceObservedAt(
      em,
      transaction.walletId,
      transaction.money.currency,
      transaction.processedAt ?? transaction.createdAt,
    );
  }

  private async balanceObservedAt(
    em: EntityManager,
    walletId: string,
    currency: string,
    at: Date,
  ): Promise<MoneyProps> {
    const row = (await em.findOne(
      WalletLedgerEntryEntity,
      { walletId, createdAt: { $lte: at } },
      {
        orderBy: { createdAt: 'DESC', id: 'DESC' },
        fields: ['balanceAfterAmount'],
      },
    )) as unknown as { balanceAfterAmount: string } | null;
    if (row) {
      return { amount: row.balanceAfterAmount, currency };
    }
    return Money.zero(currency).toJSON();
  }
}
