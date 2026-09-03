import { Money } from '../money/money.js';
import { FailureCode } from '../failure-code.js';
import { Wallet } from '../wallet/wallet.js';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction/wager-transaction.js';
import {
  applyWagerTransaction,
  type ApplyWagerTransactionProps,
  type WagerApplyResult,
} from './wager-transaction-applier.js';

const NOW = new Date('2026-09-03T12:00:00.000Z');

interface TxConfig {
  id?: string;
  providerId?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  gameId?: string;
  externalTransactionId?: string;
  amount?: string;
  currency?: string;
  referenceExternalTransactionId?: string;
}

let seq = 0;

function buildTx(
  kind: WagerTransactionKind,
  config: TxConfig = {},
): WagerTransaction {
  const n = (seq += 1);
  return WagerTransaction.create({
    id: config.id ?? `tx-${n}`,
    providerId: config.providerId ?? 'provider-a',
    externalTransactionId: config.externalTransactionId ?? `ext-${n}`,
    idempotencyKey: `provider-a:ext-${n}`,
    payloadHash: `hash-${n}`,
    walletId: config.walletId ?? 'wallet-1',
    playerId: config.playerId ?? 'player-1',
    roundId: config.roundId ?? 'round-1',
    gameId: config.gameId ?? 'game-1',
    kind,
    money: Money.from({
      amount: config.amount ?? '25.00',
      currency: config.currency ?? 'BRL',
    }),
    referenceExternalTransactionId: config.referenceExternalTransactionId,
    createdAt: NOW,
  });
}

function processed(
  kind: WagerTransactionKind,
  config: TxConfig = {},
): WagerTransaction {
  const tx = buildTx(kind, config);
  tx.markProcessed(undefined, NOW);
  return tx;
}

function wallet(balance: string = '100.00', id: string = 'wallet-1'): Wallet {
  return Wallet.open({
    id,
    playerId: 'player-1',
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
  });
}

function apply(
  wallet: Wallet,
  transaction: WagerTransaction,
  cfg: Partial<
    Pick<ApplyWagerTransactionProps, 'reference' | 'referenceAlreadyReversed'>
  > = {},
): WagerApplyResult {
  return applyWagerTransaction({
    wallet,
    transaction,
    now: NOW,
    ...cfg,
  });
}

function expectRejected(
  result: WagerApplyResult,
  wallet: Wallet,
  transaction: WagerTransaction,
  code: FailureCode,
  balanceBefore: string,
): void {
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.failureCode).toBe(code);
  }
  expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
  expect(transaction.failureCode).toBe(code);
  expect(transaction.isTerminal()).toBe(true);
  expect(wallet.balance.toJSON().amount).toBe(balanceBefore);
  expect(wallet.version).toBe(1);
}

describe('WagerTransactionApplier guards', () => {
  it('refuses to apply a transaction in a terminal state', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, NOW);

    expect(() => apply(w, tx)).toThrow(
      /must be PENDING or PENDING_REFERENCE to be applied/,
    );
  });

  it('refuses to apply a transaction against a foreign wallet', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Bet, { walletId: 'wallet-2' });

    expect(() => apply(w, tx)).toThrow(/does not belong to transaction/);
  });

  it('rejects internal OPENING transactions', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Opening);

    const result = apply(w, tx);
    expectRejected(result, w, tx, FailureCode.OPENING_NOT_ALLOWED, '100.00');
  });

  it('rejects a currency mismatch between transaction and wallet', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Bet, { currency: 'USD' });

    const result = apply(w, tx);
    expectRejected(result, w, tx, FailureCode.CURRENCY_MISMATCH, '100.00');
  });
});

describe('WagerTransactionApplier direct kinds', () => {
  it('settles a BET with a single DEBIT ledger entry', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Bet, { amount: '25.00' });

    const result = apply(w, tx);

    expect(result.kind).toBe('processed');
    if (result.kind === 'processed') {
      expect(result.entry?.direction).toBe(LedgerDirection.Debit);
      expect(result.entry?.isBalanced()).toBe(true);
      expect(result.entry?.balanceAfter.toJSON().amount).toBe('75.00');
    }
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toBe(NOW);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('75.00');
    expect(w.version).toBe(2);
  });

  it('accepts a BET that exactly empties the wallet', () => {
    const w = wallet('25.00');
    const tx = buildTx(WagerTransactionKind.Bet, { amount: '25.00' });

    const result = apply(w, tx);

    expect(result.kind).toBe('processed');
    expect(w.balance.isZero()).toBe(true);
  });

  it('rejects a BET with insufficient funds without mutating the wallet', () => {
    const w = wallet('10.00');
    const tx = buildTx(WagerTransactionKind.Bet, { amount: '25.00' });

    const result = apply(w, tx);
    expectRejected(result, w, tx, FailureCode.INSUFFICIENT_FUNDS, '10.00');
  });

  it('settles a WIN with a single CREDIT ledger entry', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Win, { amount: '50.00' });

    const result = apply(w, tx);

    expect(result.kind).toBe('processed');
    if (result.kind === 'processed') {
      expect(result.entry?.direction).toBe(LedgerDirection.Credit);
    }
    expect(w.balance.toJSON().amount).toBe('150.00');
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  it('settles a LOSS with no balance movement and no ledger entry', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Loss, { amount: '25.00' });

    const result = apply(w, tx);

    expect(result.kind).toBe('processed');
    if (result.kind === 'processed') {
      expect(result.entry).toBeUndefined();
    }
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(w.version).toBe(1);
  });
});

describe('WagerTransactionApplier REFUND rules', () => {
  it('moves REFUND into PENDING_REFERENCE when the reference is missing', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'ext-999',
    });

    const result = apply(w, tx);

    expect(result.kind).toBe('pendingReference');
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(w.balance.toJSON().amount).toBe('100.00');
  });

  it('stays PENDING_REFERENCE while the reference is still PENDING', () => {
    const w = wallet('100.00');
    const ref = buildTx(WagerTransactionKind.Bet, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    const result = apply(w, tx, { reference: ref });

    expect(result.kind).toBe('pendingReference');
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });

  it('rejects a REFUND whose reference reached a terminal non-PROCESSED state', () => {
    const w = wallet('100.00');
    const ref = buildTx(WagerTransactionKind.Bet, { amount: '25.00' });
    ref.reject(FailureCode.INSUFFICIENT_FUNDS);
    const tx = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    const result = apply(w, tx, { reference: ref });

    expectRejected(
      result,
      w,
      tx,
      FailureCode.REFERENCE_NOT_PROCESSED,
      '100.00',
    );
  });

  it('rejects a REFUND of a non-BET reference', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Win, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    const result = apply(w, tx, { reference: ref });

    expectRejected(result, w, tx, FailureCode.REFUND_OF_NON_BET, '100.00');
  });

  it('rejects a REFUND when the reference was already reversed by a REFUND', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Bet, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    const result = apply(w, tx, {
      reference: ref,
      referenceAlreadyReversed: true,
    });

    expectRejected(
      result,
      w,
      tx,
      FailureCode.REFERENCE_ALREADY_REVERSED,
      '100.00',
    );
  });

  it('rejects a REFUND whose amount differs from the reference', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Bet, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Refund, {
      amount: '30.00',
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    const result = apply(w, tx, { reference: ref });

    expectRejected(
      result,
      w,
      tx,
      FailureCode.REFERENCE_AMOUNT_MISMATCH,
      '100.00',
    );
  });

  const mismatchedScope = [
    { field: 'providerId', override: 'provider-b', walletId: 'wallet-1' },
    { field: 'playerId', override: 'player-2', walletId: 'wallet-1' },
    { field: 'walletId', override: 'wallet-2', walletId: 'wallet-2' },
    { field: 'roundId', override: 'round-2', walletId: 'wallet-1' },
  ] as const;

  for (const { field, override, walletId } of mismatchedScope) {
    it(`rejects a REFUND whose reference has a different ${field}`, () => {
      const w = wallet('100.00', walletId);
      const ref = processed(WagerTransactionKind.Bet, { amount: '25.00' });
      const tx = buildTx(WagerTransactionKind.Refund, {
        referenceExternalTransactionId: ref.externalTransactionId,
        walletId,
        [field]: override,
      });

      const result = apply(w, tx, { reference: ref });

      expectRejected(
        result,
        w,
        tx,
        FailureCode.REFERENCE_SCOPE_MISMATCH,
        '100.00',
      );
    });
  }

  it('rejects a REFUND whose reference is in a different currency', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Bet, {
      amount: '25.00',
      currency: 'USD',
    });
    const tx = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    const result = apply(w, tx, { reference: ref });

    expectRejected(
      result,
      w,
      tx,
      FailureCode.REFERENCE_SCOPE_MISMATCH,
      '100.00',
    );
  });

  it('credits the wallet when refunding a processed BET', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Bet, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: ref.externalTransactionId,
      amount: '25.00',
    });

    const result = apply(w, tx, { reference: ref });

    expect(result.kind).toBe('processed');
    if (result.kind === 'processed') {
      expect(result.entry?.direction).toBe(LedgerDirection.Credit);
      expect(result.entry?.balanceAfter.toJSON().amount).toBe('125.00');
    }
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe(ref.id);
    expect(w.balance.toJSON().amount).toBe('125.00');
    expect(w.version).toBe(2);
  });
});

describe('WagerTransactionApplier ROLLBACK rules', () => {
  it('credits the wallet when rolling back a BET', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Bet, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: ref.externalTransactionId,
      amount: '25.00',
    });

    const result = apply(w, tx, { reference: ref });

    expect(result.kind).toBe('processed');
    if (result.kind === 'processed') {
      expect(result.entry?.direction).toBe(LedgerDirection.Credit);
    }
    expect(w.balance.toJSON().amount).toBe('125.00');
    expect(tx.referenceTransactionId).toBe(ref.id);
  });

  it('debits the wallet when rolling back a WIN', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Win, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: ref.externalTransactionId,
      amount: '25.00',
    });

    const result = apply(w, tx, { reference: ref });

    expect(result.kind).toBe('processed');
    if (result.kind === 'processed') {
      expect(result.entry?.direction).toBe(LedgerDirection.Debit);
    }
    expect(w.balance.toJSON().amount).toBe('75.00');
    expect(w.version).toBe(2);
  });

  it('debits the wallet when rolling back a REFUND', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Refund, {
      amount: '25.00',
      referenceExternalTransactionId: 'ext-bet-1',
    });
    const tx = buildTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: ref.externalTransactionId,
      amount: '25.00',
    });

    const result = apply(w, tx, { reference: ref });

    expect(result.kind).toBe('processed');
    if (result.kind === 'processed') {
      expect(result.entry?.direction).toBe(LedgerDirection.Debit);
    }
    expect(w.balance.toJSON().amount).toBe('75.00');
  });

  it('rejects a ROLLBACK of an unsupported reference kind', () => {
    const w = wallet('100.00');
    const innerBet = processed(WagerTransactionKind.Bet, { amount: '25.00' });
    const ref = processed(WagerTransactionKind.Rollback, {
      amount: '25.00',
      referenceExternalTransactionId: innerBet.externalTransactionId,
    });
    const tx = buildTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: ref.externalTransactionId,
      amount: '25.00',
    });

    const result = apply(w, tx, { reference: ref });

    expectRejected(
      result,
      w,
      tx,
      FailureCode.UNSUPPORTED_REVERSAL_REFERENCE,
      '100.00',
    );
  });

  it('rejects a ROLLBACK that would overdraw the wallet with a distinct code', () => {
    const w = wallet('10.00');
    const ref = processed(WagerTransactionKind.Win, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: ref.externalTransactionId,
      amount: '25.00',
    });

    const result = apply(w, tx, { reference: ref });

    expectRejected(result, w, tx, FailureCode.REVERSAL_WOULD_OVERDRAW, '10.00');
  });

  it('rejects a ROLLBACK when the reference was already reversed by a ROLLBACK', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Bet, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: ref.externalTransactionId,
      amount: '25.00',
    });

    const result = apply(w, tx, {
      reference: ref,
      referenceAlreadyReversed: true,
    });

    expectRejected(
      result,
      w,
      tx,
      FailureCode.REFERENCE_ALREADY_REVERSED,
      '100.00',
    );
  });

  it('rejects a ROLLBACK whose amount differs from the reference', () => {
    const w = wallet('100.00');
    const ref = processed(WagerTransactionKind.Bet, { amount: '25.00' });
    const tx = buildTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: ref.externalTransactionId,
      amount: '30.00',
    });

    const result = apply(w, tx, { reference: ref });

    expectRejected(
      result,
      w,
      tx,
      FailureCode.REFERENCE_AMOUNT_MISMATCH,
      '100.00',
    );
  });

  it('moves ROLLBACK into PENDING_REFERENCE when the reference is missing', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'ext-999',
    });

    const result = apply(w, tx);

    expect(result.kind).toBe('pendingReference');
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

describe('WagerTransactionApplier reprocessing of PENDING_REFERENCE', () => {
  it('applies a PENDING_REFERENCE reversal once its reference arrives', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'ext-bet-1',
      amount: '25.00',
    });

    expect(apply(w, tx).kind).toBe('pendingReference');
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);

    const bet = processed(WagerTransactionKind.Bet, {
      externalTransactionId: 'ext-bet-1',
      amount: '25.00',
    });
    const result = apply(w, tx, { reference: bet });

    expect(result.kind).toBe('processed');
    if (result.kind === 'processed') {
      expect(result.entry?.direction).toBe(LedgerDirection.Credit);
    }
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe(bet.id);
    expect(w.balance.toJSON().amount).toBe('125.00');
  });

  it('keeps a PENDING_REFERENCE reversal pending while its reference is still missing', () => {
    const w = wallet('100.00');
    const tx = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'ext-bet-1',
      amount: '25.00',
    });

    expect(apply(w, tx).kind).toBe('pendingReference');
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);

    const result = apply(w, tx);

    expect(result.kind).toBe('pendingReference');
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(w.balance.toJSON().amount).toBe('100.00');
  });
});

describe('WagerTransactionApplier end-to-end ledger consistency', () => {
  it('keeps wallet balance consistent with the produced ledger after a mixed sequence', () => {
    const w = wallet('100.00');
    const entries = [];

    const bet = buildTx(WagerTransactionKind.Bet, { amount: '30.00' });
    entries.push(apply(w, bet));

    const win = buildTx(WagerTransactionKind.Win, { amount: '50.00' });
    entries.push(apply(w, win));

    const loss = buildTx(WagerTransactionKind.Loss, { amount: '30.00' });
    entries.push(apply(w, loss));

    const refund = buildTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
      amount: '30.00',
    });
    entries.push(apply(w, refund, { reference: bet }));

    const ledgerEntries = entries
      .map((result) =>
        result.kind === 'processed' && result.entry ? result.entry : null,
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    expect(ledgerEntries.length).toBe(3);
    expect(w.balance.toJSON().amount).toBe('150.00');

    const reconstructed = ledgerEntries[ledgerEntries.length - 1].balanceAfter;
    expect(reconstructed.equals(w.balance)).toBe(true);
  });
});
