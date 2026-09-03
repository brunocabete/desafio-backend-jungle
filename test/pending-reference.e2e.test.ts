import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { WalletEntity } from '../src/db/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../src/db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/db/entities/wallet-ledger-entry.entity.js';
import { WalletService } from '../src/wallets/wallet.service.js';
import { WagerTransactionService } from '../src/wagering/wager-transaction.service.js';
import { PENDING_REFERENCE_MAX_DELAY_MS } from '../src/wagering/pending-reference-retry.js';
import { ormOptionsFor, dropDatabaseIfExists } from './test-db.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_pending_test');

describe('pending-reference worker (e2e)', () => {
  let orm: MikroORM;
  let walletService: WalletService;
  let wagerService: WagerTransactionService;
  let provider: string;

  beforeAll(async () => {
    await dropDatabaseIfExists(TEST_DB);
    orm = await MikroORM.init(ormOptionsFor(TEST_DB));
    await orm.migrator.up();
    walletService = new WalletService(orm);
    wagerService = new WagerTransactionService(orm);
    provider = `provider-${randomUUID().slice(0, 8)}`;
  }, 60_000);

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
    await dropDatabaseIfExists(TEST_DB);
  }, 60_000);

  async function createWallet(
    balance = '100.00',
  ): Promise<{ id: string; playerId: string }> {
    const wallet = await walletService.create({
      playerId: randomUUID(),
      initialBalance: { amount: balance, currency: 'BRL' },
    });
    return { id: wallet.id, playerId: wallet.playerId };
  }

  async function submitRefund(
    wallet: { id: string; playerId: string },
    referenceExternalTransactionId: string,
  ): Promise<{ status: string }> {
    return wagerService.submit({
      providerId: provider,
      externalTransactionId: randomUUID(),
      idempotencyKey: `${provider}:${randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId,
    });
  }

  async function pendingRow(walletId: string) {
    const row = await orm.em.fork().findOne(WagerTransactionEntity, {
      providerId: provider,
      walletId,
      status: 'PENDING_REFERENCE',
    });
    return row as unknown as {
      id: string;
      attemptCount: number;
      nextAttemptAt: Date | null;
      failureCode: string | null;
      status: string;
    } | null;
  }

  async function rejectOwnPending(walletId: string): Promise<void> {
    const row = await pendingRow(walletId);
    if (!row) {
      return;
    }
    const now = new Date((row.nextAttemptAt?.getTime() ?? Date.now()) + 1);
    await wagerService.reprocessPendingReferences({
      now,
      ttlMs: 0,
      maxAttempts: 1,
    });
    expect(await pendingRow(walletId)).toBeNull();
  }

  it('rejects a PENDING_REFERENCE with UNRESOLVED_REFERENCE once the TTL is exceeded', async () => {
    const wallet = await createWallet('100.00');
    const refund = await submitRefund(
      wallet,
      `bet-ttl-${randomUUID().slice(0, 8)}`,
    );
    expect(refund.status).toBe('PENDING_REFERENCE');
    expect(
      await orm.em
        .fork()
        .count(WalletLedgerEntryEntity, { walletId: wallet.id }),
    ).toBe(1);

    const handled = await wagerService.reprocessPendingReferences({
      now: new Date(Date.now() + 1),
      ttlMs: 0,
    });
    expect(handled).toBe(1);

    const em = orm.em.fork();
    const rejected = await em.findOne(WagerTransactionEntity, {
      providerId: provider,
      walletId: wallet.id,
    });
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      failureCode: 'UNRESOLVED_REFERENCE',
      nextAttemptAt: null,
    });
    expect(
      await em.count(WalletLedgerEntryEntity, { walletId: wallet.id }),
    ).toBe(1);
    const walletRow = await em.findOne(WalletEntity, { id: wallet.id });
    expect(walletRow).toMatchObject({ balanceAmount: '100.00', version: 1 });
  });

  it('reprocesses due rows with exponential backoff and rejects after the attempt limit', async () => {
    const wallet = await createWallet('100.00');
    const refund = await submitRefund(
      wallet,
      `bet-attempts-${randomUUID().slice(0, 8)}`,
    );
    expect(refund.status).toBe('PENDING_REFERENCE');

    const longTtl = 3_600_000;
    const maxAttempts = 2;

    const first = await wagerService.reprocessPendingReferences({
      now: new Date(),
      ttlMs: longTtl,
      maxAttempts,
    });
    expect(first).toBe(1);
    let row = await pendingRow(wallet.id);
    expect(row?.status).toBe('PENDING_REFERENCE');
    expect(row?.attemptCount).toBe(1);
    expect(row?.nextAttemptAt).not.toBeNull();
    expect(row?.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    const second = await wagerService.reprocessPendingReferences({
      now: new Date(row!.nextAttemptAt!.getTime() + 1),
      ttlMs: longTtl,
      maxAttempts,
    });
    expect(second).toBe(1);
    row = await pendingRow(wallet.id);
    expect(row?.attemptCount).toBe(2);

    const third = await wagerService.reprocessPendingReferences({
      now: new Date(row!.nextAttemptAt!.getTime() + 1),
      ttlMs: longTtl,
      maxAttempts,
    });
    expect(third).toBe(1);

    const em = orm.em.fork();
    const rejected = await em.findOne(WagerTransactionEntity, {
      providerId: provider,
      walletId: wallet.id,
    });
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      failureCode: 'UNRESOLVED_REFERENCE',
      attemptCount: maxAttempts,
    });
  });

  it('does not reprocess a transaction whose retry is not due yet', async () => {
    const wallet = await createWallet('100.00');
    const refund = await submitRefund(
      wallet,
      `bet-wait-${randomUUID().slice(0, 8)}`,
    );
    expect(refund.status).toBe('PENDING_REFERENCE');

    await wagerService.reprocessPendingReferences({
      now: new Date(),
      ttlMs: 3_600_000,
    });
    let row = await pendingRow(wallet.id);
    expect(row?.attemptCount).toBe(1);

    const skipped = await wagerService.reprocessPendingReferences({
      now: new Date(),
      ttlMs: 3_600_000,
    });
    expect(skipped).toBe(0);
    row = await pendingRow(wallet.id);
    expect(row?.attemptCount).toBe(1);

    await rejectOwnPending(wallet.id);
  });

  it('backs off at most to the configured maximum delay', async () => {
    const wallet = await createWallet('100.00');
    const refund = await submitRefund(
      wallet,
      `bet-cap-${randomUUID().slice(0, 8)}`,
    );
    expect(refund.status).toBe('PENDING_REFERENCE');

    for (let i = 0; i < 5; i += 1) {
      const row = await pendingRow(wallet.id);
      const now = new Date((row?.nextAttemptAt?.getTime() ?? Date.now()) + 1);
      await wagerService.reprocessPendingReferences({
        now,
        ttlMs: 3_600_000,
      });
    }

    const row = await pendingRow(wallet.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('PENDING_REFERENCE');
    const delay = row!.nextAttemptAt!.getTime() - Date.now();
    expect(delay).toBeLessThanOrEqual(PENDING_REFERENCE_MAX_DELAY_MS);

    await rejectOwnPending(wallet.id);
  });
});
