import { Money } from '../money/money.js';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';
import { FailureCode } from '../failure-code.js';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  MissingReferenceError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from './wager-transaction.js';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

const NOW = new Date('2026-09-03T12:00:00.000Z');

function txProps(): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: NOW,
  };
}

interface Overrides {
  kind?: WagerTransactionKind;
  referenceExternalTransactionId?: string;
}

function tx(
  kind: WagerTransactionKind,
  overrides: Overrides = {},
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
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    createdAt: NOW,
  });
}

describe('WagerTransaction.create', () => {
  it('creates a BET in PENDING without a reference', () => {
    const t = tx(WagerTransactionKind.Bet);

    expect(t.status).toBe(WagerTransactionStatus.Pending);
    expect(t.isTerminal()).toBe(false);
    expect(t.requiresReference()).toBe(false);
    expect(t.affectsBalance()).toBe(true);
    expect(t.referenceExternalTransactionId).toBeUndefined();
    expect(t.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('creates a LOSS without a reference and without balance effect', () => {
    const t = tx(WagerTransactionKind.Loss);
    expect(t.affectsBalance()).toBe(false);
    expect(t.requiresReference()).toBe(false);
  });

  it('requires a reference for REFUND and ROLLBACK', () => {
    expect(() => tx(WagerTransactionKind.Refund)).toThrow(
      MissingReferenceError,
    );
    expect(() => tx(WagerTransactionKind.Rollback)).toThrow(
      MissingReferenceError,
    );

    const refund = tx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'transaction-0',
    });
    const rollback = tx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'transaction-0',
    });
    expect(refund.requiresReference()).toBe(true);
    expect(rollback.requiresReference()).toBe(true);
  });

  it('forbids an internal OPENING from carrying a reference', () => {
    expect(() =>
      tx(WagerTransactionKind.Opening, {
        referenceExternalTransactionId: 'transaction-0',
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('requires a non-empty idempotency key', () => {
    expect(() =>
      WagerTransaction.create({
        ...txProps(),
        idempotencyKey: '   ',
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('requires a non-empty payload hash', () => {
    expect(() =>
      WagerTransaction.create({
        ...txProps(),
        payloadHash: '',
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction state transitions', () => {
  it('marks a PENDING transaction as PROCESSED (terminal)', () => {
    const t = tx(WagerTransactionKind.Bet);
    t.markProcessed(undefined, NOW);

    expect(t.status).toBe(WagerTransactionStatus.Processed);
    expect(t.isTerminal()).toBe(true);
    expect(t.processedAt).toBe(NOW);
    expect(t.referenceTransactionId).toBeUndefined();
  });

  it('stores the resolved reference id when processed', () => {
    const t = tx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'transaction-0',
    });
    t.markProcessed('tx-internal-0', NOW);

    expect(t.referenceTransactionId).toBe('tx-internal-0');
  });

  it('refuses further transitions once terminal', () => {
    const t = tx(WagerTransactionKind.Bet);
    t.markProcessed(undefined, NOW);

    expect(() => t.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => t.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => t.fail(FailureCode.STORAGE_FAILURE)).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('moves PENDING -> PENDING_REFERENCE and later resolves it', () => {
    const t = tx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'transaction-0',
    });
    t.markPendingReference();
    expect(t.status).toBe(WagerTransactionStatus.PendingReference);

    t.markProcessed('tx-internal-0', NOW);
    expect(t.status).toBe(WagerTransactionStatus.Processed);
  });

  it('rejects a PENDING_REFERENCE when the reference never arrives', () => {
    const t = tx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'transaction-0',
    });
    t.markPendingReference();

    t.reject(FailureCode.UNRESOLVED_REFERENCE);
    expect(t.status).toBe(WagerTransactionStatus.Rejected);
    expect(t.failureCode).toBe(FailureCode.UNRESOLVED_REFERENCE);
  });

  it('only arms PENDING_REFERENCE from PENDING', () => {
    const t = tx(WagerTransactionKind.Bet);
    t.markProcessed(undefined, NOW);
    expect(() => t.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('rejects with a registered FailureCode', () => {
    const t = tx(WagerTransactionKind.Bet);
    t.reject(FailureCode.INSUFFICIENT_FUNDS);

    expect(t.status).toBe(WagerTransactionStatus.Rejected);
    expect(t.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(t.isTerminal()).toBe(true);
    expect(t.processedAt).toBeUndefined();
  });

  it('fails with an infrastructure FailureCode', () => {
    const t = tx(WagerTransactionKind.Bet);
    t.fail(FailureCode.STORAGE_FAILURE);

    expect(t.status).toBe(WagerTransactionStatus.Failed);
    expect(t.failureCode).toBe(FailureCode.STORAGE_FAILURE);
  });

  it('rejects unknown failure codes', () => {
    const t = tx(WagerTransactionKind.Bet);
    expect(() => t.reject('NOT_REGISTERED' as never)).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction ledger direction', () => {
  it('maps BET to DEBIT', () => {
    expect(tx(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(
      LedgerDirection.Debit,
    );
  });

  it('maps WIN, REFUND and OPENING to CREDIT', () => {
    expect(tx(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(
      tx(WagerTransactionKind.Refund, {
        referenceExternalTransactionId: 'transaction-0',
      }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    expect(tx(WagerTransactionKind.Opening).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  it('inverts the reference direction for ROLLBACK', () => {
    const bet = tx(WagerTransactionKind.Bet);
    const win = tx(WagerTransactionKind.Win);

    const rollbackOfBet = tx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollbackOfWin = tx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: win.externalTransactionId,
    });

    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollbackOfWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it('throws for ROLLBACK without a reference and for LOSS', () => {
    const rollback = tx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'transaction-0',
    });
    expect(() => rollback.ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => tx(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('rebuilds a persisted transaction without re-validating transitions', () => {
    const t = WagerTransaction.rehydrate({
      id: 'tx-9',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-9',
      idempotencyKey: 'provider-a:transaction-9',
      payloadHash: 'hash-9',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-9',
      gameId: 'game-9',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'transaction-1',
      createdAt: NOW,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: 'tx-internal-1',
      processedAt: NOW,
    });

    expect(t.status).toBe(WagerTransactionStatus.Processed);
    expect(t.isTerminal()).toBe(true);
    expect(t.referenceTransactionId).toBe('tx-internal-1');
    expect(t.processedAt).toBe(NOW);
  });
});
