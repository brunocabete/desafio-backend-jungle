import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_read_test');

interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
}

interface LedgerEntry {
  id: string;
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  createdAt: string;
}

describe('Read endpoints (e2e)', () => {
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

  async function walkLedger(
    walletId: string,
    limit: number,
  ): Promise<LedgerEntry[]> {
    const entries: LedgerEntry[] = [];
    let cursor: string | null = null;
    for (;;) {
      const url =
        cursor === null
          ? `/wallets/${walletId}/ledger?limit=${limit}`
          : `/wallets/${walletId}/ledger?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
      const response = await request(app.getHttpServer()).get(url).expect(200);
      entries.push(...(response.body.entries as LedgerEntry[]));
      cursor = response.body.nextCursor as string | null;
      if (!cursor) {
        break;
      }
    }
    return entries;
  }

  it('returns the stored wallet balance and version', async () => {
    const wallet = await createWallet('1000.00');
    const response = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .expect(200);

    expect(response.body).toMatchObject({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('returns 404 for an unknown or malformed wallet id', async () => {
    const phantom = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
    for (const walletId of [phantom, 'not-a-uuid']) {
      const response = await request(app.getHttpServer())
        .get(`/wallets/${walletId}`)
        .expect(404);
      expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
    }
  });

  it('lists ledger entries in ascending order with a stable opaque cursor', async () => {
    const wallet = await createWallet('1000.00');
    await submit(wallet, { money: { amount: '50.00', currency: 'BRL' } });
    await submit(wallet, {
      kind: 'WIN',
      money: { amount: '25.00', currency: 'BRL' },
    });
    await submit(wallet, { money: { amount: '20.00', currency: 'BRL' } });

    const page1 = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?limit=2`)
      .expect(200);
    expect(page1.body.entries).toHaveLength(2);
    expect(page1.body.walletId).toBe(wallet.id);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await request(app.getHttpServer())
      .get(
        `/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      )
      .expect(200);
    expect(page2.body.entries).toHaveLength(2);
    expect(page2.body.nextCursor).toBeNull();

    const all = await walkLedger(wallet.id, 2);
    expect(all).toHaveLength(4);

    const ids = all.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(4);
    expect(all[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
    });
    expect(all[1]).toMatchObject({
      direction: 'DEBIT',
      money: { amount: '50.00', currency: 'BRL' },
      balanceBefore: { amount: '1000.00', currency: 'BRL' },
      balanceAfter: { amount: '950.00', currency: 'BRL' },
    });
    expect(all[3].balanceAfter).toEqual({ amount: '955.00', currency: 'BRL' });

    const before = all.map((entry) => new Date(entry.createdAt).getTime());
    expect([...before].sort((a, b) => a - b)).toEqual(before);
  });

  it('paginates consistently when new entries land between pages', async () => {
    const wallet = await createWallet('1000.00');
    await submit(wallet, { money: { amount: '10.00', currency: 'BRL' } });
    await submit(wallet, { money: { amount: '10.00', currency: 'BRL' } });

    const first = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?limit=2`)
      .expect(200);

    await submit(wallet, { money: { amount: '10.00', currency: 'BRL' } });

    const second = await request(app.getHttpServer())
      .get(
        `/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      )
      .expect(200);

    const all = await walkLedger(wallet.id, 2);
    const ids = all.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(all.length);
    const secondIds = second.body.entries.map((entry: LedgerEntry) => entry.id);
    const firstIds = first.body.entries.map((entry: LedgerEntry) => entry.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it('rejects an unknown wallet ledger with 404', async () => {
    const response = await request(app.getHttpServer())
      .get('/wallets/0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1/ledger')
      .expect(404);
    expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  it('rejects a malformed cursor or limit with 400', async () => {
    const wallet = await createWallet('100.00');
    const malformedCursor = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?cursor=${encodeURIComponent('!!!')}`)
      .expect(400);
    expect(malformedCursor.body).toMatchObject({ code: 'INVALID_PAYLOAD' });

    for (const limit of ['0', '-1', 'abc', '500']) {
      const response = await request(app.getHttpServer())
        .get(`/wallets/${wallet.id}/ledger?limit=${limit}`)
        .expect(400);
      expect(response.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    }
  });

  it('returns an empty ledger page with no cursor for a zero-movement wallet', async () => {
    const wallet = await createWallet('0.00');
    const response = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger`)
      .expect(200);
    expect(response.body).toMatchObject({
      walletId: wallet.id,
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('looks up a transaction by internal id', async () => {
    const wallet = await createWallet('1000.00');
    const bet = await submit(wallet, {
      externalTransactionId: `lookup-${randomUUID().slice(0, 8)}`,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(bet.status).toBe(200);

    const response = await request(app.getHttpServer())
      .get(`/wagering/transactions/${bet.body.transactionId}`)
      .expect(200);

    expect(response.body).toMatchObject({
      id: bet.body.transactionId,
      providerId: provider,
      walletId: wallet.id,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(response.body.processedAt).toEqual(expect.any(String));
  });

  it('exposes the failureCode of a rejected transaction', async () => {
    const wallet = await createWallet('10.00');
    const rejected = await submit(wallet, {
      externalTransactionId: `rejected-${randomUUID().slice(0, 8)}`,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(rejected.status).toBe(422);

    const response = await request(app.getHttpServer())
      .get(`/wagering/transactions/${rejected.body.transactionId}`)
      .expect(200);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('returns 404 for an unknown or malformed internal transaction id', async () => {
    for (const transactionId of [
      '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      'not-a-uuid',
    ]) {
      const response = await request(app.getHttpServer())
        .get(`/wagering/transactions/${transactionId}`)
        .expect(404);
      expect(response.body).toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
    }
  });

  it('looks up a transaction by provider id and external transaction id', async () => {
    const wallet = await createWallet('1000.00');
    const external = `by-ref-${randomUUID().slice(0, 8)}`;
    const bet = await submit(wallet, {
      externalTransactionId: external,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(bet.status).toBe(200);

    const response = await request(app.getHttpServer())
      .get(
        `/providers/${encodeURIComponent(provider)}/wagering/transactions/${external}`,
      )
      .expect(200);
    expect(response.body).toMatchObject({
      id: bet.body.transactionId,
      externalTransactionId: external,
      providerId: provider,
    });
  });

  it('returns 404 when the provider/external reference is unknown', async () => {
    const wallet = await createWallet('100.00');
    await submit(wallet, {
      externalTransactionId: `known-${randomUUID().slice(0, 8)}`,
    });

    const missing = await request(app.getHttpServer())
      .get(
        `/providers/${encodeURIComponent(provider)}/wagering/transactions/never-existed`,
      )
      .expect(404);
    expect(missing.body).toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });

    const wrongProvider = await request(app.getHttpServer())
      .get('/providers/unknown-provider/wagering/transactions/never-existed')
      .expect(404);
    expect(wrongProvider.body).toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
  });
});
