import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  METRIC_NAMES,
  MetricsService,
} from '../src/common/metrics/metrics.service.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_reconciliation_test');

interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
}

describe('POST /wallets/:walletId/reconciliation (e2e)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let metrics: MetricsService;
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
    const migrator = await MikroORM.init(helpers.ormOptionsFor(TEST_DB));
    await migrator.migrator.up();
    await migrator.close(true);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    orm = app.get(MikroORM);
    metrics = app.get(MetricsService);
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

  async function createWallet(balance = '1000.00'): Promise<WalletView> {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: balance, currency: 'BRL' },
      })
      .expect(201);
    return response.body as WalletView;
  }

  async function submit(
    wallet: WalletView,
    overrides: Record<string, unknown> = {},
  ): Promise<request.Response> {
    const externalTransactionId =
      (overrides.externalTransactionId as string | undefined) ??
      `ext-${(extSeq += 1)}`;
    const idempotencyKey =
      (overrides.idempotencyKey as string | undefined) ??
      `${provider}:${externalTransactionId}`;
    return request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        providerId: provider,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
        ...overrides,
        externalTransactionId,
        idempotencyKey,
      });
  }

  function reconcile(walletId: string) {
    return request(app.getHttpServer())
      .post(`/wallets/${walletId}/reconciliation`)
      .send();
  }

  it('confirms a consistent wallet against its ledger reconstruction', async () => {
    const wallet = await createWallet('1000.00');
    await submit(wallet, { money: { amount: '50.00', currency: 'BRL' } });
    await submit(wallet, {
      kind: 'WIN',
      money: { amount: '25.00', currency: 'BRL' },
    });

    const response = await reconcile(wallet.id).expect(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
    expect(metrics.get(METRIC_NAMES.walletReconciliationTotal)).toBe(1);
    expect(metrics.get(METRIC_NAMES.walletReconciliationDivergent)).toBe(0);
  });

  it('treats a zero-balance wallet with no ledger entries as consistent', async () => {
    const wallet = await createWallet('0.00');

    const response = await reconcile(wallet.id).expect(200);
    expect(response.body).toMatchObject({
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
  });

  it('flags a divergence without silently fixing the stored balance', async () => {
    const wallet = await createWallet('1000.00');
    await submit(wallet, { money: { amount: '50.00', currency: 'BRL' } });

    await orm.em
      .fork()
      .getConnection()
      .execute(
        'update "wallet" set "balance_amount" = ? where "id" = ?',
        ['1234.45', wallet.id],
        'run',
      );

    const response = await reconcile(wallet.id).expect(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '1234.45', currency: 'BRL' },
      calculatedBalance: { amount: '950.00', currency: 'BRL' },
      difference: { amount: '284.45', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
    });
    expect(metrics.get(METRIC_NAMES.walletReconciliationDivergent)).toBe(1);

    const again = await reconcile(wallet.id).expect(200);
    expect(again.body.consistent).toBe(false);

    const stored = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .expect(200);
    expect(stored.body.balance).toEqual({
      amount: '1234.45',
      currency: 'BRL',
    });
    expect(metrics.get(METRIC_NAMES.walletReconciliationDivergent)).toBe(2);
  });

  it('returns 404 for an unknown or malformed wallet id', async () => {
    for (const walletId of [
      '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      'not-a-uuid',
    ]) {
      const response = await reconcile(walletId).expect(404);
      expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
    }
  });
});
