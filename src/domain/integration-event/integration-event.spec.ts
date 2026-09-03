import { Money } from '../money/money.js';
import { Wallet } from '../wallet/wallet.js';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';
import { FailureCode } from '../failure-code.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction/wager-transaction.js';
import {
  EventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './integration-event.js';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

const CTX: EventContext = {
  correlationId: 'corr-1',
  causationId: 'cause-1',
  eventId: 'evt-1',
  occurredAt: new Date('2026-09-03T12:00:00.000Z'),
};

function wallet(initial: string = '100.00'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
  });
}

function transaction(kind: WagerTransactionKind): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    createdAt: CTX.occurredAt!,
  });
}

describe('IntegrationEvent envelope', () => {
  it('serializes the abstract envelope with ISO-8601 occurredAt', () => {
    const w = wallet();
    const entry = w.credit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: brl('25.00'),
    });

    const event = WalletBalanceChanged.from(w, entry, CTX);
    const json = event.toJSON();

    expect(json.eventId).toBe('evt-1');
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('wallet-1');
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('cause-1');
    expect(json.occurredAt).toBe('2026-09-03T12:00:00.000Z');
    expect(json.data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Credit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '125.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });
});

describe('WagerTransactionProcessed', () => {
  it('carries the transaction with its resulting balance', () => {
    const t = transaction(WagerTransactionKind.Bet);
    t.markProcessed(undefined, CTX.occurredAt!);

    const event = WagerTransactionProcessed.from(t, brl('75.00').toJSON(), CTX);

    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.aggregateId).toBe('tx-1');
    expect(event.toJSON().data).toMatchObject({
      transactionId: 'tx-1',
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Processed,
      balanceAfter: { amount: '75.00', currency: 'BRL' },
    });
  });

  it('omits the resulting balance for LOSS', () => {
    const t = transaction(WagerTransactionKind.Loss);
    t.markProcessed(undefined, CTX.occurredAt!);

    const event = WagerTransactionProcessed.from(t, undefined, CTX);
    expect(event.toJSON().data.balanceAfter).toBeUndefined();
    expect(event.toJSON().data.money).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });
});

describe('WagerTransactionRejected', () => {
  it('carries a registered failureCode', () => {
    const t = transaction(WagerTransactionKind.Bet);
    t.reject(FailureCode.INSUFFICIENT_FUNDS);

    const event = WagerTransactionRejected.from(t, CTX);

    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.toJSON().data).toMatchObject({
      transactionId: 'tx-1',
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
    });
  });

  it('refuses to build from a transaction without a failureCode', () => {
    const t = transaction(WagerTransactionKind.Bet);
    expect(() => WagerTransactionRejected.from(t, CTX)).toThrow();
  });
});

describe('WagerTransactionPendingReference', () => {
  it('carries the awaited external reference', () => {
    const t = WagerTransaction.create({
      id: 'tx-2',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-2',
      idempotencyKey: 'provider-a:transaction-2',
      payloadHash: 'hash-2',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'transaction-0',
      createdAt: CTX.occurredAt!,
    });
    t.markPendingReference();

    const event = WagerTransactionPendingReference.from(t, CTX);

    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.toJSON().data).toMatchObject({
      transactionId: 'tx-2',
      status: WagerTransactionStatus.PendingReference,
      referenceExternalTransactionId: 'transaction-0',
    });
  });
});
