import {
  InboxMessage,
  InvalidInboxMessageStateError,
} from './inbox-message.js';

const NOW = new Date('2026-09-03T12:00:00.000Z');

describe('InboxMessage', () => {
  it('receives a message unprocessed', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt: NOW,
    });

    expect(message.messageId).toBe('msg-1');
    expect(message.consumerName).toBe('wager-consumer');
    expect(message.payloadHash).toBe('hash-1');
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('marks a message as processed exactly once', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt: NOW,
    });

    message.markProcessed(NOW);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(NOW);

    expect(() => message.markProcessed(NOW)).toThrow(
      InvalidInboxMessageStateError,
    );
  });

  it('rehydrates a processed message without re-validating', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt: NOW,
      processedAt: NOW,
    });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(NOW);
  });
});
