import {
  outboxRetryDelayMs,
  OUTBOX_CLAIM_LEASE_MS,
} from './outbox-publisher.service.js';
import { OUTBOX_RETRY_MAX_DELAY_MS } from '../domain/outbox/outbox-message.js';

describe('outboxRetryDelayMs', () => {
  it('backs off exponentially from the base delay', () => {
    expect(outboxRetryDelayMs(1)).toBe(200);
    expect(outboxRetryDelayMs(2)).toBe(400);
    expect(outboxRetryDelayMs(3)).toBe(800);
  });

  it('caps the backoff at the configured maximum', () => {
    expect(outboxRetryDelayMs(10)).toBe(OUTBOX_RETRY_MAX_DELAY_MS);
    expect(outboxRetryDelayMs(100)).toBe(OUTBOX_RETRY_MAX_DELAY_MS);
  });
});

describe('outbox publisher constants', () => {
  it('leases in-flight rows for at least the maximum retry backoff', () => {
    expect(OUTBOX_CLAIM_LEASE_MS).toBeGreaterThanOrEqual(
      OUTBOX_RETRY_MAX_DELAY_MS,
    );
  });
});
