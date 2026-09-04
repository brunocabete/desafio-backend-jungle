import { Migration } from '@mikro-orm/migrations';

export class Migration20260904194138_add_single_reversal_unique extends Migration {
  override name = 'Migration20260904194138_add_single_reversal_unique';

  override up(): void | Promise<void> {
    this.addSql(
      `create unique index "uq_wager_single_reversal" on "wager_transaction" ("reference_transaction_id", "kind") where "status" = 'PROCESSED' and "kind" in ('REFUND', 'ROLLBACK');`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "uq_wager_single_reversal";`);
  }
}
