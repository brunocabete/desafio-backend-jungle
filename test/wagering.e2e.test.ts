import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { WalletEntity } from '../src/db/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../src/db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/db/entities/wallet-ledger-entry.entity.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_wager_test');

interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
}

describe('POST /wagering/transactions (e2e)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let previousDbName: string | undefined;
  let provider: string;
  let extSeq = 0;
  let previousPoll: string | undefined;

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

  function playerId(): string {
    return randomUUID();
  }

  async function countBy(
    entity:
      | typeof WalletEntity
      | typeof WagerTransactionEntity
      | typeof WalletLedgerEntryEntity,
    where: Record<string, unknown>,
  ): Promise<number> {
    return orm.em.fork().count(entity as never, where as never);
  }

  async function createWallet(
    balance = '100.00',
    currency = 'BRL',
  ): Promise<WalletView> {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: playerId(),
        initialBalance: { amount: balance, currency },
      })
      .expect(201);
    return response.body as WalletView;
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

  function debitEntries(walletId: string, amount = '25.00') {
    return countBy(WalletLedgerEntryEntity, {
      walletId,
      direction: 'DEBIT',
      moneyAmount: amount,
    });
  }

  function creditEntries(walletId: string, amount = '25.00') {
    return countBy(WalletLedgerEntryEntity, {
      walletId,
      direction: 'CREDIT',
      moneyAmount: amount,
    });
  }

  it('settles a BET with a single DEBIT ledger entry', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(wallet, {
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(response.body.transactionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await debitEntries(wallet.id)).toBe(1);
  });

  it('replays an identical submission with the original result', async () => {
    const wallet = await createWallet('100.00');
    const external = `bet-replay-${randomUUID().slice(0, 8)}`;
    const first = await submit(wallet, {
      externalTransactionId: external,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(first.body.idempotentReplay).toBe(false);

    const replay = await submit(wallet, {
      externalTransactionId: external,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      transactionId: first.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect(await debitEntries(wallet.id)).toBe(1);
  });

  it('conflicts when the same idempotency key carries a different payload', async () => {
    const wallet = await createWallet('100.00');
    const external = `bet-conflict-${randomUUID().slice(0, 8)}`;
    await submit(wallet, {
      externalTransactionId: external,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    const conflicting = await submit(wallet, {
      externalTransactionId: external,
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    expect(conflicting.status).toBe(409);
    expect(conflicting.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects a BET with insufficient funds without touching the balance', async () => {
    const wallet = await createWallet('10.00');
    const response = await submit(wallet, {
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await debitEntries(wallet.id)).toBe(0);
    expect(
      await countBy(WagerTransactionEntity, {
        walletId: wallet.id,
        status: 'REJECTED',
      }),
    ).toBe(1);
  });

  it('replays a rejected submission with the same failureCode', async () => {
    const wallet = await createWallet('10.00');
    const external = `bet-rejected-${randomUUID().slice(0, 8)}`;
    const first = await submit(wallet, {
      externalTransactionId: external,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(first.status).toBe(422);

    const replay = await submit(wallet, {
      externalTransactionId: external,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      transactionId: first.body.transactionId,
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: true,
    });
  });

  it('settles a LOSS without moving the balance or creating a ledger entry', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(wallet, {
      kind: 'LOSS',
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await debitEntries(wallet.id)).toBe(0);
    expect(
      await countBy(WalletLedgerEntryEntity, { walletId: wallet.id }),
    ).toBe(1);
  });

  it('credits the wallet on a WIN', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(wallet, {
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(response.status).toBe(200);
    expect(response.body.balance).toEqual({
      amount: '150.00',
      currency: 'BRL',
    });
    expect(await creditEntries(wallet.id, '50.00')).toBe(1);
  });

  it('refunds a processed BET with a single CREDIT entry', async () => {
    const wallet = await createWallet('100.00');
    const betExternal = `bet-${randomUUID().slice(0, 8)}`;
    await submit(wallet, {
      kind: 'BET',
      externalTransactionId: betExternal,
      money: { amount: '25.00', currency: 'BRL' },
    });

    const refund = await submit(wallet, {
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternal,
    });

    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await debitEntries(wallet.id)).toBe(1);
    expect(await creditEntries(wallet.id)).toBe(1);
  });

  it('keeps a REFUND PENDING_REFERENCE when the reference has not arrived', async () => {
    const wallet = await createWallet('100.00');
    const missingBet = `bet-missing-${randomUUID().slice(0, 8)}`;
    const response = await submit(wallet, {
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: missingBet,
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      idempotentReplay: false,
    });
    expect(
      await countBy(WagerTransactionEntity, {
        walletId: wallet.id,
        status: 'PENDING_REFERENCE',
      }),
    ).toBe(1);
  });

  it('resolves a pending REFUND once its BET arrives', async () => {
    const wallet = await createWallet('100.00');
    const betExternal = `bet-late-${randomUUID().slice(0, 8)}`;
    const refund = await submit(wallet, {
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternal,
    });
    expect(refund.status).toBe(202);

    const bet = await submit(wallet, {
      kind: 'BET',
      externalTransactionId: betExternal,
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(bet.status).toBe(200);
    expect(bet.body).toMatchObject({ status: 'PROCESSED' });
    expect(
      await countBy(WagerTransactionEntity, {
        walletId: wallet.id,
        status: 'PENDING_REFERENCE',
      }),
    ).toBe(0);
    expect(
      await countBy(WagerTransactionEntity, {
        walletId: wallet.id,
        kind: 'REFUND',
        status: 'PROCESSED',
      }),
    ).toBe(1);
    expect(await debitEntries(wallet.id)).toBe(1);
    expect(await creditEntries(wallet.id)).toBe(1);
  });

  it('rejects a second REFUND of the same BET', async () => {
    const wallet = await createWallet('100.00');
    const betExternal = `bet-dup-${randomUUID().slice(0, 8)}`;
    await submit(wallet, {
      kind: 'BET',
      externalTransactionId: betExternal,
      money: { amount: '25.00', currency: 'BRL' },
    });

    const first = await submit(wallet, {
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternal,
    });
    expect(first.status).toBe(200);

    const second = await submit(wallet, {
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternal,
    });

    expect(second.status).toBe(422);
    expect(second.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
    expect(await creditEntries(wallet.id)).toBe(1);
  });

  it('allows one REFUND and one ROLLBACK of the same BET', async () => {
    const wallet = await createWallet('100.00');
    const betExternal = `bet-cross-reversal-${randomUUID().slice(0, 8)}`;
    await submit(wallet, {
      kind: 'BET',
      externalTransactionId: betExternal,
      money: { amount: '25.00', currency: 'BRL' },
    });

    const refund = await submit(wallet, {
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternal,
    });
    const rollback = await submit(wallet, {
      kind: 'ROLLBACK',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternal,
    });

    expect(refund.status).toBe(200);
    expect(rollback.status).toBe(200);
    expect(rollback.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '125.00', currency: 'BRL' },
    });
    expect(await creditEntries(wallet.id)).toBe(2);
  });

  it('rejects OPENING submissions as a business rule', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(wallet, {
      kind: 'OPENING',
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'OPENING_NOT_ALLOWED',
    });
  });

  it('returns 404 for a wager against an unknown wallet', async () => {
    const phantom = {
      id: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      playerId: randomUUID(),
    } as WalletView;

    const response = await submit(phantom, {
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  it('rejects invalid payloads with 400 INVALID_PAYLOAD', async () => {
    const wallet = await createWallet('100.00');
    const cases = [
      { kind: 'BET', money: { amount: '-5.00', currency: 'BRL' } },
      { kind: 'CASHBACK', money: { amount: '25.00', currency: 'BRL' } },
      { kind: 'REFUND', money: { amount: '25.00', currency: 'BRL' } },
      { kind: 'BET', money: { amount: '25.00', currency: 'brl' } },
      { kind: 'BET', money: undefined },
    ];
    for (const overrides of cases) {
      const response = await submit(wallet, overrides);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_PAYLOAD');
    }
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const wallet = await createWallet('100.00');
    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send({
        providerId: provider,
        externalTransactionId: `ext-no-key-${(extSeq += 1)}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_PAYLOAD');
  });
});
