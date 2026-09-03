import { Migration } from '@mikro-orm/migrations';

export class Migration20260903175736_init extends Migration {

  override name = 'Migration20260903175736_init';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_message" ("consumer_name" varchar(255) not null, "message_id" varchar(255) not null, "payload_hash" varchar(64) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("consumer_name", "message_id"));`);

    this.addSql(`create table "outbox_message" ("id" uuid not null, "aggregate_id" varchar(64) not null, "event_type" varchar(64) not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);

    this.addSql(`create table "wallet" ("id" uuid not null, "player_id" varchar(64) not null, "currency" varchar(3) not null, "balance_amount" numeric(20,2) not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallet" add constraint "uq_wallet_player_currency" unique ("player_id", "currency");`);

    this.addSql(`create table "wager_transaction" ("id" uuid not null, "provider_id" varchar(64) not null, "external_transaction_id" varchar(128) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" varchar(64) not null, "round_id" varchar(128) not null, "game_id" varchar(128) not null, "kind" varchar(16) not null, "status" varchar(24) not null, "money_amount" numeric(20,2) not null, "money_currency" varchar(3) not null, "reference_external_transaction_id" varchar(128) null, "reference_transaction_id" uuid null, "failure_code" varchar(64) null, "created_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "wager_transaction" add constraint "uq_wager_provider_external" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transaction" add constraint "uq_wager_provider_idempotency" unique ("provider_id", "idempotency_key");`);

    this.addSql(`create table "wallet_ledger_entry" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(8) not null, "currency" varchar(3) not null, "money_amount" numeric(20,2) not null, "balance_before_amount" numeric(20,2) not null, "balance_after_amount" numeric(20,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallet_ledger_entry" add constraint "uq_ledger_transaction" unique ("transaction_id");`);

    this.addSql(`alter table "wallet" add constraint "ck_wallet_balance_non_negative" check ("balance_amount" >= 0);`);

    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_wallet_id_foreign" foreign key ("wallet_id") references "wallet" ("id") on delete no action;`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transaction" ("id") on delete no action;`);

    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_wallet_id_foreign" foreign key ("wallet_id") references "wallet" ("id") on delete no action;`);
    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_transaction_id_foreign" foreign key ("transaction_id") references "wager_transaction" ("id") on delete no action;`);
    this.addSql(`alter table "wallet_ledger_entry" add constraint "ck_ledger_balance_math" check (("direction" = 'DEBIT' AND "balance_after_amount" = "balance_before_amount" - "money_amount") OR ("direction" = 'CREDIT' AND "balance_after_amount" = "balance_before_amount" + "money_amount"));`);

    this.addSql(`create function trg_wallet_ledger_entry_immutable() returns trigger as $$ begin raise exception 'wallet_ledger_entry is immutable'; end; $$ language plpgsql;`);
    this.addSql(`create trigger trg_wallet_ledger_entry_no_update before update or delete on "wallet_ledger_entry" for each row execute function trg_wallet_ledger_entry_immutable();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger if exists trg_wallet_ledger_entry_no_update on "wallet_ledger_entry";`);
    this.addSql(`drop function if exists trg_wallet_ledger_entry_immutable();`);
    this.addSql(`alter table "wager_transaction" drop constraint "wager_transaction_wallet_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entry" drop constraint "wallet_ledger_entry_wallet_id_foreign";`);
    this.addSql(`alter table "wager_transaction" drop constraint "wager_transaction_reference_transaction_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entry" drop constraint "wallet_ledger_entry_transaction_id_foreign";`);

    this.addSql(`drop table if exists "inbox_message" cascade;`);
    this.addSql(`drop table if exists "outbox_message" cascade;`);
    this.addSql(`drop table if exists "wallet" cascade;`);
    this.addSql(`drop table if exists "wager_transaction" cascade;`);
    this.addSql(`drop table if exists "wallet_ledger_entry" cascade;`);
  }

}
