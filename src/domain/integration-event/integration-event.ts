import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../money/money.js';
import type { Wallet } from '../wallet/wallet.js';
import type {
  LedgerDirection,
  WalletLedgerEntry,
} from '../ledger/wallet-ledger-entry.js';
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction/wager-transaction.js';
import type { FailureCode } from '../failure-code.js';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface EventContext {
  correlationId: string;
  causationId?: string;
  eventId?: string;
  occurredAt?: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

function contextProps(
  ctx: EventContext,
): Pick<
  IntegrationEventProps<never>,
  'eventId' | 'correlationId' | 'causationId' | 'occurredAt'
> {
  return {
    eventId: ctx.eventId ?? randomUUID(),
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt ?? new Date(),
  };
}

interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function wagerTransactionEventData(
  transaction: WagerTransaction,
): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId,
  };
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  status: WagerTransactionStatus;
  balanceAfter?: MoneyProps;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  status: WagerTransactionStatus;
  failureCode: FailureCode;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  status: WagerTransactionStatus;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionProcessedData>,
  ) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    balanceAfter: MoneyProps | undefined,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    const envelope = contextProps(ctx);
    return new WagerTransactionProcessed({
      ...envelope,
      aggregateId: transaction.id,
      data: {
        ...wagerTransactionEventData(transaction),
        status: transaction.status,
        balanceAfter,
        processedAt: (
          transaction.processedAt ?? envelope.occurredAt
        ).toISOString(),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionRejectedData>,
  ) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    if (!transaction.failureCode) {
      throw new Error(
        `transaction '${transaction.id}' is rejected without a FailureCode`,
      );
    }
    const envelope = contextProps(ctx);
    return new WagerTransactionRejected({
      ...envelope,
      aggregateId: transaction.id,
      data: {
        ...wagerTransactionEventData(transaction),
        status: transaction.status,
        failureCode: transaction.failureCode,
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId) {
      throw new Error(
        `transaction '${transaction.id}' entered PENDING_REFERENCE without a reference`,
      );
    }
    const envelope = contextProps(ctx);
    return new WagerTransactionPendingReference({
      ...envelope,
      aggregateId: transaction.id,
      data: {
        ...wagerTransactionEventData(transaction),
        status: transaction.status,
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    const envelope = contextProps(ctx);
    return new WalletBalanceChanged({
      ...envelope,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
