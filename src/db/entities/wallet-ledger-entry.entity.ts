import { defineEntity, p } from '@mikro-orm/postgresql';
import { WalletEntity } from './wallet.entity.js';
import { WagerTransactionEntity } from './wager-transaction.entity.js';

export const WalletLedgerEntryEntity = defineEntity({
  name: 'WalletLedgerEntry',
  tableName: 'wallet_ledger_entry',
  uniques: [{ name: 'uq_ledger_transaction', properties: ['transactionId'] }],
  checks: [
    {
      name: 'ck_ledger_balance_math',
      expression:
        '("direction" = \'DEBIT\' AND "balance_after_amount" = "balance_before_amount" - "money_amount") OR ' +
        '("direction" = \'CREDIT\' AND "balance_after_amount" = "balance_before_amount" + "money_amount")',
    },
  ],
  properties: {
    id: p.uuid().primary(),
    walletId: () =>
      p
        .manyToOne(WalletEntity)
        .mapToPk()
        .fieldName('wallet_id')
        .deleteRule('no action'),
    transactionId: () =>
      p
        .manyToOne(WagerTransactionEntity)
        .mapToPk()
        .fieldName('transaction_id')
        .deleteRule('no action'),
    direction: p.string().columnType('varchar(8)'),
    currency: p.string().columnType('varchar(3)'),
    moneyAmount: p.string().columnType('numeric(20,2)'),
    balanceBeforeAmount: p.string().columnType('numeric(20,2)'),
    balanceAfterAmount: p.string().columnType('numeric(20,2)'),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});
