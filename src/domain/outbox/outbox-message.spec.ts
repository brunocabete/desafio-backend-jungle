import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../integration-event/integration-event.js';
import {
  InvalidOutboxMessageStateError,
  OutboxMessage,
  OUTBOX_RETRY_BASE_DELAY_MS,
  OUTBOX_RETRY_MAX_DELAY_MS,
} from './outbox-message.js';

interface FakeData {
  n: number;
}

class FakeEvent extends IntegrationEvent<FakeData> {
  readonly eventType = 'FakeEvent';
  readonly version = 1;

  constructor(props: IntegrationEventProps<FakeData>) {
    super(props);
  }
}

const NOW = new Date('2026-09-03T12:00:00.000Z');

function fakeEvent(): IntegrationEvent<FakeData> {
  return new FakeEvent({
    eventId: 'event-1',
    aggregateId: 'wallet-1',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    occurredAt: NOW,
    data: { n: 1 },
  });
}

describe('OutboxMessage.enqueue', () => {
  it('captures the event envelope and starts pending', () => {
    const event = fakeEvent();
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('FakeEvent');
    expect(message.occurredAt).toBe(NOW);
    expect(message.payload).toEqual(event.toJSON());
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.publishedAt).toBeUndefined();
  });

  it('is due immediately when never retried', () => {
    const message = OutboxMessage.enqueue(fakeEvent());
    expect(message.isDue(NOW)).toBe(true);
  });
});

describe('OutboxMessage publish lifecycle', () => {
  it('marks pending messages as published once', () => {
    const message = OutboxMessage.enqueue(fakeEvent());

    message.markPublished(NOW);
    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toBe(NOW);
    expect(message.isDue(NOW)).toBe(false);

    expect(() => message.markPublished(NOW)).toThrow(
      InvalidOutboxMessageStateError,
    );
    expect(() => message.scheduleRetry(NOW)).toThrow(
      InvalidOutboxMessageStateError,
    );
  });
});

describe('OutboxMessage retry/backoff', () => {
  it('schedules retries with exponential backoff', () => {
    const message = OutboxMessage.enqueue(fakeEvent());

    message.scheduleRetry(NOW);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.getTime()).toBe(
      NOW.getTime() + OUTBOX_RETRY_BASE_DELAY_MS,
    );

    const later = new Date(message.nextAttemptAt!.getTime() - 1);
    expect(message.isDue(later)).toBe(false);
    expect(message.isDue(message.nextAttemptAt!)).toBe(true);

    message.scheduleRetry(later);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt?.getTime()).toBe(
      later.getTime() + OUTBOX_RETRY_BASE_DELAY_MS * 2,
    );
  });

  it('caps the backoff at the configured maximum', () => {
    const message = OutboxMessage.enqueue(fakeEvent());
    const now = NOW.getTime();

    for (let i = 0; i < 20; i += 1) {
      message.scheduleRetry(new Date(now));
    }

    expect(message.attempts).toBe(20);
    expect(message.nextAttemptAt!.getTime()).toBeLessThanOrEqual(
      now + OUTBOX_RETRY_MAX_DELAY_MS,
    );
    expect(message.nextAttemptAt!.getTime()).toBe(
      now + OUTBOX_RETRY_MAX_DELAY_MS,
    );
  });

  it('rehydrates a pending message with its retry state', () => {
    const state = {
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'FakeEvent',
      payload: { eventId: 'event-1' } as Readonly<Record<string, unknown>>,
      occurredAt: NOW,
      attempts: 3,
      nextAttemptAt: new Date(NOW.getTime() + 1000),
      publishedAt: undefined,
    };

    const message = OutboxMessage.rehydrate(state);
    expect(message.attempts).toBe(3);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(state.nextAttemptAt)).toBe(true);
    expect(message.isDue(new Date(state.nextAttemptAt.getTime() - 1))).toBe(
      false,
    );
  });
});
