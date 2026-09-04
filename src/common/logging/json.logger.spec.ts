import { describe, expect, it, spyOn } from 'bun:test';
import { runWithCorrelationId } from '../correlation/correlation-id.context.js';
import { JsonLogger } from './json.logger.js';

function capture(stream: 'stdout' | 'stderr', fn: () => void): string {
  const write = spyOn(process[stream], 'write').mockImplementation(() => true);
  let raw: string | undefined;
  try {
    fn();
    raw = String(write.mock.calls[0][0]);
  } finally {
    write.mockRestore();
  }
  return raw ?? '';
}

describe('JsonLogger', () => {
  it('emits a JSON record with context and correlationId', () => {
    const raw = capture('stdout', () => {
      runWithCorrelationId('corr-123', () => {
        new JsonLogger().log('wallet opened', 'WalletService');
      });
    });

    const record = JSON.parse(raw) as Record<string, string>;
    expect(record.level).toBe('info');
    expect(record.msg).toBe('wallet opened');
    expect(record.ctx).toBe('WalletService');
    expect(record.correlationId).toBe('corr-123');
  });

  it('serializes Error messages with a stack to stderr', () => {
    const raw = capture('stderr', () => {
      new JsonLogger().error(new Error('boom'));
    });

    const record = JSON.parse(raw) as Record<string, string>;
    expect(record.level).toBe('error');
    expect(record.msg).toBe('boom');
    expect(record.stack).toContain('Error: boom');
  });

  it('flattens structured object fields next to msg and correlationId', () => {
    const raw = capture('stdout', () => {
      runWithCorrelationId('corr-sqs', () => {
        new JsonLogger().log(
          {
            event: 'wager.settled',
            transactionId: 'tx-1',
            walletId: 'wallet-1',
            providerId: 'provider-a',
            status: 'PROCESSED',
            idempotentReplay: false,
          },
          'WagerTransactionService',
        );
      });
    });

    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record.level).toBe('info');
    expect(record.msg).toBe('wager.settled');
    expect(record.ctx).toBe('WagerTransactionService');
    expect(record.correlationId).toBe('corr-sqs');
    expect(record).toMatchObject({
      event: 'wager.settled',
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      status: 'PROCESSED',
      idempotentReplay: false,
    });
  });
});
