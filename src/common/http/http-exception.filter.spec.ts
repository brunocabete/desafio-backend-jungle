import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import {
  isTransientInfrastructureError,
  mapUnhandledError,
} from './http-exception.filter.js';

function transientFrom(ctor: new (previous: Error) => Error): Error {
  return new ctor(new Error('boom'));
}

describe('isTransientInfrastructureError', () => {
  it('classifies connection failures as transient', () => {
    expect(
      isTransientInfrastructureError(transientFrom(ConnectionException)),
    ).toBe(true);
  });

  it('classifies lock wait timeouts as transient', () => {
    expect(
      isTransientInfrastructureError(transientFrom(LockWaitTimeoutException)),
    ).toBe(true);
  });

  it('classifies deadlocks as transient', () => {
    expect(
      isTransientInfrastructureError(transientFrom(DeadlockException)),
    ).toBe(true);
  });

  it('does NOT classify constraint violations as transient', () => {
    expect(
      isTransientInfrastructureError(
        transientFrom(UniqueConstraintViolationException),
      ),
    ).toBe(false);
  });

  it('does not classify arbitrary errors or non-errors as transient', () => {
    expect(isTransientInfrastructureError(new Error('boom'))).toBe(false);
    expect(isTransientInfrastructureError('boom')).toBe(false);
    expect(isTransientInfrastructureError(undefined)).toBe(false);
  });
});

describe('mapUnhandledError', () => {
  it('maps transient infra errors to 503 SERVICE_UNAVAILABLE', () => {
    expect(mapUnhandledError(transientFrom(ConnectionException))).toEqual({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('maps other unhandled errors to 500 INTERNAL_ERROR', () => {
    expect(mapUnhandledError(new Error('boom'))).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });
});
