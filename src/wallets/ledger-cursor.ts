export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export class InvalidLedgerCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerCursorError';
  }
}

export class InvalidLedgerLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerLimitError';
  }
}

function serialize(value: LedgerCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: value.createdAt.toISOString(), i: value.id }),
    'utf8',
  ).toString('base64url');
}

function deserialize(value: string): LedgerCursor {
  const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
    v?: unknown;
    t?: unknown;
    i?: unknown;
  };
  if (raw.v !== 1) {
    throw new InvalidLedgerCursorError('unsupported ledger cursor version');
  }
  if (typeof raw.t !== 'string' || typeof raw.i !== 'string') {
    throw new InvalidLedgerCursorError('malformed ledger cursor payload');
  }
  const createdAt = new Date(raw.t);
  if (Number.isNaN(createdAt.getTime())) {
    throw new InvalidLedgerCursorError('malformed ledger cursor timestamp');
  }
  return { createdAt, id: raw.i };
}

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return serialize(cursor);
}

export function decodeLedgerCursor(value: string): LedgerCursor {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidLedgerCursorError('cursor is required');
  }
  try {
    return deserialize(value);
  } catch (error) {
    if (error instanceof InvalidLedgerCursorError) {
      throw error;
    }
    throw new InvalidLedgerCursorError('cursor is not valid base64url');
  }
}

export function parseLedgerLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return LEDGER_DEFAULT_LIMIT;
  }
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new InvalidLedgerLimitError('limit must be a positive integer');
  }
  const limit = Number.parseInt(raw, 10);
  if (limit < 1) {
    throw new InvalidLedgerLimitError('limit must be at least 1');
  }
  if (limit > LEDGER_MAX_LIMIT) {
    throw new InvalidLedgerLimitError(
      `limit must be at most ${LEDGER_MAX_LIMIT}`,
    );
  }
  return limit;
}
