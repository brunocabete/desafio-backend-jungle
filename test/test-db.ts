import { MikroORM } from '@mikro-orm/core';
import { type Options } from '@mikro-orm/postgresql';
import { resolve } from 'node:path';
import config from '../src/mikro-orm.config.js';

const MIGRATIONS_PATH = resolve('src/migrations');

export function ormOptionsFor(dbName: string): Options {
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

export async function dropDatabaseIfExists(dbName: string): Promise<void> {
  const admin = await MikroORM.init(ormOptionsFor('postgres'));
  try {
    await admin.em
      .getConnection()
      .execute(`drop database if exists "${dbName}" with (force)`);
  } finally {
    await admin.close(true);
  }
}
