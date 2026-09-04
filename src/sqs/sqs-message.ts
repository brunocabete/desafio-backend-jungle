import {
  InvalidWagerPayloadError,
  normalizeWagerSubmit,
  type NormalizedWagerSubmit,
} from '../wagering/wager-transaction.service.js';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';
export const WAGER_TRANSACTION_EVENT_TYPE = 'WagerTransactionRequested';

export interface ParsedWagerMessage {
  messageId: string;
  payloadHash: string;
  data: NormalizedWagerSubmit;
}

export class InvalidSqsMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSqsMessageError';
  }
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidSqsMessageError(`${field} is required as a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new InvalidSqsMessageError(
      `${field} must be at most ${maxLength} characters`,
    );
  }
  return trimmed;
}

export function parseWagerQueueMessage(rawBody: string): ParsedWagerMessage {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new InvalidSqsMessageError('message body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidSqsMessageError('message body must be an object');
  }
  const envelope = body as Record<string, unknown>;

  const type = envelope.type;
  if (type !== WAGER_TRANSACTION_EVENT_TYPE) {
    throw new InvalidSqsMessageError(
      `unsupported message type '${String(type)}'`,
    );
  }

  const messageId = requiredString(envelope.messageId, 'messageId', 255);

  const data = envelope.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new InvalidSqsMessageError('message data must be an object');
  }

  let normalized: NormalizedWagerSubmit;
  try {
    normalized = normalizeWagerSubmit(data);
  } catch (error) {
    if (error instanceof InvalidWagerPayloadError) {
      throw error;
    }
    throw new InvalidSqsMessageError(
      `invalid wager payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { messageId, payloadHash: normalized.payloadHash, data: normalized };
}
