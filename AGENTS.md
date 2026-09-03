# AGENTS.md

## Project status — read this first

This is the **Jungle Gaming "distributed wagering processor" challenge**. The real spec is `SPECS.MD` (pt-BR, authoritative). Status evolves fast — trust the **Progress table in `PLANNING.md`** and the running decision log in `ARCHITECTURE_SUGGESTIONS.md`, and check before assuming anything exists. Currently implemented: pure-TS domain (Phase 1), DB schema + reversible migrations + integration test (Phase 2), MikroORM Nest wiring and `POST /wallets` (Phase 3, in progress). `ARCHITECTURE.md` and the outbox/inbox consumer do **not** exist yet.

`README.md` is untouched NestJS boilerplate and does **not** describe the actual project or its real setup/commands. Trust `package.json` + `SPECS.MD`, not the README.

## Commands (Bun, never npm)

- Install: `bun install`
- Dev server (watch): `bun run start:dev`  (prod: `bun run build`, then `bun dist/main` — **runtime é o Bun**; SPEC §4 manda "Runtime / package manager / test runner: Bun 1.x")
- Unit tests: `bun run test` → **`bun test ./src`** (test runner nativo do Bun, SPEC §4), matches `**/*.spec.ts`
- E2E tests: `bun run test:e2e` → **`bun test ./test`**, matches `**/*.e2e.test.ts` (test files live in `test/`)
- Single file: `bun test ./src/path/file.spec.ts`; for e2e `bun test ./test/file.e2e.test.ts`
- Lint: `bun run lint` = `oxlint src/ test/` (not eslint)
- Format: `bun run format` = prettier (single quotes, trailing commas)
- Migrations: `bun run migration:create|up|down` → `mikro-orm ...` using `src/mikro-orm.config.ts` (TS via `tsx`; requires Postgres de pé — ver infra abaixo).

## Toolchain quirks

- Pure ESM (`"type": "module"`, `module: nodenext`): **relative imports must use the `.js` extension** (e.g. `import { AppModule } from './app.module.js'`) even though files are `.ts`. Existing scaffold code already follows this.
- **Runtime é Bun em todo lugar** (dev, prod `bun dist/main` e testes `bun test`). APIs exclusivas do Bun (`Bun.randomUUIDv7()`) são usadas diretamente no código — tipos via `@types/bun` (tsconfig `types: ["bun", "node"]`).
- **Test runner é o `bun test`** (SPEC §4 manda "test runner: Bun"). Globals `describe`/`it`/`expect`/`before*`/`after*` existem sem import (tipados por `src/bun-test-globals.d.ts`). Se um arquivo **importar** algo de `bun:test` (ex.: `spyOn`), os globals desse arquivo deixam de existir — importe também o que usar. Nada de vitest/jest.
- `*.tsbuildinfo` (incl. `tsconfig.build.tsbuildinfo`) is a **generated incremental-build cache** and is **gitignored** — it is recreated by `nest build`/`tsc`; never commit it and don't rely on it.
- `*.tsbuildinfo` (incl. `tsconfig.build.tsbuildinfo`) is a **generated incremental-build cache** and is **gitignored** — it is recreated by `nest build`/`tsc`; never commit it and don't rely on it.

## Local infra (Docker Compose)

- `bun run` needs `.env` at repo root (present locally, **gitignored**, not committed). It holds Postgres + AWS/Ministack credentials and `AWS_SQS_QUEUE`.
- Services: `postgres` (postgres:18-alpine, healthchecked) and `ministack` (SQS emulator on `:4566`, healthchecked).
- SQS queues (`wager-transactions.fifo` + `wager-transactions-dlq.fifo`, spec §10) are created once at ministack startup by `docker/ministack/init/01-create-queues.sh`, with a redrive policy (maxReceiveCount 5) on the main queue. **Queue changes require a ministack recreate**: `docker compose up -d --force-recreate ministack`. The compose `ministack` service injects `AWS_ENDPOINT_URL`/creds so init scripts can call the emulator.
- The ministack image ships an old **aws-cli v1** that ignores the `AWS_ENDPOINT_URL` env var — the init script must pass `--endpoint-url` explicitly (it does). Hand-verifying queues: `docker compose exec ministack aws --endpoint-url=http://localhost:4566 sqs list-queues` (creds are baked into the service env).
- Compose defaults (`app`/`app`) are overridden by the local `.env` (`myapp`/`secret`); these env vars are read by compose via `${VAR:-default}`.

## Architecture constraints (from SPECS.MD — inviolable, §5)

- **Never use `number`/`float`/`double` for money** (spec §5 item 1). `Money` is immutable, decimal-string at the boundary, 2-decimal scale (§6.1).
- Invariants (uniqueness of idempotency key, wallet per playerId+currency, ledger immutability, non-negative balance, exact-once apply) must be enforced **in the DB schema** (constraints/indexes), not only in app code.
- Inbox + wallet change + ledger + outbox must commit in **one SQL transaction**; never publish events before commit.
- Concurrency unit is the **wallet**; must stay correct with 3+ app instances and out-of-order / duplicated messages. No in-memory idempotency, no shared global wallet lock, no naive read→calculate→update balance.
- No user table / hand-rolled auth (spec §2); health endpoints stay open.
- Read §6 (domain model), §7 (BET/WIN/LOSS/REFUND/ROLLBACK rules + failure codes), §10 (SQS consumer contract) before writing code. `ARCHITECTURE.md` documenting decisions is a scoring requirement.

## Layout conventions

- Domain is expected in `src/` following the spec's classes (`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, `IntegrationEvent`) with private constructors + static factories (`create`/`from`/`rehydrate`); `rehydrate` must not re-validate transitions.
- ORM is MikroORM (spec-preferred); migration files are versioned and reversible.
