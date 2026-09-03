import type { IntegrationEvent } from '../integration-event/integration-event.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class InvalidOutboxMessageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutboxMessageStateError';
  }
}

export const OUTBOX_RETRY_BASE_DELAY_MS = 200;
export const OUTBOX_RETRY_MAX_DELAY_MS = 30_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined ||
        this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageStateError(
        `outbox message '${this.id}' was already published`,
      );
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageStateError(
        `outbox message '${this.id}' was already published and cannot be retried`,
      );
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(
      now.getTime() + OutboxMessage.backoffFor(this._attempts),
    );
  }

  private static backoffFor(attempt: number): number {
    const shift = Math.min(attempt - 1, 30);
    const delay = OUTBOX_RETRY_BASE_DELAY_MS * 2 ** shift;
    return Math.min(delay, OUTBOX_RETRY_MAX_DELAY_MS);
  }
}
