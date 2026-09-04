import './../../src/common/config/load-env.js';
import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

/**
 * Load test — `bun run test:load` (SPECS §14 differential; Phase 7 item 4).
 *
 * Honest end-to-end experiment against the REAL stack:
 *  - the full Nest app (real HTTP endpoints, transactional use case, outbox
 *    rows written in the same SQL transaction, real /metrics);
 *  - a dedicated PostgreSQL database (migrated from scratch);
 *  - Ministack SQS, with the real outbox publisher enabled (atomic claim +
 *    backoff) so outbox lag is measured while events actually drain.
 *
 * The SQS wager consumer and the PENDING_REFERENCE scheduler are disabled: the
 * load targets the HTTP submit path only (the consumer shares the same use
 * case and is already covered elsewhere). No target RPS — the value is the
 * methodology and honest numbers.
 *
 * Knobs (env, all optional): LOAD_WALLETS, LOAD_CONCURRENCY,
 * LOAD_DISTRIBUTED, LOAD_HOT_REQUESTS, LOAD_WARMUP, LOAD_OUTBOX_SAMPLE_MS.
 */

const knobs = {
  wallets: Number(process.env.LOAD_WALLETS ?? 120),
  concurrency: Number(process.env.LOAD_CONCURRENCY ?? 40),
  distributed: Number(process.env.LOAD_DISTRIBUTED ?? 1500),
  hotRequests: Number(process.env.LOAD_HOT_REQUESTS ?? 300),
  warmup: Number(process.env.LOAD_WARMUP ?? 100),
  outboxMaxWaitMs: Number(process.env.LOAD_OUTBOX_MAX_WAIT_MS ?? 60_000),
};

const TEST_DB = process.env.LOAD_DB ?? 'desafio_jungle_load';

interface Wallet {
  id: string;
  playerId: string;
}

interface PhaseResult {
  label: string;
  requests: number;
  ok: number;
  rejected: number;
  serverError: number;
  transportError: number;
  other: number;
  latencies: number[];
  seconds: number;
}

const emptyPhase = (label: string): PhaseResult => ({
  label,
  requests: 0,
  ok: 0,
  rejected: 0,
  serverError: 0,
  transportError: 0,
  other: 0,
  latencies: [],
  seconds: 0,
});

async function main(): Promise<void> {
  process.env.POSTGRES_DB = TEST_DB;
  process.env.WAGER_PENDING_WORKER_POLL_MS = '0';
  process.env.WAGER_SQS_CONSUMER_ENABLED = 'false';
  process.env.WAGER_OUTBOX_PUBLISHER_ENABLED = 'true';
  process.env.WAGER_OUTBOX_POLL_MS = '50';

  const helpers = await import('./../test-db.js');
  const { AppModule } = await import('./../../src/app.module.js');
  const { Test } = await import('@nestjs/testing');

  await helpers.dropDatabaseIfExists(TEST_DB);
  const migrator = await MikroORM.init(helpers.ormOptionsFor(TEST_DB));
  await migrator.migrator.up();
  await migrator.close(true);
  // Independent read connection used to observe the outbox drain from the DB
  // (source of truth — the /metrics gauge only refreshes when a full 100-row
  // publish batch completes, which is too coarse under load).
  const adminOrm = await MikroORM.init(helpers.ormOptionsFor(TEST_DB));

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const startedAt = performance.now();

  const provider = `load-${randomUUID().slice(0, 8)}`;
  let extSeq = 0;

  async function createWallet(balance: string): Promise<Wallet> {
    const response = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: randomUUID(),
        initialBalance: { amount: balance, currency: 'BRL' },
      }),
    });
    if (response.status !== 201) {
      throw new Error(
        `wallet creation failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as Wallet;
  }

  async function submitBet(wallet: Wallet, amount: string): Promise<number> {
    const externalTransactionId = `load-${(extSeq += 1)}`;
    const response = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': `${provider}:${externalTransactionId}`,
      },
      body: JSON.stringify({
        providerId: provider,
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-load',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      }),
    });
    return response.status;
  }

  /** Fixed-worker pool: keeps `workers` requests in flight until `total`. */
  async function hammer(
    result: PhaseResult,
    total: number,
    workers: number,
    fn: (index: number) => Promise<number>,
  ): Promise<void> {
    let next = 0;
    const startWall = performance.now();
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= total) {
          return;
        }
        const start = performance.now();
        try {
          const status = await fn(index);
          const ms = performance.now() - start;
          result.latencies.push(ms);
          result.requests += 1;
          if (status >= 500) {
            result.serverError += 1;
          } else if (status === 422) {
            result.rejected += 1;
          } else if (status === 200 || status === 201) {
            result.ok += 1;
          } else {
            result.other += 1;
          }
        } catch {
          result.transportError += 1;
          result.requests += 1;
          result.latencies.push(performance.now() - start);
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, () => worker()));
    result.seconds = (performance.now() - startWall) / 1000;
  }

  // ---- seed wallets -------------------------------------------------------
  console.log(`seeding ${knobs.wallets} wallets of 1000.00 BRL ...`);
  const wallets: Wallet[] = [];
  {
    let next = 0;
    const seed = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= knobs.wallets) {
          return;
        }
        wallets.push(await createWallet('1000.00'));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(20, knobs.wallets) }, () => seed()),
    );
  }
  const hotWallet = await createWallet('100000000.00');
  console.log(`seeded ${wallets.length} wallets + 1 hot wallet`);

  const phase = (label: string): PhaseResult => emptyPhase(label);

  // ---- warm-up (steady state, discarded from latency stats) ---------------
  const warmup = phase('warm-up (discarded)');
  await hammer(warmup, knobs.warmup, 20, async (index) =>
    submitBet(wallets[index % wallets.length], '10.00'),
  );

  // ---- phase 1: distributed load over distinct wallets --------------------
  const distributed = phase('distributed');
  console.log(
    `phase 1: ${knobs.distributed} bets over ${knobs.wallets} wallets @${knobs.concurrency} workers ...`,
  );
  await hammer(
    distributed,
    knobs.distributed,
    knobs.concurrency,
    async (index) => submitBet(wallets[index % wallets.length], '10.00'),
  );

  // ---- phase 2: hot wallet (row-lock serialization) -----------------------
  const hot = phase('hot wallet');
  console.log(
    `phase 2: ${knobs.hotRequests} bets on a single wallet @${knobs.concurrency} workers ...`,
  );
  await hammer(hot, knobs.hotRequests, knobs.concurrency, () =>
    submitBet(hotWallet, '1.00'),
  );

  // ---- outbox drain sample (DB-measured) -----------------------------------
  // The publisher drains in batches of 100 and only then refreshes its /metrics
  // gauge, so observing the outbox table directly is the honest signal. We
  // wait until everything is published (lag is meaningful once it catches up)
  // and keep the peak lag observed along the way.
  async function outboxStats(): Promise<{ pending: number; lag: number }> {
    const pendingRow = (await adminOrm.em
      .getConnection()
      .execute(
        `select count(*) as pending from outbox_message where published_at is null`,
        [],
        'get',
      )) as { pending: string };
    const lagRow = (await adminOrm.em
      .getConnection()
      .execute(
        `select coalesce(extract(epoch from (now() - min(occurred_at))), 0) as lag from outbox_message where published_at is null`,
        [],
        'get',
      )) as { lag: string };
    return { pending: Number(pendingRow.pending), lag: Number(lagRow.lag) };
  }

  let maxOutboxLag = 0;
  let lastOutboxPending = -1;
  const drainDeadline = Date.now() + knobs.outboxMaxWaitMs;
  for (;;) {
    const { pending, lag } = await outboxStats();
    lastOutboxPending = pending;
    maxOutboxLag = Math.max(maxOutboxLag, pending > 0 ? lag : 0);
    if (pending === 0 || Date.now() > drainDeadline) {
      break;
    }
    await Bun.sleep(250);
  }

  // ---- report --------------------------------------------------------------
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const results = [distributed, hot];
  const combined = { ...emptyPhase('combined'), requests: 0 };
  for (const result of results) {
    combined.requests += result.requests;
    combined.ok += result.ok;
    combined.rejected += result.rejected;
    combined.serverError += result.serverError;
    combined.transportError += result.transportError;
    combined.other += result.other;
    combined.latencies.push(...result.latencies);
    combined.seconds += result.seconds;
  }

  console.log('\n========== LOAD TEST REPORT ==========');
  console.log(
    `runtime:       Bun ${process.versions.bun} on ${process.platform}`,
  );
  console.log(
    `database:      PostgreSQL ${process.env.DATABASE_HOST ?? 'localhost'}:${process.env.DATABASE_PORT ?? '5432'} (db ${TEST_DB})`,
  );
  console.log(`broker:        Ministack ${process.env.AWS_ENDPOINT_URL}`);
  console.log(
    `outbox:        publisher ON (${process.env.AWS_SQS_EVENTS_QUEUE ?? 'wager-events.fifo'})`,
  );
  console.log(`knobs:         ${JSON.stringify(knobs)}`);
  console.log(`total wall:    ${elapsedSeconds.toFixed(1)}s`);
  for (const result of results) {
    printPhase(result);
  }
  console.log('\noverall error rate (5xx + transport):');
  const errors = combined.serverError + combined.transportError;
  console.log(
    `  ${errors}/${combined.requests} = ${((100 * errors) / combined.requests).toFixed(3)}%`,
  );

  const finalMetrics = await (await fetch(`${base}/metrics`)).text();
  console.log(
    '\nmetrics (cumulative in this process; counts that never fired show 0):',
  );
  console.log(
    `  wager_transactions_total{status=PROCESSED} = ${metricNumber(finalMetrics, 'wager_transactions_total', 'PROCESSED')} (incl. warm-up)`,
  );
  console.log(
    `  wager_transactions_total{status=REJECTED}  = ${metricNumber(finalMetrics, 'wager_transactions_total', 'REJECTED')}`,
  );
  console.log(
    `  wager_duplicates_total                     = ${metricNumber(finalMetrics, 'wager_duplicates_total')}`,
  );
  console.log(
    `  db_lock_conflicts_total                    = ${metricNumber(finalMetrics, 'db_lock_conflicts_total')}`,
  );
  console.log(
    `  outbox_pending (last sample, DB)         = ${lastOutboxPending}`,
  );
  console.log(
    `  outbox_lag_seconds (max during drain, DB) = ${maxOutboxLag.toFixed(3)}`,
  );
  console.log('=========================================');

  await app.close();
  const finalOutbox = await outboxStats();
  const finalPublished = await outboxPublished();
  console.log('\noutbox rows after drain (from DB):');
  console.log(
    `  pending=${finalOutbox.pending} (should be 0)  published=${finalPublished}`,
  );
  await adminOrm.close(true);
  await helpers.dropDatabaseIfExists(TEST_DB);

  async function outboxPublished(): Promise<number> {
    const row = (await adminOrm.em
      .getConnection()
      .execute(
        `select count(*) as published from outbox_message where published_at is not null`,
        [],
        'get',
      )) as { published: string };
    return Number(row.published);
  }
}

function printPhase(result: PhaseResult): void {
  const sorted = [...result.latencies].sort((a, b) => a - b);
  const percentile = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const avg =
    sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
  console.log(
    `\n${result.label}: ${result.requests} requests in ${result.seconds.toFixed(1)}s`,
  );
  console.log(
    `  throughput: ${(result.requests / Math.max(0.001, result.seconds)).toFixed(1)} req/s`,
  );
  console.log(
    `  latency:    avg ${avg.toFixed(1)}ms  p50 ${percentile(50).toFixed(1)}ms  p95 ${percentile(95).toFixed(1)}ms  p99 ${percentile(99).toFixed(1)}ms`,
  );
  console.log(
    `  outcomes:   ok=${result.ok}  business-rejected(422)=${result.rejected}  5xx=${result.serverError}  transport-errors=${result.transportError}  other=${result.other}`,
  );
}

function metricNumber(text: string, name: string, labelValue?: string): number {
  const value = metricValue(text, name, labelValue);
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metricValue(
  text: string,
  name: string,
  labelValue?: string,
): string | undefined {
  const label = labelValue !== undefined ? `{status="${labelValue}"}` : '';
  const prefix = label ? `${name}${label} ` : `${name} `;
  const line = text.split('\n').find((entry) => entry.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

void main().catch((error) => {
  console.error(
    `load test failed: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
