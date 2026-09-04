import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { OutboxMessageEntity } from '../src/db/entities/outbox-message.entity.js';
import { WagerTransactionEntity } from '../src/db/entities/wager-transaction.entity.js';
import { WagerTransactionService } from '../src/wagering/wager-transaction.service.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_outbox_test');

interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
}

interface OutboxRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    version: number;
    occurredAt: string;
    data: Record<string, unknown>;
  };
}

describe('transactional outbox — events commit atomically with the settlement (e2e)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let service: WagerTransactionService;
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
    service = app.get(WagerTransactionService);
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

  async function outboxRows(aggregateId: string): Promise<OutboxRow[]> {
    const rows = (await orm.em
      .fork()
      .find(OutboxMessageEntity, { aggregateId })) as unknown as OutboxRow[];
    return rows;
  }

  async function eventTypeCounts(
    aggregateId: string,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of await outboxRows(aggregateId)) {
      counts[row.eventType] = (counts[row.eventType] ?? 0) + 1;
    }
    return counts;
  }

  async function rowsForTransactionOfKind(
    transactionId: string,
    eventType: string,
  ): Promise<OutboxRow[]> {
    const rows = await outboxRows(transactionId);
    return rows.filter((row) => row.eventType === eventType);
  }

  async function createWallet(balance = '100.00'): Promise<WalletView> {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: balance, currency: 'BRL' },
      })
      .expect(201);
    return response.body as WalletView;
  }

  async function openingTransactionId(walletId: string): Promise<string> {
    const row = await orm.em.fork().findOne(WagerTransactionEntity, {
      walletId,
      kind: 'OPENING',
    });
    if (!row) {
      throw new Error(`no OPENING transaction found for wallet ${walletId}`);
    }
    return row.id;
  }

  async function submit(
    wallet: WalletView,
    overrides: Record<string, unknown>,
  ): Promise<request.Response> {
    const externalTransactionId =
      (overrides.externalTransactionId as string | undefined) ??
      `ext-${(extSeq += 1)}`;
    const idempotencyKey =
      (overrides.idempotencyKey as string | undefined) ??
      `${provider}:${externalTransactionId}`;
    const payload = {
      providerId: provider,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
      externalTransactionId,
      idempotencyKey,
    };
    return request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
  }

  it('commits OPENING + WalletBalanceChanged events when a wallet opens with balance, nothing for a zero wallet', async () => {
    const wallet = await createWallet('1000.00');
    const openingId = await openingTransactionId(wallet.id);

    expect(await eventTypeCounts(openingId)).toEqual({
      WagerTransactionProcessed: 1,
    });
    const [openingEvent] = await rowsForTransactionOfKind(
      openingId,
      'WagerTransactionProcessed',
    );
    expect(openingEvent.payload.data).toMatchObject({
      transactionId: openingId,
      walletId: wallet.id,
      kind: 'OPENING',
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
    });

    expect(await eventTypeCounts(wallet.id)).toEqual({
      WalletBalanceChanged: 1,
    });
    const [balanceEvent] = await outboxRows(wallet.id);
    expect(balanceEvent.payload.data).toEqual({
      walletId: wallet.id,
      transactionId: openingId,
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });

    const zero = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: randomUUID() })
      .expect(201);
    expect(await outboxRows((zero.body as WalletView).id)).toEqual([]);
  });

  it('emits Processed + WalletBalanceChanged for a BET and never duplicates on replay', async () => {
    const wallet = await createWallet('100.00');
    const external = `bet-${randomUUID().slice(0, 8)}`;
    const response = await submit(wallet, {
      externalTransactionId: external,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(response.status).toBe(200);
    const transactionId = response.body.transactionId as string;

    expect(await eventTypeCounts(transactionId)).toEqual({
      WagerTransactionProcessed: 1,
    });
    expect((await outboxRows(transactionId))[0].payload.data).toMatchObject({
      balanceAfter: { amount: '75.00', currency: 'BRL' },
    });

    const balanceEvents = (await outboxRows(wallet.id)).filter(
      (row) =>
        row.eventType === 'WalletBalanceChanged' &&
        row.payload.data.transactionId === transactionId,
    );
    expect(balanceEvents).toHaveLength(1);
    expect(balanceEvents[0].payload.data).toMatchObject({
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });

    const replay = await submit(wallet, {
      externalTransactionId: external,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotentReplay: true });

    expect(await eventTypeCounts(transactionId)).toEqual({
      WagerTransactionProcessed: 1,
    });
    expect(await outboxRows(wallet.id)).toHaveLength(2);
  });

  it('emits only Processed (no balance event) for a LOSS', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(wallet, {
      kind: 'LOSS',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(response.status).toBe(200);
    const transactionId = response.body.transactionId as string;

    expect(await eventTypeCounts(transactionId)).toEqual({
      WagerTransactionProcessed: 1,
    });
    expect(
      (await outboxRows(transactionId))[0].payload.data.balanceAfter,
    ).toBeUndefined();
    expect(await outboxRows(wallet.id)).toHaveLength(1);
  });

  it('emits only a Rejected event for a business rejection without a balance event', async () => {
    const wallet = await createWallet('10.00');
    const response = await submit(wallet, {
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(response.status).toBe(422);
    const transactionId = response.body.transactionId as string;

    expect(await eventTypeCounts(transactionId)).toEqual({
      WagerTransactionRejected: 1,
    });
    expect((await outboxRows(transactionId))[0].payload.data).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(await outboxRows(wallet.id)).toHaveLength(1);
  });

  it('emits PendingReference once and then the resolution events in the settlement transaction', async () => {
    const wallet = await createWallet('100.00');
    const betExternal = `bet-late-${randomUUID().slice(0, 8)}`;

    const refund = await submit(wallet, {
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternal,
    });
    expect(refund.status).toBe(202);
    const refundId = refund.body.transactionId as string;
    expect(await eventTypeCounts(refundId)).toEqual({
      WagerTransactionPendingReference: 1,
    });

    const bet = await submit(wallet, {
      kind: 'BET',
      externalTransactionId: betExternal,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(bet.status).toBe(200);
    const betId = bet.body.transactionId as string;

    expect(await eventTypeCounts(betId)).toEqual({
      WagerTransactionProcessed: 1,
    });
    expect(await eventTypeCounts(refundId)).toEqual({
      WagerTransactionPendingReference: 1,
      WagerTransactionProcessed: 1,
    });
    const refundBalanceEvents = (await outboxRows(wallet.id)).filter(
      (row) =>
        row.eventType === 'WalletBalanceChanged' &&
        row.payload.data.transactionId === refundId,
    );
    expect(refundBalanceEvents).toHaveLength(1);
    expect(refundBalanceEvents[0].payload.data).toMatchObject({
      direction: 'CREDIT',
      balanceAfter: { amount: '100.00', currency: 'BRL' },
    });
  });

  it('emits a Rejected event once when the pending-reference worker expires a transaction', async () => {
    const wallet = await createWallet('100.00');
    const missingBet = `bet-never-${randomUUID().slice(0, 8)}`;

    const refund = await submit(wallet, {
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: missingBet,
    });
    expect(refund.status).toBe(202);
    const refundId = refund.body.transactionId as string;

    const handled = await service.reprocessPendingReferences({
      ttlMs: 0,
      maxAttempts: 0,
    });
    expect(handled).toBeGreaterThan(0);

    expect(await eventTypeCounts(refundId)).toEqual({
      WagerTransactionPendingReference: 1,
      WagerTransactionRejected: 1,
    });
    const rejected = (await outboxRows(refundId)).filter(
      (row) => row.eventType === 'WagerTransactionRejected',
    );
    expect(rejected[0].payload.data).toMatchObject({
      status: 'REJECTED',
      failureCode: 'UNRESOLVED_REFERENCE',
    });

    const walletRow = await orm.em
      .fork()
      .findOne(WagerTransactionEntity, { id: refundId });
    expect(walletRow?.status).toBe('REJECTED');
    expect(await outboxRows(wallet.id)).toHaveLength(1);

    await service.reprocessPendingReferences({ ttlMs: 0, maxAttempts: 0 });
    expect(await eventTypeCounts(refundId)).toEqual({
      WagerTransactionPendingReference: 1,
      WagerTransactionRejected: 1,
    });
  });
});
