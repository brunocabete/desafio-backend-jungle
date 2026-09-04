import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import type { ApiErrorCode } from './api-error.js';

export interface ErrorStatusMapping {
  status: number;
  code: ApiErrorCode;
}

const TRANSIENT_INFRA_HTTP = 503 as const;
const FATAL_HTTP = 500 as const;

function errorCause(error: Error): Error | undefined {
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? cause : undefined;
}

function hasCause(error: Error, type: Function): boolean {
  let current: Error | undefined = error;
  const seen = new Set<Error>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof type) {
      return true;
    }
    current = errorCause(current);
  }
  return false;
}

/**
 * Infrastructure errors that are transient by nature (dependency down,
 * lock waits, deadlocks): the client may retry the same request later.
 * Database constraint violations are NOT transient — they express business
 * state and are mapped closer to the boundary.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    hasCause(error, ConnectionException) ||
    hasCause(error, LockWaitTimeoutException) ||
    hasCause(error, DeadlockException)
  );
}

/** Resolves the HTTP status + API code for an unhandled error. */
export function mapUnhandledError(error: unknown): ErrorStatusMapping {
  if (isTransientInfrastructureError(error)) {
    return { status: TRANSIENT_INFRA_HTTP, code: 'SERVICE_UNAVAILABLE' };
  }
  return { status: FATAL_HTTP, code: 'INTERNAL_ERROR' };
}

interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
}

const FALLBACK_MESSAGE: Record<number, string> = {
  [TRANSIENT_INFRA_HTTP]: 'a dependency is temporarily unavailable',
  [FATAL_HTTP]: 'internal server error',
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        response.status(status).json({ statusCode: status, message: body });
        return;
      }
      response.status(status).json(body);
      return;
    }

    const mapping = mapUnhandledError(exception);
    const name = exception instanceof Error ? exception.name : 'Error';
    const detail =
      exception instanceof Error ? exception.message : String(exception);
    this.logger.error(
      `unhandled ${name}: ${detail}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    const body: ApiErrorBody = {
      statusCode: mapping.status,
      code: mapping.code,
      message: FALLBACK_MESSAGE[mapping.status] ?? 'internal server error',
    };
    response.status(mapping.status).json(body);
  }
}
