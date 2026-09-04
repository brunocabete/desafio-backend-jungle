import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_metrics_test');

describe('observability — GET /metrics (e2e)', () => {
  let app: INestApplication;
  let previousDbName: string | undefined;
  let previousPoll: string | undefined;
  let provider: string;
  let extSeq = 0;

  beforeAll(async () => {
    previousDbName = process.env.POSTGRES_DB;
    previousPoll = process.env.WAGER_PENDING_WORKER_POLL_MS;
    process.env.POSTGRES_DB = TEST_DB;
    process.env.WAGER_PENDING_WORKER_POLL_MS = '0';
    const helpers = await import('./test-db.js');
    const { AppModule } = await import('./../src/app.module.js');

    await helpers.dropDatabaseIfExists(TEST_DB);
    const { MikroORM } = await import('@mikro-orm/core');
    const migrator = await MikroORM.init(helpers.ormOptionsFor(TEST_DB));
    await migrator.migrator.up();
    await migrator.close(true);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    provider = `provider-${randomUUID().slice(0, 8)}`;
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    const helpers = await import('./test-db.js');
    await helpers.dropDatabaseIfExists(TEST_DB);
    if (previousDbName === undefined) {
      delete process.env.POSTGRES_DB;
    } else {
      process.env.POSTGRES_DB = previousDbName;
    }
    if (previousPoll === undefined) {
      delete process.env.WAGER_PENDING_WORKER_POLL_MS;
    } else {
      process.env.WAGER_PENDING_WORKER_POLL_MS = previousPoll;
    }
  }, 60_000);

  async function createWallet(
    balance: string,
  ): Promise<{ id: string; playerId: string }> {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: balance, currency: 'BRL' },
      })
      .expect(201);
    return response.body as { id: string; playerId: string };
  }

  async function submit(
    wallet: { id: string; playerId: string },
    overrides: Record<string, unknown> = {},
  ): Promise<request.Response> {
    const externalTransactionId = `ext-${(extSeq += 1)}`;
    const idempotencyKey = `${provider}:${externalTransactionId}`;
    return request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        providerId: provider,
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        ...overrides,
      });
  }

  async function metricsText(): Promise<string> {
    const response = await request(app.getHttpServer()).get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    return response.text;
  }

  it('exposes counters by status, duplicates and the latency histogram', async () => {
    const rich = await createWallet('1000.00');
    const replayExternal = `ext-replay-${randomUUID().slice(0, 8)}`;
    const replayKey = `${provider}:${replayExternal}`;
    const replayPayload = {
      providerId: provider,
      externalTransactionId: replayExternal,
      playerId: rich.playerId,
      walletId: rich.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', replayKey)
      .send(replayPayload)
      .expect(200);
    expect(first.body.idempotentReplay).toBe(false);

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', replayKey)
      .send(replayPayload)
      .expect(200);
    expect(replay.body.idempotentReplay).toBe(true);

    const poor = await createWallet('10.00');
    const rejected = await submit(poor);
    expect(rejected.status).toBe(422);

    await request(app.getHttpServer())
      .post(`/wallets/${rich.id}/reconciliation`)
      .expect(200);

    const text = await metricsText();
    expect(text).toContain('# TYPE wager_transactions_total counter');
    expect(text).toContain('wager_transactions_total{status="PROCESSED"}');
    expect(text).toContain('wager_transactions_total{status="REJECTED"}');
    expect(text).toContain('wager_duplicates_total 1');
    expect(text).toContain('# TYPE wager_process_duration_ms histogram');
    expect(text).toMatch(/wager_process_duration_ms_bucket\{le=/);
    expect(text).toMatch(/wager_process_duration_ms_count \d+/);
    expect(text).toContain('# TYPE wallet_reconciliation_total counter');
    expect(text).toContain('wallet_reconciliation_total 1');
  });

  it('reports a healthy readiness probe alongside metrics', async () => {
    const readiness = await request(app.getHttpServer()).get('/health/ready');
    expect(readiness.status).toBe(200);
    expect(readiness.body).toMatchObject({
      status: 'ok',
      checks: { database: 'up', sqs: 'up' },
    });
  });
});
