import { defineEntity, p } from '@mikro-orm/postgresql';

export const WalletEntity = defineEntity({
  name: 'Wallet',
  tableName: 'wallet',
  uniques: [{ name: 'uq_wallet_player_currency', properties: ['playerId', 'currency'] }],
  properties: {
    id: p.uuid().primary(),
    playerId: p.string().columnType('varchar(64)'),
    currency: p.string().columnType('varchar(3)'),
    balanceAmount: p.string().columnType('numeric(20,2)'),
    version: p.integer(),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
  },
});
