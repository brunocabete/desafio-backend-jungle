# Jungle Gaming — Distributed Wagering Processor

Serviço financeiro distribuído (NestJS + Bun + PostgreSQL + SQS) que processa transações de apostas de múltiplos provedores com **correção financeira, concorrência multi-instância, idempotência persistente e consistência entre saldo materializado e ledger**.

> Requisitos autoritativos: [`SPECS.MD`](./SPECS.MD) (pt-BR). Decisões técnicas e o registro contínuo de arquitetura: [`ARCHITECTURE_SUGGESTIONS.md`](./ARCHITECTURE_SUGGESTIONS.md). Visão arquitetural consolidada (em evolução): [`ARCHITECTURE.md`](./ARCHITECTURE.md). Roadmap: [`PLANNING.md`](./PLANNING.md).

## Stack

| Camada | Escolha |
|---|---|
| Runtime / package manager / test runner | **Bun 1.x** |
| Linguagem | TypeScript estrito, ESM puro |
| Framework | NestJS |
| Banco | PostgreSQL 18 (Docker Compose) |
| ORM | MikroORM v7 (`defineEntity`, sem decorators) |
| Mensageria | AWS SQS via **MiniStack** (`:4566`) |
| Migrations | versionadas e reversíveis (TS em `src/migrations`) |
| Dinheiro | `decimal.js` (nunca `number`/`float`) |

## Repositório (mapa rápido)

```
src/
  domain/           Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos, failure codes
  db/entities/      Schema MikroORM (1:1 com as tabelas)
  migrations/       Migrations TS versionadas + reversíveis (e snapshot)
  wallets/          POST/GET /wallets, ledger com cursor, reconciliação
  wagering/         Use case compartilhado submit + PENDING_REFERENCE worker
  sqs/              Consumer SQS (inbox + ack/DLQ)
  outbox/           Publisher transacional da outbox (claim atômico)
  common/           filtro HTTP, correlação, JsonLogger, métricas/Prometheus, decimal config
test/               e2e com Postgres + MiniStack reais (ver "Testes")
  processes/        workers usados pela matriz de concorrência (processos reais)
  load/run.ts       load test (`bun run test:load`)
```

## Pré-requisitos

- **Bun 1.x** (necessário para desenvolvimento local, migrations e testes)
- **Docker Compose** para executar a stack completa ou apenas as dependências
- Docker com Compose v2

## Execução completa com Docker

Esse é o fluxo mais simples para os examinadores: a aplicação, PostgreSQL,
MiniStack e pgweb são executados em containers.

```bash
cp .env.example .env
docker compose up -d --build
```

O serviço `app` constrói a imagem de produção, aguarda PostgreSQL e MiniStack
ficarem saudáveis, aplica as migrations e inicia a API. Verifique o estado e a
API com:

```bash
docker compose ps
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

Para acompanhar os logs ou desligar a stack:

```bash
docker compose logs -f app
docker compose down
```

## Execução híbrida: dependências em Docker e app local

Esse fluxo é recomendado para desenvolvimento e debugging. PostgreSQL, MiniStack
e pgweb continuam isolados em containers, enquanto NestJS roda localmente com
watch mode e usa `localhost` conforme o `.env`.

```bash
cp .env.example .env
bun install
docker compose up -d postgres ministack pgweb
bun run migration:up
bun run start:dev
```

Nesse modo, a API fica disponível em `http://localhost:3000`. Para encerrar
somente as dependências:

```bash
docker compose stop postgres ministack pgweb
```

Não execute `docker compose up -d --build` simultaneamente nesse fluxo, pois
isso também inicia o serviço `app` em container e disputa a porta `3000`.

## Testes

Os testes unitários podem ser executados sem Docker:

```bash
bun install
bun run test
```

Os testes e2e e o load test precisam de PostgreSQL e MiniStack acessíveis. O
fluxo recomendado é iniciar apenas as dependências e executar os comandos
localmente:

```bash
docker compose up -d postgres ministack
bun run test:e2e
bun run test:load
```

As filas FIFO são criadas uma vez na subida do MiniStack por
`docker/ministack/init/01-create-queues.sh`:

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada (consumer) — redrive → DLQ após 5 receives |
| `wager-transactions-dlq.fifo` | DLQ de mensagens permanentemente não processáveis |
| `wager-events.fifo` | eventos de integração publicados pelo outbox (dedup por conteúdo) |

Verificação manual: `docker compose exec ministack aws --endpoint-url=http://localhost:4566 sqs list-queues`.

## Comandos do projeto

| Comando | O que faz |
|---|---|
| `bun run start:dev` | servidor dev (watch, runtime Bun) |
| `bun run build` + `bun run start:prod` | build (`nest build`) e execução (`bun dist/main`) |
| `bun run test` | unit tests (`bun test ./src`) |
| `bun run test:e2e` | e2e (`bun test ./test`) — Postgres + MiniStack acessíveis |
| `bun run test:load` | load test (diferencial §14; relatório no console) — dependências acessíveis |
| `bun run lint` | `oxlint src/ test/` |
| `bun run format` | prettier (single quotes, trailing commas) |
| `bun run migration:create --name=<nome>` | gera migration + atualiza snapshot |
| `bun run migration:up` / `migration:down` | aplica/reverte migrations (Postgres de pé) |

No fluxo híbrido, migre um DB novo antes de subir o app: `bun run migration:up`.
No fluxo Docker, o serviço `app` executa `migration:up` automaticamente.

### Variáveis de ambiente (`.env`, ver `.env.example`)

| Variável | Descrição |
|---|---|
| `POSTGRES_DB/USER/PASSWORD/PORT`, `DATABASE_HOST/PORT` | conexão Postgres; no app em container, `DATABASE_HOST=postgres` é configurado pelo Compose |
| `AWS_ENDPOINT_URL`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | MiniStack/SQS |
| `AWS_SQS_QUEUE`, `AWS_SQS_DLQ_QUEUE`, `AWS_SQS_EVENTS_QUEUE` | filas (nomes acima) |
| `WAGER_SQS_CONSUMER_ENABLED=true` + `WAGER_SQS_POLL_MS` | liga o consumer SQS (off p/ rodar só a API HTTP) |
| `WAGER_OUTBOX_PUBLISHER_ENABLED=true` + `WAGER_OUTBOX_POLL_MS` | liga o publisher da outbox |
| `WAGER_PENDING_WORKER_POLL_MS` | worker de `PENDING_REFERENCE` (default ~2s; `0` desliga) |
| `WAGER_SQS_SHUTDOWN_TIMEOUT_MS` | grace period do shutdown do consumer (default 30s) |
| `PORT`, `APP_PORT` | porta HTTP da aplicação (default 3000); `APP_PORT` controla a porta publicada pelo Compose |

## API HTTP

Servidor escuta em `http://localhost:3000` (ou `$PORT`). Health e `/metrics` são **abertos**; os demais endpoints são o contrato do provedor (autenticação é decisão documentada — ver `ARCHITECTURE.md`/§2). Dinheiro sempre como `{ "amount": "25.00", "currency": "BRL" }` (string decimal, 2 casas).

Erros usam envelope estável `{ "statusCode": <http>, "code": "<CODE>", "message": "..." }`.

### Criar wallet

```http
POST /wallets
Content-Type: application/json

{ "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }
```

`201` com `{ id, playerId, balance, version }`. Saldo inicial > 0 gera transação interna `OPENING` + lançamento `CREDIT` do ledger na mesma transação SQL. `playerId` + `currency` duplicados → `409 WALLET_ALREADY_EXISTS`. `currency` omissa → `BRL`.

### Submeter transação (idempotente)

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-123

{
  "providerId": "provider-a", "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987", "gameId": "fortune-chimp",
  "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
}
```

Respostas de sucesso/negócio: `{ transactionId, status, balance?, failureCode?, idempotentReplay }`. A chave é o header **`Idempotency-Key`** (default sugerido `{providerId}:{externalTransactionId}`); mesma chave + mesmo payload → replay com o resultado original (`idempotentReplay: true`); mesma chave + payload diferente → `409 IDEMPOTENCY_CONFLICT`. `payloadHash` = SHA-256 do JSON canônico dos campos de negócio.

### Mapeamento de status HTTP (consistente)

| Situação | HTTP | `code`/corpo |
|---|---|---|
| Payload/cursor/limit inválidos | 400 | `INVALID_PAYLOAD` |
| Recurso inexistente (wallet/transação) | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| Conflito de idempotência / wallet duplicada | 409 | `IDEMPOTENCY_CONFLICT` / `WALLET_ALREADY_EXISTS` |
| Rejeição de negócio (transação `REJECTED`) | 422 | corpo com `status/failureCode/balance/idempotentReplay` |
| Aceite com processamento pendente (`PENDING_REFERENCE`) | 202 | corpo `PENDING_REFERENCE` |
| Processado / replay | 200 | corpo normal |
| Falha transitória de infra | 503 | `SERVICE_UNAVAILABLE` (filtro global) |
| Erro de programação não classificado | 500 | `INTERNAL_ERROR` |

### Consultas

```http
GET /wallets/:walletId
GET /wallets/:walletId/ledger?cursor=...&limit=50      # cursor opaco/estável; entries + nextCursor + hasMore
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
```

`limit` default 50, máx. 200. Ledger em ordem crescente `(created_at, id)` — auditável e estável sob escrita.

### Reconciliação

```http
POST /wallets/:walletId/reconciliation
```

`200` com `{ walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries }` (saldo materializado vs soma do ledger). Divergência é **logada**, conta em métrica e sinalizada na resposta — nunca corrigida silenciosamente.

### Health e métricas

```http
GET /health/live    # processo vivo (200, aberto)
GET /health/ready   # Postgres + SQS alcançáveis (200/503, aberto)
GET /metrics        # Prometheus text (aberto)
```

## Regras de negócio (resumo)

| Operação | Efeito | Ledger | Regra principal |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | saldo insuficiente → `INSUFFICIENT_FUNDS` |
| `WIN` | crédito | 1 `CREDIT` | movimento direto (pode referenciar a BET) |
| `LOSS` | nenhum | — | registra resultado sem mover saldo |
| `REFUND` | crédito | 1 `CREDIT` | só referencia `BET` `PROCESSED`, **uma única vez** |
| `ROLLBACK` | inverso da referência | 1 invertido | referencia BET/WIN/REFUND, **uma única vez** |

Referência ausente → `PENDING_REFERENCE` (202) e reprocessamento por worker com backoff/TTL → `UNRESOLVED_REFERENCE`. Reversões exigem `referenceExternalTransactionId`, mesmo escopo, valor igual à referência; rejeições levam `failureCode` estável (taxonomia em `src/domain/failure-code.ts` e `ARCHITECTURE.md`). A unicidade de reversão é reforçada no banco por `uq_wager_single_reversal`.

## Concorrência & consistência (essência)

- Unidade de concorrência = **wallet**: todo caminho que altera saldo adquire `SELECT … FOR UPDATE` na linha da wallet; os uniques do schema são a rede de segurança.
- Inbox (SQS) + wallet + ledger + outbox gravam na **mesma transação SQL**; nada é publicado antes do commit.
- Replay/idempotência são **persistidos** (nada em memória); o sistema permanece correto com mensagens duplicadas, fora de ordem e com N instâncias.
- Reconciliação e os e2e de crash/restart provam `wallet.balance == reconstrução do ledger`.

Ver `ARCHITECTURE.md`/`ARCHITECTURE_SUGGESTIONS.md` para o desenho completo (locking, outbox/inbox, contrato SQS, taxonomia de falhas, trade-offs).

## Testes

- **Unit** (`bun run test`): Money, invariantes da Wallet, BET/WIN/LOSS/REFUND/ROLLBACK, transições, idempotência, cursors, métricas, consumidores (gateway fake), parser SQS, applier.
- **E2E** (`bun run test:e2e`, requer `docker compose up -d`): migrations/constraints em Postgres dedicado; wallets; wagering; leitura; reconciliação; health; métricas; outbox e publisher (Ministack real); consumer SQS com inbox/DLQ; `PENDING_REFERENCE`; **matriz de concorrência** (`concurrency`, `multi-instance` com ≥3 processos reais, `crash-recovery` com SIGKILL pós-commit/pré-ack e restart com consistência final).
- **Load** (`bun run test:load`): relatório honesto de ambiente/metodologia, throughput, p50/p95/p99, taxa de erro, lock conflicts e outbox lag (ver seção §30 do log de decisões).

Os e2e criam bancos dedicados `desafio_jungle_*` e não tocam os dados de dev. O runtime de testes é o `bun test` (nada de vitest/jest).
