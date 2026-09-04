import { InvalidWagerPayloadError } from '../wagering/wager-transaction.service.js';
import {
  InvalidSqsMessageError,
  parseWagerQueueMessage,
  WAGER_CONSUMER_NAME,
  WAGER_TRANSACTION_EVENT_TYPE,
} from './sqs-message.js';

function envelope(messageId: string, data: Record<string, unknown>) {
  return JSON.stringify({
    messageId,
    type: WAGER_TRANSACTION_EVENT_TYPE,
    occurredAt: '2026-09-04T15:00:00.000Z',
    data,
  });
}

function validData(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    playerId: 'player-1',
    walletId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

describe('parseWagerQueueMessage', () => {
  it('parses a valid WagerTransactionRequested envelope', () => {
    const parsed = parseWagerQueueMessage(envelope('msg-1', validData()));
    expect(parsed.messageId).toBe('msg-1');
    expect(parsed.data).toMatchObject({
      providerId: 'provider-a',
      idempotencyKey: 'provider-a:transaction-1',
      kind: 'BET',
    });
    expect(parsed.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('propagates a permanent payload error for an invalid kind', () => {
    expect(() =>
      parseWagerQueueMessage(
        envelope('msg-2', validData({ kind: 'CASHBACK' })),
      ),
    ).toThrow(InvalidWagerPayloadError);
  });

  const invalidEnvelopes = [
    {
      name: 'rejects a non-JSON body',
      body: 'not json',
    },
    {
      name: 'rejects an unsupported type',
      body: JSON.stringify({ messageId: 'm', type: 'SomethingElse', data: {} }),
    },
    {
      name: 'rejects a missing messageId',
      body: envelope('', validData()),
    },
    {
      name: 'rejects a non-object data',
      body: JSON.stringify({
        messageId: 'm',
        type: WAGER_TRANSACTION_EVENT_TYPE,
        data: 'x',
      }),
    },
  ];

  for (const { name, body } of invalidEnvelopes) {
    it(name, () => {
      expect(() => parseWagerQueueMessage(body)).toThrow(
        InvalidSqsMessageError,
      );
    });
  }

  it('exposes the consumer name used for inbox dedup', () => {
    expect(WAGER_CONSUMER_NAME).toBe('wager-transactions-consumer');
  });
});
