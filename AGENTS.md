# AGENTS.md

## Project status — read this first

This is the **Jungle Gaming "distributed wagering processor" challenge**. The real spec is `SPECS.MD` (pt-BR, authoritative). The current `src/` is still the **stock NestJS scaffold** (`AppController`/`AppService` + `/` returning "Hello World!") — almost nothing from the spec is implemented yet. Don't assume endpoints, domain classes, MikroORM config, migrations, `ARCHITECTURE.md`, or the outbox/inbox exist; check before relying on them.

`README.md` is untouched NestJS boilerplate and does **not** describe the actual project or its real setup/commands. Trust `package.json` + `SPECS.MD`, not the README.

## Commands (Bun, never npm)

- Install: `bun install`
- Dev server (watch): `bun run start:dev`  (prod build: `bun run build`, then `node dist/main`)
- Unit tests: `bun run test` → `vitest run`, matches `**/*.spec.ts`
- E2E tests: `bun run test:e2e` → vitest with `vitest.config.e2e.ts`, matches `**/*.e2e-spec.ts` (test files live in `test/`)
- Single file: `bunx vitest run src/path/file.spec.ts`; for e2e add `--config vitest.config.e2e.ts`
- Lint: `bun run lint` = `oxlint src/ test/` (not eslint)
- Format: `bun run format` = prettier (single quotes, trailing commas)
- Migrations: `bun run migration:create|up|down` → `mikro-orm ...` — **will fail until a MikroORM config file exists; none has been created yet.**

## Toolchain quirks

- Pure ESM (`"type": "module"`, `module: nodenext`): **relative imports must use the `.js` extension** (e.g. `import { AppModule } from './app.module.js'`) even though files are `.ts`. Existing scaffold code already follows this.
- Vitest globals enabled (`types: ["vitest/globals", "node"]`): `describe`/`it`/`expect` are global; tests don't import them.
- Test runner is Vitest **only** (no Jest config exists — don't add jest).
- `tsconfig.build.tsbuildinfo` is committed (incremental build artifact); leave it alone.

## Local infra (Docker Compose)

- `bun run` needs `.env` at repo root (present locally, **gitignored**, not committed). It holds Postgres + AWS/Ministack credentials and `AWS_SQS_QUEUE`.
- Services: `postgres` (postgres:18-alpine, healthchecked) and `ministack` (SQS emulator on `:4566`, healthchecked).
- SQS queues are created once at ministack container startup by `docker/ministack/init/01-create-queues.sh`. **Current script creates non-FIFO queues named `app-events` / `app-events-dlq`, which contradicts the spec's `wager-transactions.fifo` / `wager-transactions-dlq.fifo` (§10).** If you implement to spec, update the init script (queue changes need a container recreate to take effect).
- Compose defaults (`app`/`app`) are overridden by the local `.env` (`myapp`/`secret`); these env vars are read by compose via `${VAR:-default}`.

## Architecture constraints (from SPECS.MD — inviolable, §5)

- **Never use `number`/`float`/`double` for money.** `Money` is immutable, decimal-string at the boundary, 2-decimal scale.
- Invariants (uniqueness of idempotency key, wallet per playerId+currency, ledger immutability, non-negative balance, exact-once apply) must be enforced **in the DB schema** (constraints/indexes), not only in app code.
- Inbox + wallet change + ledger + outbox must commit in **one SQL transaction**; never publish events before commit.
- Concurrency unit is the **wallet**; must stay correct with 3+ app instances and out-of-order / duplicated messages. No in-memory idempotency, no shared global wallet lock, no naive read→calculate→update balance.
- No user table / hand-rolled auth (spec §2); health endpoints stay open.
- Read §6 (domain model), §7 (BET/WIN/LOSS/REFUND/ROLLBACK rules + failure codes), §10 (SQS consumer contract) before writing code. `ARCHITECTURE.md` documenting decisions is a scoring requirement.

## Layout conventions

- Domain is expected in `src/` following the spec's classes (`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, `IntegrationEvent`) with private constructors + static factories (`create`/`from`/`rehydrate`); `rehydrate` must not re-validate transitions.
- ORM is MikroORM (spec-preferred); migration files are versioned and reversible.
