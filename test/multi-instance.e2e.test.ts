import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WagerTransactionKind } from '../src/domain/wager-transaction/wager-transaction.js';
import { WalletEntity } from '../src/db/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../src/db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/db/entities/wallet-ledger-entry.entity.js';
import { WalletService } from '../src/wallets/wallet.service.js';
import { MetricsService } from '../src/common/metrics/metrics.service.js';
import { ormOptionsFor, dropDatabaseIfExists } from './test-db.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_multi_instance_test');
const SUBMITTER = resolve('test/processes/concurrent-submitter.ts');
const PROCESS_COUNT = 3;
const WORKER_TIMEOUT_MS = 60_000;

interface Summary {
  ok: boolean;
  instance: number;
  startedAt: number;
  finishedAt: number;
  submitted: number;
  processed: number;
  rejected: number;
  replay: number;
  failureCodes: Record<string, number>;
  error?: string;
}

interface WorkerOptions {
  count: number;
  amount: string;
  fixedExternal?: string;
}

describe('multi-instance (e2e, 3 simultaneous processes, real Postgres)', () => {
  let orm: MikroORM;
  let walletService: WalletService;
  let provider: string;

  beforeAll(async () => {
    await dropDatabaseIfExists(TEST_DB);
    orm = await MikroORM.init(ormOptionsFor(TEST_DB));
    await orm.migrator.up();
    walletService = new WalletService(orm, new MetricsService());
    provider = `provider-${randomUUID().slice(0, 8)}`;
  }, 120_000);

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
    await dropDatabaseIfExists(TEST_DB);
  }, 120_000);

  async function createWallet(
    balance = '100.00',
  ): Promise<{ id: string; playerId: string }> {
    const wallet = await walletService.create({
      playerId: randomUUID(),
      initialBalance: { amount: balance, currency: 'BRL' },
    });
    return { id: wallet.id, playerId: wallet.playerId };
  }

  /** Spawns PROCESS_COUNT child processes, each an independent instance that
   * submits `count` concurrent bets against the same wallet. */
  async function runInstances(
    wallet: { id: string; playerId: string },
    options: WorkerOptions,
  ): Promise<Summary[]> {
    const spawns = Array.from({ length: PROCESS_COUNT }, () =>
      spawnWorker(wallet, options),
    );
    return Promise.all(spawns);
  }

  async function spawnWorker(
    wallet: { id: string; playerId: string },
    options: WorkerOptions,
  ): Promise<Summary> {
    const outFile = join(
      tmpdir(),
      `multi-instance-${process.pid}-${randomUUID().slice(0, 8)}.json`,
    );
    const child = Bun.spawn({
      cmd: [process.execPath, SUBMITTER],
      cwd: resolve('.'),
      env: {
        ...process.env,
        WORKER_DB_NAME: TEST_DB,
        WORKER_PROVIDER: provider,
        WORKER_WALLET_ID: wallet.id,
        WORKER_PLAYER_ID: wallet.playerId,
        WORKER_AMOUNT: options.amount,
        WORKER_COUNT: String(options.count),
        ...(options.fixedExternal
          ? { WORKER_EXTERNAL: options.fixedExternal }
          : {}),
        WORKER_OUT_FILE: outFile,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return new Promise<Summary>((resolveSummary, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`worker timed out after ${WORKER_TIMEOUT_MS}ms`));
      }, WORKER_TIMEOUT_MS);
      child.exited.then(async (code) => {
        clearTimeout(timer);
        let summary: Summary;
        try {
          summary = JSON.parse(readFileSync(outFile, 'utf8')) as Summary;
        } catch (error) {
          reject(
            new Error(
              `could not read worker summary (exit ${code}): ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
          return;
        } finally {
          rmSync(outFile, { force: true });
        }
        if (code !== 0 || !summary.ok) {
          reject(
            new Error(
              `worker ${summary.instance ?? '?'} failed (exit ${code}): ${
                summary.error ?? 'unknown error'
              }`,
            ),
          );
          return;
        }
        resolveSummary(summary);
      });
    });
  }

  async function walletRow(walletId: string) {
    const row = await orm.em.fork().findOne(WalletEntity, { id: walletId });
    return row as unknown as { balanceAmount: string; version: number };
  }

  async function debitCount(walletId: string): Promise<number> {
    return orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId,
      direction: 'DEBIT',
    });
  }

  async function ledgerTotal(walletId: string): Promise<string> {
    const row = (await orm.em
      .getConnection()
      .execute(
        `select coalesce(sum(case when direction = 'CREDIT' then money_amount else -money_amount end), 0)::text as total from wallet_ledger_entry where wallet_id = ?`,
        [walletId],
        'get',
      )) as { total: string };
    return row.total;
  }

  function totals(summaries: Summary[]): Summary {
    const sum: Summary = {
      ok: true,
      instance: 0,
      startedAt: Number.MAX_SAFE_INTEGER,
      finishedAt: 0,
      submitted: 0,
      processed: 0,
      rejected: 0,
      replay: 0,
      failureCodes: {},
    };
    for (const summary of summaries) {
      sum.submitted += summary.submitted;
      sum.processed += summary.processed;
      sum.rejected += summary.rejected;
      sum.replay += summary.replay;
      sum.startedAt = Math.min(sum.startedAt, summary.startedAt);
      sum.finishedAt = Math.max(sum.finishedAt, summary.finishedAt);
      for (const [code, count] of Object.entries(summary.failureCodes)) {
        sum.failureCodes[code] = (sum.failureCodes[code] ?? 0) + count;
      }
    }
    return sum;
  }

  /** Proves the processes truly overlapped in time (real parallelism, §13). */
  function assertSimultaneous(summaries: Summary[]): void {
    const maxStarted = Math.max(
      ...summaries.map((summary) => summary.startedAt),
    );
    const minFinished = Math.min(
      ...summaries.map((summary) => summary.finishedAt),
    );
    expect(maxStarted).toBeLessThan(minFinished);
  }

  it('§8 mandatory scenario: two concurrent 80.00 bets from 3 processes -> one winner', async () => {
    const wallet = await createWallet('100.00');
    const summaries = await runInstances(wallet, { count: 2, amount: '80.00' });
    assertSimultaneous(summaries);
    const totalsAcross = totals(summaries);

    expect(totalsAcross.submitted).toBe(6);
    expect(totalsAcross.processed).toBe(1);
    expect(totalsAcross.rejected).toBe(5);
    expect(totalsAcross.failureCodes).toEqual({
      INSUFFICIENT_FUNDS: 5,
    });
    expect(totalsAcross.replay).toBe(0);

    const rows = await orm.em.fork().count(WagerTransactionEntity, {
      providerId: provider,
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
    });
    expect(rows).toBe(6);
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await walletRow(wallet.id)).toMatchObject({
      balanceAmount: '20.00',
      version: 2,
    });
    expect(await ledgerTotal(wallet.id)).toBe('20.00');
  }, 120_000);

  it('settles distinct wallets in parallel across the 3 processes without cross-talk', async () => {
    const wallets = [];
    for (let i = 0; i < PROCESS_COUNT; i += 1) {
      wallets.push(await createWallet('100.00'));
    }
    const summaries = await Promise.all(
      wallets.map((wallet) =>
        spawnWorker(wallet, { count: 1, amount: '25.00' }),
      ),
    );

    for (const summary of summaries) {
      expect(summary.processed).toBe(1);
      expect(summary.rejected).toBe(0);
    }
    for (const wallet of wallets) {
      expect(await debitCount(wallet.id)).toBe(1);
      expect(await walletRow(wallet.id)).toMatchObject({
        balanceAmount: '75.00',
        version: 2,
      });
    }
  }, 120_000);

  it('same wager submitted by 3 processes concurrently settles exactly once', async () => {
    const wallet = await createWallet('100.00');
    const fixedExternal = `same-${randomUUID().slice(0, 12)}`;
    const summaries = await runInstances(wallet, {
      count: 1,
      amount: '10.00',
      fixedExternal,
    });
    const totalsAcross = totals(summaries);

    expect(totalsAcross.submitted).toBe(3);
    expect(totalsAcross.processed).toBe(3);
    expect(totalsAcross.replay).toBe(2);
    expect(totalsAcross.rejected).toBe(0);

    const rows = await orm.em.fork().count(WagerTransactionEntity, {
      providerId: provider,
      walletId: wallet.id,
      externalTransactionId: fixedExternal,
    });
    expect(rows).toBe(1);
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await walletRow(wallet.id)).toMatchObject({
      balanceAmount: '90.00',
      version: 2,
    });
  }, 120_000);
});
