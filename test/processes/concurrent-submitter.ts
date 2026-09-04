import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction.js';
import { WagerTransactionService } from '../../src/wagering/wager-transaction.service.js';
import { ormOptionsFor } from '../test-db.js';

/**
 * Child-process worker for the multi-instance e2e matrix (§13 item 3.4).
 *
 * Spawned by test/multi-instance.e2e.test.ts: each process boots its OWN
 * MikroORM (separate connection pool) and its own WagerTransactionService
 * instance — i.e. an independent application instance sharing only the
 * Postgres database. It submits `WORKER_COUNT` concurrent bets against the
 * given wallet through the shared use case and writes a compact JSON summary
 * to `WORKER_OUT_FILE`, so stdout/stderr stay irrelevant to the parent.
 */

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

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env var ${name}`);
  }
  return value;
}

async function run(): Promise<number> {
  const dbName = need('WORKER_DB_NAME');
  const providerId = need('WORKER_PROVIDER');
  const walletId = need('WORKER_WALLET_ID');
  const playerId = need('WORKER_PLAYER_ID');
  const amount = need('WORKER_AMOUNT');
  const count = Number(need('WORKER_COUNT'));
  const fixedExternal = process.env.WORKER_EXTERNAL;
  const outFile = need('WORKER_OUT_FILE');

  let orm: MikroORM | undefined;
  try {
    orm = await MikroORM.init(ormOptionsFor(dbName));
    const service = new WagerTransactionService(orm);
    const tasks = Array.from({ length: count }, () => {
      const externalTransactionId =
        fixedExternal ??
        `${WagerTransactionKind.Bet}-${process.pid}-${randomUUID().slice(0, 12)}`;
      return service.submit({
        providerId,
        externalTransactionId,
        idempotencyKey: `${providerId}:${externalTransactionId}`,
        playerId,
        walletId,
        roundId: 'round-multi-instance',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount, currency: 'BRL' },
      });
    });
    const startedAt = Date.now();
    const results = await Promise.all(tasks);
    const finishedAt = Date.now();
    const summary: Summary = {
      ok: true,
      instance: process.pid,
      startedAt,
      finishedAt,
      submitted: results.length,
      processed: 0,
      rejected: 0,
      replay: 0,
      failureCodes: {},
    };
    for (const result of results) {
      if (result.status === 'PROCESSED') {
        summary.processed += 1;
      } else if (result.status === 'REJECTED') {
        summary.rejected += 1;
        const code = result.failureCode ?? 'UNKNOWN';
        summary.failureCodes[code] = (summary.failureCodes[code] ?? 0) + 1;
      }
      if (result.idempotentReplay) {
        summary.replay += 1;
      }
    }
    writeFileSync(outFile, JSON.stringify(summary));
    return 0;
  } catch (error) {
    const summary: Summary = {
      ok: false,
      instance: process.pid,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      submitted: 0,
      processed: 0,
      rejected: 0,
      replay: 0,
      failureCodes: {},
      error: error instanceof Error ? error.message : String(error),
    };
    writeFileSync(outFile, JSON.stringify(summary));
    return 1;
  } finally {
    if (orm) {
      await orm.close(true).catch(() => undefined);
    }
  }
}

void run().then((code) => process.exit(code));
