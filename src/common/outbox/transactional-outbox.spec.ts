import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { FailureCode } from '../../domain/failure-code.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/ledger/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.js';
import type { IntegrationEvent } from '../../domain/integration-event/integration-event.js';
import {
  currentEventContext,
  settlementEvents,
} from './transactional-outbox.js';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

const NOW = new Date('2026-09-04T12:00:00.000Z');

function wallet(initial: string = '100.00'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
  });
}

function makeTransaction(
  kind: WagerTransactionKind,
  reference?: string,
): WagerTransaction {
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
    referenceExternalTransactionId: reference,
    createdAt: NOW,
  });
}

function eventTypes(events: IntegrationEvent<unknown>[]): string[] {
  return events.map((event) => event.eventType);
}

describe('settlementEvents', () => {
  it('emits Processed + WalletBalanceChanged for a movement with a ledger entry', () => {
    const w = wallet();
    const transaction = makeTransaction(WagerTransactionKind.Bet);
    const entry = w.debit({
      entryId: 'entry-1',
      transactionId: transaction.id,
      money: brl('25.00'),
    });
    transaction.markProcessed(undefined, NOW);

    const events = settlementEvents({
      transaction,
      beforeStatus: WagerTransactionStatus.Pending,
      wallet: w,
      entry,
      ctx: currentEventContext(NOW),
    });

    expect(eventTypes(events)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(events[0].toJSON().data).toMatchObject({
      transactionId: transaction.id,
      kind: WagerTransactionKind.Bet,
      balanceAfter: { amount: '75.00', currency: 'BRL' },
    });
    expect(events[1].toJSON().data).toEqual({
      walletId: 'wallet-1',
      transactionId: transaction.id,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('emits only Processed without balance for a LOSS', () => {
    const w = wallet();
    const transaction = makeTransaction(WagerTransactionKind.Loss);
    transaction.markProcessed(undefined, NOW);

    const events = settlementEvents({
      transaction,
      beforeStatus: WagerTransactionStatus.Pending,
      wallet: w,
      ctx: currentEventContext(NOW),
    });

    expect(eventTypes(events)).toEqual(['WagerTransactionProcessed']);
    expect(
      (events[0].toJSON().data as { balanceAfter?: unknown }).balanceAfter,
    ).toBeUndefined();
  });

  it('emits only Rejected for a business rejection without touching balance', () => {
    const w = wallet();
    const transaction = makeTransaction(WagerTransactionKind.Bet);
    transaction.reject(FailureCode.INSUFFICIENT_FUNDS);

    const events = settlementEvents({
      transaction,
      beforeStatus: WagerTransactionStatus.Pending,
      wallet: w,
      ctx: currentEventContext(NOW),
    });

    expect(eventTypes(events)).toEqual(['WagerTransactionRejected']);
    expect(events[0].toJSON().data).toMatchObject({
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
    });
  });

  it('emits PendingReference only on the first transition to PENDING_REFERENCE', () => {
    const w = wallet();
    const transaction = makeTransaction(WagerTransactionKind.Refund, 'bet-1');
    transaction.markPendingReference();

    const first = settlementEvents({
      transaction,
      beforeStatus: WagerTransactionStatus.Pending,
      wallet: w,
      ctx: currentEventContext(NOW),
    });
    expect(eventTypes(first)).toEqual(['WagerTransactionPendingReference']);

    const alreadyPending = settlementEvents({
      transaction,
      beforeStatus: WagerTransactionStatus.PendingReference,
      wallet: w,
      ctx: currentEventContext(NOW),
    });
    expect(eventTypes(alreadyPending)).toEqual([]);
  });

  it('emits Processed + WalletBalanceChanged for an internal OPENING', () => {
    const opened = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-2',
      initialBalance: brl('1000.00'),
    });
    const opening = WagerTransaction.create({
      id: 'opening-1',
      providerId: 'jungle-internal',
      externalTransactionId: 'opening-1',
      idempotencyKey: 'opening-1',
      payloadHash: 'hash-opening',
      walletId: 'wallet-2',
      playerId: 'player-2',
      roundId: '',
      gameId: '',
      kind: WagerTransactionKind.Opening,
      money: brl('1000.00'),
      createdAt: NOW,
    });
    opening.markProcessed(undefined, NOW);
    const zero = Money.zero('BRL');
    const entry = WalletLedgerEntry.create({
      id: 'entry-opening',
      walletId: opened.id,
      transactionId: opening.id,
      direction: LedgerDirection.Credit,
      money: brl('1000.00'),
      balanceBefore: zero,
      balanceAfter: opened.balance,
      createdAt: NOW,
    });

    const events = settlementEvents({
      transaction: opening,
      beforeStatus: WagerTransactionStatus.Pending,
      wallet: opened,
      entry,
      ctx: currentEventContext(NOW),
    });

    expect(eventTypes(events)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(events[1].toJSON().data).toMatchObject({
      walletId: 'wallet-2',
      transactionId: opening.id,
      direction: 'CREDIT',
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
    });
  });
});
