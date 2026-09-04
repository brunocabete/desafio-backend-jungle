import {
  InvalidLedgerCursorError,
  InvalidLedgerLimitError,
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseLedgerLimit,
} from './ledger-cursor.js';

describe('ledger cursor', () => {
  it('round-trips a cursor', () => {
    const cursor = {
      createdAt: new Date('2026-07-29T15:00:00.000Z'),
      id: 'abc-123',
    };
    const encoded = encodeLedgerCursor(cursor);
    expect(typeof encoded).toBe('string');
    expect(encoded).not.toContain('abc-123');
    const decoded = decodeLedgerCursor(encoded);
    expect(decoded.createdAt.toISOString()).toBe('2026-07-29T15:00:00.000Z');
    expect(decoded.id).toBe('abc-123');
  });

  it('is opaque to the caller (base64url, no raw fields)', () => {
    const cursor = { createdAt: new Date(), id: 'id-1' };
    const encoded = encodeLedgerCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects an empty or malformed cursor', () => {
    const cases = [
      '',
      'not-base64!!',
      'aGVsbG8',
      Buffer.from('{"v":9}', 'utf8').toString('base64url'),
    ];
    for (const value of cases) {
      expect(() => decodeLedgerCursor(value)).toThrow(InvalidLedgerCursorError);
    }
  });

  it('rejects a cursor with a non-ISO timestamp', () => {
    const bad = Buffer.from(
      JSON.stringify({ v: 1, t: 'not-a-date', i: 'id-1' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeLedgerCursor(bad)).toThrow(InvalidLedgerCursorError);
  });
});

describe('parseLedgerLimit', () => {
  it('defaults to 50 when omitted', () => {
    expect(parseLedgerLimit(undefined)).toBe(50);
    expect(parseLedgerLimit('')).toBe(50);
  });

  it('parses a valid limit string', () => {
    expect(parseLedgerLimit('1')).toBe(1);
    expect(parseLedgerLimit('200')).toBe(200);
  });

  const invalid = ['0', '-1', 'abc', '1.5', '50.5', '201'];
  for (const value of invalid) {
    it(`rejects limit '${value}'`, () => {
      expect(() => parseLedgerLimit(value)).toThrow(InvalidLedgerLimitError);
    });
  }
});
