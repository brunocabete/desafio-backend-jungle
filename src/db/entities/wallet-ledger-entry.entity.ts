import { defineEntity, p } from '@mikro-orm/postgresql';

export const WalletLedgerEntryEntity = defineEntity({
  name: 'WalletLedgerEntry',
  tableName: 'wallet_ledger_entry',
  uniques: [{ name: 'uq_ledger_transaction', properties: ['transactionId'] }],
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.string().columnType('varchar(8)'),
    currency: p.string().columnType('varchar(3)'),
    moneyAmount: p.string().columnType('numeric(20,2)'),
    balanceBeforeAmount: p.string().columnType('numeric(20,2)'),
    balanceAfterAmount: p.string().columnType('numeric(20,2)'),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});
