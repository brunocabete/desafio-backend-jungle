import {
  PENDING_REFERENCE_MAX_DELAY_MS,
  pendingReferenceDelayMs,
  schedulePendingReferenceRetryAt,
} from './pending-reference-retry.js';

describe('pendingReferenceDelayMs', () => {
  it('grows exponentially from the base delay', () => {
    expect(pendingReferenceDelayMs(1)).toBe(200);
    expect(pendingReferenceDelayMs(2)).toBe(400);
    expect(pendingReferenceDelayMs(3)).toBe(800);
    expect(pendingReferenceDelayMs(4)).toBe(1600);
  });

  it('caps the delay at the configured maximum', () => {
    expect(pendingReferenceDelayMs(20)).toBe(PENDING_REFERENCE_MAX_DELAY_MS);
  });

  it('does not underflow for a zero attempt', () => {
    expect(pendingReferenceDelayMs(0)).toBe(200);
  });
});

describe('schedulePendingReferenceRetryAt', () => {
  it('adds the exponential delay to now', () => {
    const now = new Date('2026-09-03T12:00:00.000Z');
    expect(schedulePendingReferenceRetryAt(2, now)).toEqual(
      new Date('2026-09-03T12:00:00.400Z'),
    );
  });
});
