import 'reflect-metadata';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletEntity } from './db/entities/wallet.entity.js';
import { WagerTransactionEntity } from './db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from './db/entities/wallet-ledger-entry.entity.js';
import { InboxMessageEntity } from './db/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from './db/entities/outbox-message.entity.js';

const env = (name: string, fallback: string): string =>
  process.env[name] ?? fallback;

export default defineConfig({
  host: env('DATABASE_HOST', 'localhost'),
  port: Number(env('DATABASE_PORT', '5432')),
  dbName: env('POSTGRES_DB', 'myapp'),
  user: env('POSTGRES_USER', 'myapp'),
  password: env('POSTGRES_PASSWORD', 'secret'),
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  migrations: {
    path: 'dist/migrations',
    pathTs: 'src/migrations',
  },
});
