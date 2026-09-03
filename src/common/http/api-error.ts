import { HttpException } from '@nestjs/common';

export type ApiErrorCode =
  | 'INVALID_PAYLOAD'
  | 'WALLET_ALREADY_EXISTS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'WALLET_NOT_FOUND'
  | 'INTERNAL_ERROR';

interface ApiErrorBody {
  statusCode: number;
  code: ApiErrorCode;
  message: string;
}

export function httpError(
  status: number,
  code: ApiErrorCode,
  message: string,
): never {
  const body: ApiErrorBody = { statusCode: status, code, message };
  throw new HttpException(body, status);
}
