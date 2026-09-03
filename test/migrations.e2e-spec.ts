import { MikroORM } from '@mikro-orm/core';
import { resolve } from 'node:path';
import config from '../src/mikro-orm.config.js';

const ADMIN_DB = 'postgres';
const TEST_DB = `desafio_jungle_mig_test_${process.pid}`;

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

async function dropDatabaseIfExists(): Promise<void> {
  const admin = await MikroORM.init(optionsFor(ADMIN_DB));
  try {
    await admin.em.getConnection().execute(
      `drop database if exists "${TEST_DB}" with (force)`,
    );
  } finally {
    await admin.close(true);
  }
}

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
    await dropDatabaseIfExists();
    orm = await MikroORM.init(optionsFor(TEST_DB));
  }, 60_000);

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
    await dropDatabaseIfExists();
  }, 60_000);

  it('applies up, creates tables + constraints, enforces them, and is reversible', async () => {
    const executed = await orm.migrator.up();
    expect(executed.map((m) => m.name)).toEqual([
      expect.stringContaining('_init'),
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

    await orm.migrator.down();

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
