import { CurrencyMismatchError, Money } from '../money/money.js';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';
import { InsufficientFundsError, Wallet } from './wallet.js';

const NOW = new Date('2026-09-03T12:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function openWallet(initial: string = '100.00'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
  });
}

describe('Wallet.open', () => {
  it('starts with balance, currency and version 1', () => {
    const wallet = openWallet('1000.00');

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON()).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toBeInstanceOf(Date);
    expect(wallet.updatedAt).toBeInstanceOf(Date);
  });
});

describe('Wallet.debit', () => {
  it('debits the balance, increments version and returns a balanced debit entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: brl('25.00'),
    });

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.equals(entry.balanceAfter)).toBe(true);
  });

  it('allows a debit that empties the balance exactly', () => {
    const wallet = openWallet('80.00');
    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: brl('80.00'),
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.balance.isNegative()).toBe(false);
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects an overdraft and leaves state untouched', () => {
    const wallet = openWallet('10.00');

    expect(() =>
      wallet.debit({
        entryId: 'entry-1',
        transactionId: 'tx-1',
        money: brl('25.00'),
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects a debit in a different currency', () => {
    const wallet = openWallet('10.00');

    expect(() =>
      wallet.debit({
        entryId: 'entry-1',
        transactionId: 'tx-1',
        money: Money.from({ amount: '1.00', currency: 'USD' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet.credit', () => {
  it('credits the balance, increments version and returns a balanced credit entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: brl('25.00'),
    });

    expect(wallet.balance.toJSON().amount).toBe('125.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('125.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects a credit in a different currency', () => {
    const wallet = openWallet('10.00');

    expect(() =>
      wallet.credit({
        entryId: 'entry-1',
        transactionId: 'tx-1',
        money: Money.from({ amount: '1.00', currency: 'USD' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet versioning', () => {
  it('increments version exactly once per balance change', () => {
    const wallet = openWallet('100.00');

    wallet.credit({ entryId: 'e1', transactionId: 't1', money: brl('5.00') });
    wallet.debit({ entryId: 'e2', transactionId: 't2', money: brl('5.00') });
    wallet.credit({ entryId: 'e3', transactionId: 't3', money: brl('5.00') });

    expect(wallet.version).toBe(4);
  });

  it('updates updatedAt on every balance change', async () => {
    const wallet = openWallet('100.00');
    const before = wallet.updatedAt.getTime();
    await new Promise((resolve) => setTimeout(resolve, 5));

    wallet.credit({ entryId: 'e1', transactionId: 't1', money: brl('5.00') });

    expect(wallet.updatedAt.getTime()).toBeGreaterThan(before);
  });
});

describe('Wallet invariants', () => {
  it('reconstructing the ledger reproduces the materialized balance', () => {
    const wallet = openWallet('100.00');
    const entries = [
      wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('30.00') }),
      wallet.credit({
        entryId: 'e2',
        transactionId: 't2',
        money: brl('50.00'),
      }),
      wallet.debit({ entryId: 'e3', transactionId: 't3', money: brl('10.00') }),
    ];

    const reconstructed = entries.reduce(
      (balance, entry) => entry.balanceAfter,
      entries[0].balanceAfter,
    );

    expect(wallet.balance.equals(reconstructed)).toBe(true);
    expect(wallet.balance.toJSON().amount).toBe('110.00');
    for (const entry of entries) {
      expect(entry.isBalanced()).toBe(true);
    }
  });

  it('keeps the ledger chain contiguous across balance changes', () => {
    const wallet = openWallet('100.00');
    const first = wallet.debit({
      entryId: 'e1',
      transactionId: 't1',
      money: brl('30.00'),
    });
    const second = wallet.credit({
      entryId: 'e2',
      transactionId: 't2',
      money: brl('50.00'),
    });

    expect(first.balanceBefore.toJSON().amount).toBe('100.00');
    expect(first.balanceAfter.toJSON().amount).toBe('70.00');
    expect(second.balanceBefore.equals(first.balanceAfter)).toBe(true);
    expect(second.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(3);
  });

  it('never exposes a negative balance through the ledger', () => {
    const wallet = openWallet('5.00');
    expect(() =>
      wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('10.00') }),
    ).toThrow(InsufficientFundsError);
    expect(wallet.balance.isNegative()).toBe(false);
  });
});

describe('Wallet.rehydrate', () => {
  it('rebuilds a wallet from persisted state without re-running transitions', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: { amount: '75.00', currency: 'BRL' },
      version: 4,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(wallet.id).toBe('wallet-9');
    expect(wallet.version).toBe(4);
    expect(wallet.balance.toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
  });
});
