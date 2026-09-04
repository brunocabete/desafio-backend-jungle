# PLANNING.md — Jungle Gaming Distributed Wagering Processor

Development roadmap. Authoritative requirements: `SPECS.MD`. **`ARCHITECTURE_SUGGESTIONS.md` is the running decision log** (started in Phase 1, item 5); the human consolidates the final `ARCHITECTURE.md` in Phase 8.

Every phase is a reviewable milestone: **write tests alongside each change**, keep `lint` + `typecheck` green, and prefer the simplest code that satisfies `SPECS.MD` — no extra tables, abstractions, indexes or triggers beyond what a phase needs.

## Progress

| Phase | Status |
|---|---|
| 0 — Foundation | ✅ done |
| 1 — Money and domain model | ✅ done (145 unit tests) |
| 2 — DB schema, migrations, ORM | ✅ itens 1–3 e 5 done (migration inicial + teste de integração em DB limpo); item 4 adiado (forRoot na Fase 3) |
| 3 — Application services & HTTP API | 🚧 itens 1–5 ✅ (`POST /wallets`; `POST /wagering/transactions`; worker `PENDING_REFERENCE`/TTL; GETs + ledger com cursor; reconciliation); 6 ✅ (health `/live` + `/ready` PG+SQS); 7 ✅ (mapeamento de status centralizado + falha transitória → 503). Resta: 8 (auth — será a **última** etapa do projeto) |
| 4 — SQS consumer + transactionality | ✅ itens 1–5 (1: transactional outbox na mesma SQL transaction — §21; 2+3: consumer SQS com inbox persistente atômico + classificação/ack/DLQ — §22; 4: SIGTERM graceful — §23; 5: outbox publisher com claim atômico via compare-and-set, lease 30s, backoff exponencial 200ms→30s, seguro com publishers concorrentes — §24). |
| 5 — Concurrency hardening | ✅ locking final = pessimista `FOR UPDATE` por wallet (único mecanismo; rede de segurança dos uniques no schema; broker = otimização, DB = fonte da verdade — §25 do decision log). Cenário obrigatório §8 + corridas verificadas por e2e real em `test/concurrency.e2e.test.ts`. |
| 6 — Observability | ✅ logs JSON com campos §12 (JsonLogger aceita objeto; 1 log/liquidação; consumer usa messageId como correlação), métricas Prometheus text em `GET /metrics` (transações por status, duplicatas, retries, DLQ, lock conflicts, outbox lag, latência — ver §26); readiness via `/health/ready` (endpoint + e2e; sem serviço app no compose). |
| 7 — Test matrix | 🚧 **passo 0 (schema): índice parcial único de single-reversal** (adiado das Fases 2–4) antes da matriz de reversões. Itens restantes do §13 listados na seção abaixo. |
| 8 — Documentation & final pass | pending |

---

## Phase 0 — Foundation (scaffold cleanup) ✅

1. Remove stock NestJS scaffold noise (`AppController`/`AppService`/`Hello World`, `@nestjs/observe` placeholders).
2. Configure `main.ts`: `correlationId` propagation + structured JSON logging (`JsonLogger`). (Global `ValidationPipe` arrives with the first HTTP endpoints, Phase 3.)
3. Add `.env.example` documenting env vars required by `.env` (gitignored).
4. Create FIFO queues `wager-transactions.fifo` + `wager-transactions-dlq.fifo` (spec §10) with redrive policy in `docker/ministack/init/01-create-queues.sh`; verify via compose.
5. Verify the command surface: `bun run start:dev`, `test`, `test:e2e`, `lint`, `format`.

## Phase 1 — Money and domain model (pure TS, no infra) ✅

1. Add `decimal.js` (never `number`/`float` for money — spec §5.1).
2. Implement `Money` per spec §6.1 (immutable, decimal-string boundary, 2-decimal scale, multi-currency with default `BRL`, invalid-input rejection). Kept lean: no redundant re-scaling in arithmetic — scale is guaranteed at the boundary and serialization.
3. Implement domain skeletons per §6.2–6.5 with **private constructors + static factories** (`create`/`from`/`rehydrate`; `rehydrate` never re-validates transitions):
   - `Wallet` (aggregate root; `version` starts at 1, increments only on balance change);
   - `WagerTransaction` + kind/status enums + explicit terminal-state transitions (`ALLOWED_TRANSITIONS`);
   - `WalletLedgerEntry` (structurally immutable; `create` validates `balanceBefore ± money === balanceAfter`);
   - `InboxMessage`, `OutboxMessage` (retry/backoff state machine; backoff `200ms·2^(n-1)`, cap `30s`);
   - `IntegrationEvent<T>` abstract envelope + concrete subclasses (spec §11);
   - `FailureCode` taxonomy (documented, machine-readable) + canonical `payloadHash` (spec §9).
4. Unit tests: Money, Wallet invariants, BET/WIN/LOSS/REFUND/ROLLBACK, currency conflicts, diverging idempotency payloads, status transition guards.
5. Produce **`ARCHITECTURE_SUGGESTIONS.md`** as the ongoing decision log.

## Phase 2 — DB schema, migrations, ORM

Goal: make the invariants from spec §6 real in PostgreSQL (spec §5 item 9), with **no Nest wiring yet** — the app has no DB consumer until Phase 3. Avoid: custom two-column MikroORM types, extra mapping layers, speculative indexes/triggers, `@Version` double-counting.

1. **✅ MikroORM config + CLI** — `src/mikro-orm.config.ts` (`defineConfig` from `@mikro-orm/postgresql`), driver wired to `DATABASE_HOST/PORT` + `POSTGRES_DB/USER/PASSWORD`; `mikro-orm.configPaths` in `package.json`; deps `@mikro-orm/cli` + `tsx` (TS loader for the CLI). Migrations: TS in `src/migrations` (dev), JS in `dist/migrations` (prod). Verify: `bun run mikro-orm debug` finds the config; connection to local Postgres succeeds.
2. **✅ Entities** — ORM schemas (`defineEntity`, v7 sem decorators) para `wallet`, `wager_transaction`, `wallet_ledger_entry`, `inbox_message`, `outbox_message`. Money = **exact columns** (`amount numeric(20,2)` mapeado como string + `currency varchar(3)`), read back as string and rehydrated via `Money.from` — no custom ORM type. `wallet.version` is a **plain column** (domain increments it; do NOT add `@Version` on top). `inbox_message` usa PK composta `(consumer_name, message_id)`.
3. **✅ Enforce invariants in schema** (spec §5 item 9, §6) — only what SPEC needs, na migration `..._init`:
   - `wallet`: PK; **unique `(player_id, currency)`**; **CHECK `balance_amount >= 0`**;
   - `wager_transaction`: unique `(provider_id, external_transaction_id)` e `(provider_id, idempotency_key)`; FK `wallet_id → wallet`; FK `reference_transaction_id → wager_transaction` (auto-ref);
   - `wallet_ledger_entry`: FK `wallet_id` e `transaction_id`; **CHECK `balance_after = balance_before ± amount`** por direção; **imutabilidade** via trigger `BEFORE UPDATE OR DELETE`; unique `transaction_id` (≤ 1 lançamento/transação);
   - `inbox_message`: PK composta `(consumer_name, message_id)` (dedup persistente, §10).
   - Adiado até ter lógica consumidora: índices parciais de single-reversal (spec §7 regras 3–4) e colunas de lock.
4. **No `MikroOrmModule.forRoot` yet.** Validate the schema via a MikroORM-only integration test against a real Postgres container (dedicated test DB). Wire the Nest module (`forRoot` with the same config) at the start of Phase 3, when the first repository/use case needs the `EntityManager` — from that point app boot depends on Postgres.
5. **✅ Versioned reversible migrations** (`migration:create|up|down`, `emit: 'ts'`, snapshot) — migration inicial `..._init` **criada e aplicada** no Postgres local (tabelas/constraints/trigger verificados). **Teste de integração** `test/migrations.e2e.test.ts` (MikroORM puro, DB dedicado `desafio_jungle_mig_test_*`): cria DB fresco, `up()`, valida tabelas + constraints + trigger + rejeição de CHECK, e prova reversibilidade com `down()` (spec §13, sem mocks).

## Phase 3 — Application services & HTTP API

1. **✅ Register `MikroOrmModule.forRoot(shared config)`** (Phase 2 config) + request-context middleware when repositories appear; app boot now requires Postgres. (v7: `@mikro-orm/nestjs` regista o `RequestContext` automaticamente via `configure()`, salvo `registerRequestContext: false`.)
2. **✅ Wallet use case: `POST /wallets`** (create wallet; `OPENING` internal transaction + `CREDIT` ledger entry in the **same SQL transaction**; duplicate playerId+currency → conflict). Apply `DEFAULT_CURRENCY = BRL` at this boundary.
   - **OPENING is an internal channel (§6.3)** and must NOT go through the shared submit use case: `applyWagerTransaction` rejects OPENING on purpose. Wallet creation gets its own path that persists the internal OPENING transaction + CREDIT ledger entry atomically.
3. Wager transaction use case (**shared by HTTP and SQS — one code path**, spec §10). Subdividido para milestone reviewable:
   3.1 **✅ `POST /wagering/transactions` + use case compartilhado** (`src/wagering/`, `WagerTransactionService.submit` — o consumer SQS da Fase 4 reutiliza o mesmo serviço):
      - validate payload; compute canonical `payloadHash`; idempotency-key semantics (identical → replay com resultado original incl. saldo; mesma key + payload diferente → conflito 409; races → unique constraint vira replay/conflict via reload);
      - apply §7 rules via `applyWagerTransaction`; resolve referências por `(providerId, referenceExternalTransactionId)`; guard single-reversal (query) e `failureCode` distinto p/ overdraw;
      - referência ausente → `PENDING_REFERENCE` persistido (202); quando a referência chega e fica terminal, reprocessa dependentes pendentes na **mesma SQL transaction** (fila em memória sob o lock da wallet);
      - concorrência mínima por wallet: `FOR UPDATE` na wallet + uniques `(provider, idempotency_key)`/`(provider, external_transaction_id)` como rede de segurança;
      - HTTP mapping: 400 `INVALID_PAYLOAD`, 404 `WALLET_NOT_FOUND`, 409 `IDEMPOTENCY_CONFLICT`, 422 rejeição de negócio (com `failureCode`), 202 `PENDING_REFERENCE`, 200 processado (replay preserva o código original).
   3.2 **✅ Worker de reprocessamento de `PENDING_REFERENCE`** (`PendingReferenceScheduler` polling + `WagerTransactionService.reprocessPendingReferences`): colunas `attempt_count`/`next_attempt_at` (migration `..._add_pending_reference_retry`); backoff exponencial 200ms→30s (`pending-reference-retry.ts`), limite de tentativas e TTL → `REJECTED UNRESOLVED_REFERENCE`; re-tenta também quando a referência já está processada. Evento de rejeição persiste só com a outbox (Fase 4).
4. Read endpoints: `GET /wallets/:walletId`, ledger with stable opaque cursor, transaction lookups by internal id and by provider ref.
5. Reconciliation `POST /wallets/:walletId/reconciliation` (stored vs ledger-reconstructed; log + metric on divergence, never silently fix).
6. Health checks `GET /health/live` + `GET /health/ready` (Postgres + SQS), open (no auth) — readiness probe reused in Phase 6.
7. Consistent status-code mapping across endpoints (invalid payload / idempotency conflict / business rejection / pending acceptance / transient infra).
8. Auth (§2): document the choice in `ARCHITECTURE_SUGGESTIONS.md`; if implementing, use an external IdP or a no-op `AuthGuard` extension point — no hand-rolled auth/user table.

## Phase 4 — SQS consumer + transactionality

1. Transactional outbox: outbox row + inbox row + wallet change + ledger row committed **atomically in one SQL transaction** (§11); never publish before commit.
2. SQS consumer on `wager-transactions.fifo`, reusing the exact Phase 3 use case.
3. Persistent inbox dedup by `(consumerName, messageId)`; `ack` only after commit; failure classification: business/terminal → ack; transient → retry/backoff; permanent → DLQ after max attempts.
4. Graceful `SIGTERM`: finish in-flight messages or return visibility; redelivery must not duplicate effects.
5. Outbox publisher worker: safe under concurrent publishers (atomic claim, backoff, no loss/dup drift); publication idempotent for consumers.

## Phase 5 — Concurrency hardening

1. Implement and justify the wallet-locking strategy (spec §8): pessimistic `FOR UPDATE` per wallet vs conditional atomic update with limited optimistic retries — the domain already exposes `version` for optimistic checks; keep ONE mechanism (no double counting).
2. No lost updates / duplicate debits / negative balance under race; broker ordering/dedup is only an optimization — the DB is the source of truth.
3. Verify the mandatory scenario: wallet `100.00 BRL`, two concurrent `80.00` bets → one `PROCESSED`, one `REJECTED`, final `20.00`, exactly one debit entry, no retry duplication (§8).

## Phase 6 — Observability (§12)

1. Structured JSON logs with `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; no sensitive/full financial payloads.
2. Metrics: transactions by status, duplicates detected, retries, DLQ count, lock conflicts, outbox lag, processing latency.
3. Wire `/health/ready` (Phase 3) into a readiness probe.

## Phase 7 — Test matrix (spec §13; real concurrency carries the most weight)

1. Unit: covered in Phase 1.
2. Integration (real Postgres + MiniStack): migrations/constraints (Phase 2), wallet+ledger+inbox+outbox atomicity, inbox/redelivery, concurrent outbox publishers, retry + DLQ, crash recovery.
3. Concurrency/race tests with real parallelism:
   - same wager submitted 50× in parallel → single debit;
   - concurrent balance contention (spec §8 scenario);
   - distinct wallets in parallel;
   - ≥3 simultaneous processes/instances;
   - worker killed after commit, before ack;
   - two outbox publishers;
   - ROLLBACK/REFUND arriving before the reference;
   - service restart with final consistency proven (`balance == ledger reconstruction`).
4. Optional load test as `bun run test:load` (honest methodology, p50/p95/p99, error rate, lock conflicts, outbox lag).

## Phase 8 — Documentation & final pass

1. Rewrite `README.md` with real setup/commands.
2. Finalize `ARCHITECTURE.md` from `ARCHITECTURE_SUGGESTIONS.md`: boundaries, transaction + locking strategy, outbox/inbox design, SQS contract, failure-code taxonomy, trade-offs and limitations (incl. auth decision §2).
3. Full `lint` + `format` + `test` + `test:e2e` green; walk the §14 scoring table and eliminate every "eliminatory failure".

## Execution order & standing rules

- Phases are sequential (0 → 8); Phase 6 observability can start early, but not before its data sources exist (Phase 3/4).
- Keep the **same use case for HTTP and SQS** from the start — retrofitting is costly.
- Keep the codebase lean: no new dependency, table, index, trigger, repository or module unless a phase needs it; log every conscious decision in `ARCHITECTURE_SUGGESTIONS.md`.
- Re-run lint + typecheck + tests before closing each milestone.
