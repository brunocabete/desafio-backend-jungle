import { Migration } from '@mikro-orm/migrations';

export class Migration20260903201222_add_pending_reference_retry extends Migration {
  override name = 'Migration20260903201222_add_pending_reference_retry';

  override up(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transaction" add "attempt_count" int not null default 0, add "next_attempt_at" timestamptz null;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transaction" drop column "attempt_count", drop column "next_attempt_at";`,
    );
  }
}
