import { defineEntity, p } from '@mikro-orm/postgresql';
import { WalletEntity } from './wallet.entity.js';

export const WagerTransactionEntity = defineEntity({
  name: 'WagerTransaction',
  tableName: 'wager_transaction',
  uniques: [
    {
      name: 'uq_wager_provider_external',
      properties: ['providerId', 'externalTransactionId'],
    },
    {
      name: 'uq_wager_provider_idempotency',
      properties: ['providerId', 'idempotencyKey'],
    },
  ],
  properties: {
    id: p.uuid().primary(),
    providerId: p.string().columnType('varchar(64)'),
    externalTransactionId: p.string().columnType('varchar(128)'),
    idempotencyKey: p.string().columnType('varchar(255)'),
    payloadHash: p.string().columnType('varchar(64)'),
    walletId: () =>
      p
        .manyToOne(WalletEntity)
        .mapToPk()
        .fieldName('wallet_id')
        .deleteRule('no action'),
    playerId: p.string().columnType('varchar(64)'),
    roundId: p.string().columnType('varchar(128)'),
    gameId: p.string().columnType('varchar(128)'),
    kind: p.string().columnType('varchar(16)'),
    status: p.string().columnType('varchar(24)'),
    moneyAmount: p.string().columnType('numeric(20,2)'),
    moneyCurrency: p.string().columnType('varchar(3)'),
    referenceExternalTransactionId: p
      .string()
      .columnType('varchar(128)')
      .nullable(),
    referenceTransactionId: () =>
      p
        .manyToOne(WagerTransactionEntity)
        .mapToPk()
        .fieldName('reference_transaction_id')
        .nullable()
        .deleteRule('no action'),
    failureCode: p.string().columnType('varchar(64)').nullable(),
    attemptCount: p.integer().default(0),
    nextAttemptAt: p.datetime().columnType('timestamptz').nullable(),
    createdAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});
