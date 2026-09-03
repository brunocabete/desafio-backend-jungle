export const PENDING_REFERENCE_BASE_DELAY_MS = 200;
export const PENDING_REFERENCE_MAX_DELAY_MS = 30_000;
export const PENDING_REFERENCE_MAX_ATTEMPTS = 10;
export const PENDING_REFERENCE_TTL_MS = 5 * 60_000;

export function pendingReferenceDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    PENDING_REFERENCE_BASE_DELAY_MS * 2 ** exponent,
    PENDING_REFERENCE_MAX_DELAY_MS,
  );
}

export function schedulePendingReferenceRetryAt(
  attempt: number,
  now: Date,
): Date {
  return new Date(now.getTime() + pendingReferenceDelayMs(attempt));
}
