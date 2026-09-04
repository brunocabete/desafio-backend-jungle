import { MikroORM } from '@mikro-orm/core';
import { dropDatabaseIfExists, ormOptionsFor } from './test-db.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_mig_test');

const APP_TABLES = [
  'wallet',
  'wager_transaction',
  'wallet_ledger_entry',
  'inbox_message',
  'outbox_message',
];

const EXPECTED_CONSTRAINTS = [
  'uq_wallet_player_currency',
  'uq_wager_provider_external',
  'uq_wager_provider_idempotency',
  'uq_ledger_transaction',
  'ck_wallet_balance_non_negative',
  'ck_ledger_balance_math',
];

describe('migrations on a fresh Postgres database', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    await dropDatabaseIfExists(TEST_DB);
    orm = await MikroORM.init(ormOptionsFor(TEST_DB));
  }, 60_000);

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
    await dropDatabaseIfExists(TEST_DB);
  }, 60_000);

  it('applies up, creates tables + constraints, enforces them, and is reversible', async () => {
    const executed = await orm.migrator.up();
    expect(executed.map((m) => m.name)).toEqual([
      expect.stringContaining('_init'),
      expect.stringContaining('_add_pending_reference_retry'),
      expect.stringContaining('add_single_reversal_unique'),
    ]);

    const conn = orm.em.getConnection();

    const tables = (
      await conn.execute(
        `select table_name from information_schema.tables where table_schema = 'public'`,
      )
    ).map((row: { table_name: string }) => row.table_name);
    for (const table of APP_TABLES) {
      expect(tables).toContain(table);
    }

    const tablesLiteral = APP_TABLES.map((t) => `'${t}'`).join(', ');
    const constraints: string[] = (
      await conn.execute(
        `select con.conname
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname in (${tablesLiteral})
          order by con.conname`,
      )
    ).map((row: { conname: string }) => row.conname);
    for (const name of EXPECTED_CONSTRAINTS) {
      expect(constraints).toContain(name);
    }

    const triggers = (
      await conn.execute(
        `select tgname from pg_trigger
          where tgrelid = 'wallet_ledger_entry'::regclass and not tgisinternal`,
      )
    ).map((row: { tgname: string }) => row.tgname);
    expect(triggers).toContain('trg_wallet_ledger_entry_no_update');

    await expect(
      conn.execute(
        `insert into wallet (id, player_id, currency, balance_amount, version, created_at, updated_at)
         values (gen_random_uuid(), 'p-1', 'BRL', -1.00, 1, now(), now())`,
      ),
    ).rejects.toThrow('ck_wallet_balance_non_negative');

    const reversalIndex = (
      await conn.execute(
        `select indexname from pg_indexes
          where schemaname = 'public' and indexname = 'uq_wager_single_reversal'`,
      )
    ).map((row: { indexname: string }) => row.indexname);
    expect(reversalIndex).toEqual(['uq_wager_single_reversal']);

    const walletId = Bun.randomUUIDv7();
    await conn.execute(
      `insert into wallet (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, 'p-reversal', 'BRL', 1000.00, 1, now(), now())`,
      [walletId],
    );
    const insertWager = (
      id: string,
      externalTransactionId: string,
      kind: string,
      status: string,
      referenceTransactionId: string | null,
    ): Promise<unknown> =>
      conn.execute(
        `insert into wager_transaction (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, status, money_amount, money_currency, reference_transaction_id, created_at)
         values (?, 'prov', ?, ?, 'h', ?, 'p-reversal', 'round-1', 'game-1', ?, ?, 100.00, 'BRL', ?, now())`,
        [
          id,
          externalTransactionId,
          externalTransactionId,
          walletId,
          kind,
          status,
          referenceTransactionId,
        ],
      );

    const betId = Bun.randomUUIDv7();
    await insertWager(betId, 'bet-1', 'BET', 'PROCESSED', null);
    await insertWager(
      Bun.randomUUIDv7(),
      'refund-1',
      'REFUND',
      'PROCESSED',
      betId,
    );
    await insertWager(
      Bun.randomUUIDv7(),
      'rb-1',
      'ROLLBACK',
      'PROCESSED',
      betId,
    );
    await insertWager(
      Bun.randomUUIDv7(),
      'refund-rej',
      'REFUND',
      'REJECTED',
      betId,
    );

    await expect(
      insertWager(Bun.randomUUIDv7(), 'refund-2', 'REFUND', 'PROCESSED', betId),
    ).rejects.toThrow('uq_wager_single_reversal');

    await orm.migrator.down({ to: 0 });

    const remaining = (
      await conn.execute(
        `select table_name from information_schema.tables where table_schema = 'public'`,
      )
    ).map((row: { table_name: string }) => row.table_name);
    for (const table of APP_TABLES) {
      expect(remaining).not.toContain(table);
    }
  }, 60_000);
});
