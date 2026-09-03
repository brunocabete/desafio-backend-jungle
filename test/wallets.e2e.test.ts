import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import request from 'supertest';
import config from '../src/mikro-orm.config.js';
import { WalletEntity } from '../src/db/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../src/db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/db/entities/wallet-ledger-entry.entity.js';

const ADMIN_DB = 'postgres';
const TEST_DB = `desafio_jungle_wallet_test_${process.pid}`;
const MIGRATIONS_PATH = resolve('src/migrations');

function optionsFor(dbName: string) {
  return {
    ...config,
    dbName,
    migrations: {
      ...config.migrations,
      path: MIGRATIONS_PATH,
      pathTs: MIGRATIONS_PATH,
      snapshot: false,
    },
  };
}

async function dropTestDatabase(): Promise<void> {
  const admin = await MikroORM.init(optionsFor(ADMIN_DB));
  try {
    await admin.em
      .getConnection()
      .execute(`drop database if exists "${TEST_DB}" with (force)`);
  } finally {
    await admin.close(true);
  }
}

describe('POST /wallets (e2e)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let previousDbName: string | undefined;

  beforeAll(async () => {
    await dropTestDatabase();
    const migrator = await MikroORM.init(optionsFor(TEST_DB));
    await migrator.migrator.up();
    await migrator.close(true);

    previousDbName = process.env.POSTGRES_DB;
    process.env.POSTGRES_DB = TEST_DB;
    const { AppModule } = await import('./../src/app.module.js');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    orm = app.get(MikroORM);
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await dropTestDatabase();
    if (previousDbName === undefined) {
      delete process.env.POSTGRES_DB;
    } else {
      process.env.POSTGRES_DB = previousDbName;
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

  it('creates a wallet with an OPENING credit in the same transaction', async () => {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: playerId(),
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      })
      .expect(201);

    expect(response.body).toMatchObject({
      playerId: expect.any(String),
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(response.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    expect(await countBy(WalletEntity, { id: response.body.id })).toBe(1);
    expect(
      await countBy(WagerTransactionEntity, {
        walletId: response.body.id,
        kind: 'OPENING',
      }),
    ).toBe(1);
    expect(
      await countBy(WalletLedgerEntryEntity, {
        walletId: response.body.id,
        direction: 'CREDIT',
      }),
    ).toBe(1);
  });

  it('defaults currency to BRL and allows a zero-balance wallet without OPENING', async () => {
    const withDefaultCurrency = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: playerId(), initialBalance: { amount: '5.00' } })
      .expect(201);
    expect(withDefaultCurrency.body.balance).toEqual({
      amount: '5.00',
      currency: 'BRL',
    });

    const zero = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: playerId() })
      .expect(201);
    expect(zero.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(
      await countBy(WagerTransactionEntity, {
        walletId: zero.body.id,
        kind: 'OPENING',
      }),
    ).toBe(0);
  });

  it('rejects a duplicate wallet for the same player + currency with a conflict', async () => {
    const id = playerId();
    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: id,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      })
      .expect(201);

    const duplicate = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: id,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      })
      .expect(409);
    expect(duplicate.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
  });

  it('allows the same player in a different currency', async () => {
    const id = playerId();
    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: id,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: id,
        initialBalance: { amount: '5.00', currency: 'EUR' },
      })
      .expect(201);
  });

  it('rejects invalid payloads with 400 INVALID_PAYLOAD', async () => {
    const cases = [
      {},
      { initialBalance: { amount: '10.00', currency: 'BRL' } },
      { playerId: '', initialBalance: { amount: '10.00', currency: 'BRL' } },
      { playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } },
      { playerId: 'p', initialBalance: { amount: '1.234', currency: 'BRL' } },
      { playerId: 'p', initialBalance: { amount: '1.00', currency: 'brl' } },
    ];
    for (const body of cases) {
      const response = await request(app.getHttpServer())
        .post('/wallets')
        .send(body)
        .expect(400);
      expect(response.body.code).toBe('INVALID_PAYLOAD');
    }
  });
});
