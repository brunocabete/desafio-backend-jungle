import { CurrencyMismatchError, Money } from '../money/money.js';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
  invertLedgerDirection,
} from './wallet-ledger-entry.js';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

const NOW = new Date('2026-09-03T12:00:00.000Z');

describe('WalletLedgerEntry.create', () => {
  it('accepts a balanced debit', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('70.00'),
      createdAt: NOW,
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
  });

  it('accepts a balanced credit', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-2',
      walletId: 'wallet-1',
      transactionId: 'tx-2',
      direction: LedgerDirection.Credit,
      money: brl('30.00'),
      balanceBefore: brl('70.00'),
      balanceAfter: brl('100.00'),
      createdAt: NOW,
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('does not expose a mutable createdAt reference', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-date',
      walletId: 'wallet-1',
      transactionId: 'tx-date',
      direction: LedgerDirection.Credit,
      money: brl('30.00'),
      balanceBefore: brl('70.00'),
      balanceAfter: brl('100.00'),
      createdAt: NOW,
    });

    const exposed = entry.createdAt;
    exposed.setTime(0);

    expect(entry.createdAt).toEqual(NOW);
    expect(entry.createdAt).not.toBe(exposed);
  });

  it('rejects an unbalanced entry at creation', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-3',
        walletId: 'wallet-1',
        transactionId: 'tx-3',
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('60.00'),
        createdAt: NOW,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects entries mixing currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-4',
        walletId: 'wallet-1',
        transactionId: 'tx-4',
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '1.00', currency: 'USD' }),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('2.00'),
        createdAt: NOW,
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('rebuilds an entry without re-validating the arithmetic', () => {
    const state = {
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit as const,
      money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
      createdAt: NOW,
    };

    const entry = WalletLedgerEntry.rehydrate(state);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.id).toBe('entry-1');
    expect(entry.balanceAfter.toJSON()).toEqual({
      amount: '70.00',
      currency: 'BRL',
    });
  });
});

describe('invertLedgerDirection', () => {
  it('inverts debit to credit and vice versa', () => {
    expect(invertLedgerDirection(LedgerDirection.Debit)).toBe(
      LedgerDirection.Credit,
    );
    expect(invertLedgerDirection(LedgerDirection.Credit)).toBe(
      LedgerDirection.Debit,
    );
  });
});
