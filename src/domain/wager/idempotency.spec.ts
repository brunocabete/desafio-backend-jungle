import { Money } from '../money/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../wager-transaction/wager-transaction.js';
import {
  classifyIdempotency,
  wagerPayloadHash,
  type WagerTransactionRequest,
} from './idempotency.js';

const NOW = new Date('2026-09-03T12:00:00.000Z');

type RawRequest = WagerTransactionRequest & {
  idempotencyKey?: string;
  messageId?: string;
  occurredAt?: string;
};

function request(overrides: Partial<RawRequest> = {}): RawRequest {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function transaction(payloadHash: string): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    payloadHash,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: NOW,
  });
}

describe('wagerPayloadHash', () => {
  it('hashes only the business fields, ignoring transport metadata', () => {
    const baseline = wagerPayloadHash(request());

    const withMetadata = wagerPayloadHash(
      request({
        idempotencyKey: 'provider-a:transaction-1',
        messageId: 'msg-1',
        occurredAt: '2026-09-03T12:00:00.000Z',
      } as RawRequest),
    );
    const withMoneyNoise = wagerPayloadHash(
      request({
        money: {
          amount: '25.00',
          currency: 'BRL',
          note: 'x',
        } as WagerTransactionRequest['money'],
      }),
    );

    expect(withMetadata).toBe(baseline);
    expect(withMoneyNoise).toBe(baseline);
  });

  it('is deterministic regardless of field insertion order', () => {
    const original = request();
    const shuffled = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as RawRequest;

    expect(wagerPayloadHash(shuffled)).toBe(wagerPayloadHash(request()));
  });

  it('changes when any business value changes', () => {
    const baseline = wagerPayloadHash(request());
    const variants = [
      request({ providerId: 'provider-b' }),
      request({ money: { amount: '80.00', currency: 'BRL' } }),
      request({ kind: 'WIN' }),
    ];

    for (const variant of variants) {
      expect(wagerPayloadHash(variant)).not.toBe(baseline);
    }
  });

  it('includes the reference only when present', () => {
    const refundWithoutReference = request({ kind: 'REFUND' });
    const refundWithReference = request({
      kind: 'REFUND',
      referenceExternalTransactionId: 'transaction-0',
    });

    expect(wagerPayloadHash(refundWithoutReference)).not.toBe(
      wagerPayloadHash(refundWithReference),
    );
    expect(wagerPayloadHash(refundWithReference)).not.toBe(
      wagerPayloadHash(request()),
    );
  });
});

describe('classifyIdempotency', () => {
  it('decides PROCESS when the idempotency key is unknown', () => {
    expect(classifyIdempotency(undefined, 'hash-1')).toBe('PROCESS');
  });

  it('decides REPLAY for the same key with an identical payload', () => {
    const existing = transaction('hash-1');
    expect(classifyIdempotency(existing, 'hash-1')).toBe('REPLAY');
  });

  it('decides CONFLICT for the same key with a diverging payload', () => {
    const existing = transaction('hash-1');
    expect(classifyIdempotency(existing, 'hash-2')).toBe('CONFLICT');
  });

  it('replays a real identical retry and conflicts on a diverging amount', () => {
    const first = wagerPayloadHash(request());
    const existing = transaction(first);

    expect(classifyIdempotency(existing, first)).toBe('REPLAY');

    const diverging = wagerPayloadHash(
      request({ money: { amount: '80.00', currency: 'BRL' } }),
    );
    expect(classifyIdempotency(existing, diverging)).toBe('CONFLICT');
  });
});
