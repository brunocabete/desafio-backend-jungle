import { WagerTransactionKind } from '../domain/wager-transaction/wager-transaction.js';
import {
  InvalidWagerPayloadError,
  normalizeWagerSubmit,
} from './wager-transaction.service.js';

const BASE = {
  idempotencyKey: 'provider-a:transaction-123',
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('normalizeWagerSubmit', () => {
  it('normalizes a valid BET and computes a canonical payload hash', () => {
    const normalized = normalizeWagerSubmit(BASE);

    expect(normalized.kind).toBe(WagerTransactionKind.Bet);
    expect(normalized.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(normalized.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized.referenceExternalTransactionId).toBeUndefined();
  });

  it('trims identifiers and uppercases the kind', () => {
    const normalized = normalizeWagerSubmit({
      ...BASE,
      providerId: '  provider-a  ',
      kind: 'bet',
      money: { amount: '25', currency: 'BRL' },
    });

    expect(normalized.providerId).toBe('provider-a');
    expect(normalized.kind).toBe(WagerTransactionKind.Bet);
  });

  it('defaults the currency to BRL', () => {
    const normalized = normalizeWagerSubmit({
      ...BASE,
      money: { amount: '25.00' },
    });

    expect(normalized.money.currency).toBe('BRL');
  });

  it('produces the same hash for equivalent amounts with different formatting', () => {
    const a = normalizeWagerSubmit(BASE);
    const b = normalizeWagerSubmit({
      ...BASE,
      money: { amount: '25', currency: 'BRL' },
    });

    expect(a.payloadHash).toBe(b.payloadHash);
  });

  it('normalizes a REFUND carrying a reference', () => {
    const normalized = normalizeWagerSubmit({
      ...BASE,
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'transaction-100',
    });

    expect(normalized.kind).toBe(WagerTransactionKind.Refund);
    expect(normalized.referenceExternalTransactionId).toBe('transaction-100');
  });

  const invalidCases = [
    {
      name: 'rejects a missing idempotencyKey',
      input: { ...BASE, idempotencyKey: undefined },
    },
    {
      name: 'rejects a missing providerId',
      input: { ...BASE, providerId: '' },
    },
    {
      name: 'rejects an unknown kind',
      input: { ...BASE, kind: 'CASHBACK' },
    },
    {
      name: 'rejects a REFUND without a reference',
      input: { ...BASE, kind: 'REFUND' },
    },
    {
      name: 'rejects a ROLLBACK without a reference',
      input: { ...BASE, kind: 'ROLLBACK' },
    },
    {
      name: 'rejects an OPENING carrying a reference',
      input: {
        ...BASE,
        kind: 'OPENING',
        referenceExternalTransactionId: 'transaction-100',
      },
    },
    {
      name: 'rejects a negative amount',
      input: { ...BASE, money: { amount: '-1.00', currency: 'BRL' } },
    },
    {
      name: 'rejects an amount with more than 2 decimals',
      input: { ...BASE, money: { amount: '1.234', currency: 'BRL' } },
    },
    {
      name: 'rejects a non-string amount',
      input: { ...BASE, money: { amount: 25, currency: 'BRL' } },
    },
    {
      name: 'rejects a lowercase currency',
      input: { ...BASE, money: { amount: '25.00', currency: 'brl' } },
    },
    {
      name: 'rejects a missing money object',
      input: { ...BASE, money: undefined },
    },
    {
      name: 'rejects an empty playerId',
      input: { ...BASE, playerId: '   ' },
    },
    {
      name: 'rejects a reference longer than 128 characters',
      input: {
        ...BASE,
        kind: 'REFUND',
        referenceExternalTransactionId: 'x'.repeat(129),
      },
    },
  ] as const;

  for (const { name, input } of invalidCases) {
    it(name, () => {
      expect(() => normalizeWagerSubmit(input)).toThrow(
        InvalidWagerPayloadError,
      );
    });
  }
});
