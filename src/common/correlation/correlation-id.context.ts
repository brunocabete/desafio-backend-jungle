import { AsyncLocalStorage } from 'node:async_hooks';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const CORRELATION_ID_KEY = 'correlationId';

const storage = new AsyncLocalStorage<Map<string, string>>();

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run(new Map([[CORRELATION_ID_KEY, correlationId]]), fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.get(CORRELATION_ID_KEY);
}
