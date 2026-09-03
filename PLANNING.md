# PLANNING.md — Jungle Gaming Distributed Wagering Processor

Development roadmap. Authoritative requirements: `SPECS.MD`. Each step is meant to be a reviewable milestone; write tests alongside each.

## Phase 0 — Foundation (scaffold cleanup)

1. Remove the stock NestJS scaffold noise: drop `AppController`/`AppService`/`Hello World` and the `@nestjs/observe` placeholder wiring (or replace with your own health/metrics plan, spec §12).
2. Configure NestJS `main.ts`: global `ValidationPipe`, request `correlationId` propagation, structured JSON logging.
3. Add `.env.example` documenting the env vars already required by `.env` (gitignored).
4. Update `docker/ministack/init/01-create-queues.sh` to create FIFO queues `wager-transactions.fifo` + `wager-transactions-dlq.fifo` (spec §10) and set redrive policy (DLQ); recreate containers to verify.
5. Verify the full command surface works: `bun run start:dev`, `test`, `test:e2e`, `lint`, `format`.

## Phase 1 — Money and domain model (pure TS, no infra)

1. Add a decimal-arithmetic dependency (e.g. `decimal.js` — must never use `number` for money).
2. Implement `Money` per spec §6.1: immutable, decimal-string boundary with 2-decimal scale, currency checks, rejection of invalid inputs (NaN/Infinity/scientific/empty/extra precision). Multi-currency model but default everything to `BRL`.
3. Implement domain skeletons per §6.3–6.5 with **private constructors + static factories** (`create`, `from`, `rehydrate` — rehydrate never re-validates transitions):
   - `Wallet` (aggregate root; `balance`, `version` starts at 1, increments only on balance change)
   - `WagerTransaction` + `WagerTransactionKind`/`Status` enums + explicit terminal-state transitions
   - `WalletLedgerEntry` (structurally immutable; `create` validates `balanceBefore ± money === balanceAfter`)
   - `InboxMessage`, `OutboxMessage` (retry/backoff state machine)
   - `IntegrationEvent<T>` abstract envelope + concrete subclasses (`WalletBalanceChanged`, etc., spec §11)
   - `FailureCode` taxonomy (documented, machine-readable)
4. Write exhaustive unit tests for Money, Wallet invariants, BET/WIN/LOSS/REFUND/ROLLBACK rules, currency conflicts, diverging idempotency payloads, and status transition guards.
5. Produce `ARCHITECTURE.md` early (decision log is a scoring requirement §14) and keep it updated as you go.

## Phase 2 — DB schema, migrations, ORM

1. Add a MikroORM config (`mikro-orm.config.ts`) so `bun run migration:create|up|down` works; wire the driver to the Postgres env vars.
2. Design entities: `wallet`, `wager_transaction`, `wallet_ledger_entry`, `inbox_message`, `outbox_message`. Money stored exactly (separate exact amount + currency columns, rehydrated as `Money`).
3. Enforce invariants **in schema** (spec §5.9, §6), via unique indexes / constraints / FK:
   - unique `wager_transaction (provider_id, external_transaction_id)`
   - unique idempotency key per provider
   - unique `wallet (player_id, currency)`
   - **non-negative balance** CHECK constraint on wallet
   - ledger immutable: no UPDATE/DELETE grants (or app-level guards) + CHECK `balance_after - balance_before` consistent with direction/amount
   - unique processed-marker for inbox `(consumer_name, message_id)`
4. Register entities in a Nest module (`MikroOrmModule.forRoot(...)`), map Money columns via a custom type/codec.
5. Versioned reversible migrations + integration test that migrations apply cleanly on a fresh Postgres container.

## Phase 3 — Application services & HTTP API

1. Wallet use case: `POST /wallets` (create wallet; `OPENING` internal transaction + `CREDIT` ledger entry in the **same SQL transaction**; duplicate playerId+currency → conflict).
2. Wager transaction use case (shared by HTTP and SQS — one code path, spec §10):
   - validate payload; compute canonical `payloadHash`; enforce idempotency-key semantics (identical → replay with original result incl. balance; same key + different payload → conflict)
   - apply §7 rules; resolve references by `(providerId, referenceExternalTransactionId)` same provider/player/wallet/currency/round
   - reference missing → `PENDING_REFERENCE`, requeue/scheduled worker with exponential backoff + TTL (spec §7.1)
   - `REFUND`/`ROLLBACK` single-reversal guard; explicit distinct `failureCode` when a reversal would go negative (§7.9)
3. Read endpoints: `GET /wallets/:walletId`, ledger with stable opaque cursor pagination, transaction lookups by internal id and by provider ref.
4. Reconciliation endpoint `POST /wallets/:walletId/reconciliation` (compare stored vs ledger-reconstructed balance; log + metric on divergence, never silently fix).
5. Health checks `GET /health/live` + `GET /health/ready` (Postgres + SQS reachable), open (no auth).
6. Decide status-code mapping and keep it consistent across endpoints (invalid payload / idempotency conflict / business rejection / pending acceptance / transient infra).
7. Optional: external IdP (Keycloak/Zitadel) for API auth, or a documented no-op `AuthGuard` extension point (spec §2).

## Phase 4 — SQS consumer + transactionality

1. Transactional outbox: outbox row + inbox row + wallet change + ledger row committed **atomically in one SQL transaction** (§11). Never publish before commit.
2. SQS consumer on `wager-transactions.fifo`, reusing the exact use case from Phase 3.
3. Persistent inbox dedup by `(consumerName, messageId)`; `ack` only after commit; classify failures:
   - business/terminal → ack
   - transient → retry with backoff (visibility timeout)
   - permanent → DLQ after max attempts (redrive policy)
4. Graceful `SIGTERM`: finish in-flight messages or return visibility; support redelivery with no duplicated effects.
5. Outbox publisher worker: safe under concurrent publishers (claim rows atomically, backoff, no loss/dup drift); publish idempotently safe for consumers.

## Phase 5 — Concurrency hardening

1. Pick and justify a wallet-locking strategy (spec §8): pessimistic `FOR UPDATE` per wallet, or conditional atomic update with limited optimistic retries. Document in `ARCHITECTURE.md`.
2. Guarantee no lost updates, no duplicate debits/credits, no negative balance under race; broker ordering/dedup is only an optimization — DB is the source of truth.
3. Verify the mandatory scenario: wallet `100.00 BRL`, two concurrent `80.00` bets → one `PROCESSED`, one `REJECTED` (insufficient funds), balance `20.00`, exactly one debit entry, no retry duplication (§8).

## Phase 6 — Observability (§12)

1. Structured JSON logs with `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; no sensitive/full financial payloads.
2. Metrics: transactions by status, duplicates detected, retries, DLQ count, lock conflicts, outbox lag, processing latency.
3. Wire health/ready checks (already in Phase 3) into a readiness probe.

## Phase 7 — Test matrix (spec §13, highest score weight on real concurrency)

1. Unit: already covered in Phase 1.
2. Integration (real Postgres + MiniStack in containers): migrations/constraints, wallet+ledger+inbox+outbox atomicity, inbox/redelivery, concurrent outbox publishers, retry + DLQ, crash recovery.
3. Concurrency/race tests with real parallelism:
   - same wager submitted 50× in parallel → single debit
   - concurrent balance contention (spec §8 scenario)
   - distinct wallets in parallel
   - ≥3 simultaneous processes/instances
   - worker killed after commit, before ack
   - two outbox publishers
   - ROLLBACK/REFUND arriving before the reference
   - service restart with final consistency proven (`balance == ledger reconstruction`)
4. Optional load test exposed as `bun run test:load` with honest methodology + p50/p95/p99 + error rate + lock conflicts + outbox lag.

## Phase 8 — Documentation & final pass

1. Rewrite `README.md` with real setup/commands (today it's NestJS boilerplate).
2. Finalize `ARCHITECTURE.md`: domain/port boundaries, transaction + locking strategy, outbox/inbox design, SQS contract, failure-code taxonomy, trade-offs and known limitations (incl. auth decision, §2).
3. Full `lint` + `format` + `test` + `test:e2e` green; check off §14 scoring table and eliminate every "eliminatory failure" (§14).

## Suggested execution order & dependencies

- Phases are sequential (0 → 1 → 2 ...) except Phase 6 (observability) can start early.
- `ARCHITECTURE.md` is a living doc: start in Phase 1, finalize in Phase 8.
- Keep the "same use case for HTTP and SQS" property (Phase 3/4) from day one — retrofitting it later is costly.
