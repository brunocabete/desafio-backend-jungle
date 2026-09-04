# ARCHITECTURE_SUGGESTIONS.md — log de decisões (Fase 1)

> **Propósito (PLANNING.md, Fase 1, item 5):** registro contínuo das decisões técnicas
> tomadas durante o desenvolvimento. Este arquivo é um **rascunho de decisões/sugestões**
> e alimentará o `ARCHITECTURE.md` definitivo, que será consolidado manualmente pelo autor
> ao final do projeto (Fase 8). Deve ser mantido atualizado a cada fase.
>
> Requisitos normativos: `SPECS.MD` (autoritativo). Ordem de trabalho: `PLANNING.md`.

---

## 1. Escopo desta fase

Fase 1 = **Money + modelo de domínio puro** (TypeScript puro, sem infraestrutura:
sem ORM, sem HTTP, sem filas). Tudo aqui é testado por unit tests (`bun run test`).

Estado: **concluído e verificado** — 135 testes verdes, `oxlint` e `tsc --noEmit` limpos.

---

## 2. Money (SPECS §6.1)

- **Dependência:** `decimal.js` (nunca `number`/`float` para dinheiro — §5.1).
- **Value Object imutável** com construtor privado; toda operação retorna nova instância.
- **Fronteira como string decimal** com escala fixa de 2 casas (`MONEY_SCALE = 2`):
  - entrada validada por regex `^\d+(?:\.\d{1,2})?$` → rejeita `NaN`, `Infinity`,
    notação científica, string vazia, negativos no contrato de entrada e precisão > 2
    (sem arredondamento silencioso na entrada);
  - saída (`toJSON`/`toString`) sempre normalizada com `toFixed(2)`.
- **Multi-moeda:** modelo aceita qualquer código ISO-4217 (`^[A-Z]{3}$`); operações
  entre moedas diferentes lançam `CurrencyMismatchError`. Padrão do projeto: `BRL`
  (`DEFAULT_CURRENCY`), aplicado nas fronteiras de API/fila nas fases seguintes.
- **Aritmética interna sem re-escala:** como os operandos já têm ≤ 2 casas exatas,
  `add`/`subtract`/`negate` não precisam arredondar (somente a serialização fixa a escala).
- Comparações: `equals` compara valor numérico + moeda (não lança erro entre moedas);
  `isLessThan` exige mesma moeda.
- **Pureza:** `Money` não depende de ORM, de tipos monetários de banco nem de decorators
  do NestJS. O `Decimal` só é configurado globalmente no boot da aplicação (ver §3).

### Decisões pendentes / abertas
- Definir se `DEFAULT_CURRENCY` vira default real nos DTOs de entrada (Fase 3) ou se a
  moeda é sempre obrigatória no payload.

---

## 3. Configuração explícita do `decimal.js`

- `common/decimal/decimal.config.ts` expõe `DECIMAL_PRECISION = 20` e
  `DECIMAL_ROUNDING = ROUND_HALF_UP` como **decisão consciente** (não confiar no default
  implícito da biblioteca). `Decimal.set({ ..., defaults: true })` aplica no boot.
- `DecimalConfigModule` (Nest `OnModuleInit`) garante a aplicação ao iniciar a aplicação.
- Justificativa: em sistemas financeiros, o modo de arredondamento e a precisão são
  decisões de produto; mantê-las explícitas e testadas (`decimal.config.spec.ts`).

---

## 4. Wallet (SPECS §6.2)

- **Aggregate Root** com construtor privado; `open` (criação) e `rehydrate`
  (reconstrução do banco — **não revalida** transições).
- Invariantes encapsuladas:
  - `version` inicia em **1** e incrementa **somente quando o saldo muda** (1 por
    movimentação);
  - saldo nunca negativo (`debit` lança `InsufficientFundsError`);
  - toda alteração de saldo produz exatamente **1** `WalletLedgerEntry` balanceada
    (`debit`→DEBIT, `credit`→CREDIT) e atualiza `updatedAt`;
  - moeda da operação deve ser a da wallet (`assertSameCurrency`).
- Unicidade por `(playerId, currency)` é responsabilidade do **schema** (Fase 2), não da
  classe.

### Decisão: locking otimista
Sugestão já registrada em `ARCHITECTURE.md`: wallet de jogador = contenção rara; usar
`version` para **otimistic locking** com retry limitado (a confirmar/refinar na Fase 5,
§8). Não há lock global compartilhado (§5.6).

---

## 5. WagerTransaction (SPECS §6.3)

- Máquina de estados com construtor privado + `create` (valida) e `rehydrate` (não valida).
- Nasce em `PENDING`. Estados: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`,
  `FAILED` — os três últimos são **terminais**.
- Transições permitidas (tabela única `ALLOWED_TRANSITIONS`; tentar transição inválida
  lança `InvalidTransactionStateError`):

| Ação | De | Para |
|---|---|---|
| processar | PENDING, PENDING_REFERENCE | PROCESSED |
| aguardar referência | PENDING | PENDING_REFERENCE |
| rejeitar | PENDING, PENDING_REFERENCE | REJECTED |
| falhar | PENDING, PENDING_REFERENCE | FAILED |

- Validações no `create`:
  - `REFUND`/`ROLLBACK` exigem `referenceExternalTransactionId`
    (`MissingReferenceError`);
  - `OPENING` é interno e **não** pode carregar referência;
  - `idempotencyKey` e `payloadHash` não podem ser vazios.
- Consultas de domínio: `affectsBalance()` (false p/ `LOSS`), `requiresReference()`
  (true p/ `REFUND`/`ROLLBACK`), `matchesPayload()`, `ledgerDirectionFor(reference?)`.

---

## 6. Aplicação das regras de negócio — `wager-transaction-applier.ts` (SPECS §7)

Função pura `applyWagerTransaction(wallet, transaction, { reference, referenceAlreadyReversed, now })`
que **encapsula a tabela §7** e retorna um resultado discriminado
(`processed` com entry opcional | `rejected` com `failureCode` | `pendingReference`),
em vez de lançar exceção para caminhos de negócio. Os *guards* de programação
(estado ≠ PENDING, wallet errada) continuam lançando erro.

Regras implementadas (todas com `FailureCode` específico):

| Operação | Direção | Regras |
|---|---|---|
| BET | DEBIT | saldo insuficiente → `INSUFFICIENT_FUNDS` |
| WIN | CREDIT | movimento direto |
| LOSS | — | `PROCESSED` sem mover saldo e sem entry de ledger |
| REFUND | CREDIT | só referencia BET (`REFUND_OF_NON_BET`); uma única vez (`REFERENCE_ALREADY_REVERSED`) |
| ROLLBACK | inverso da referência | referencia BET/WIN/REFUND (`UNSUPPORTED_REVERSAL_REFERENCE`) |

Regras transversais em reversões:
- referência ausente/`PENDING`/`PENDING_REFERENCE` → `markPendingReference()` +
  resultado `pendingReference` (reprocessar depois — worker Fase 4/5);
- referência terminal não-PROCESSED → `REFERENCE_NOT_PROCESSED`;
- escopo (provider/player/wallet/round/moeda) diferente → `REFERENCE_SCOPE_MISMATCH`;
- valor ≠ valor da referência → `REFERENCE_AMOUNT_MISMATCH` (§7.5);
- reversão que deixaria saldo negativo → `REVERSAL_WOULD_OVERDRAW`, código **distinto** de
  `INSUFFICIENT_FUNDS` (§7.9).

### Decisões de desenho
- **Guard de "já revertido" vem de fora:** a classe de domínio não conhece o histórico;
  quem aplica (repositório/use case, Fase 3/4) consulta reversões existentes e passa
  `referenceAlreadyReversed`. Na Fase 2 isso será reforçado por índice único no schema
  (§7.4, §5.9).
- **`entryId` gerado no applier** (`randomUUID`) para manter a pureza/atomicidade do
  `WalletLedgerEntry` na mesma transação (Fases 3–4).

---

## 7. WalletLedgerEntry (SPECS §6.4)

- **Imutabilidade estrutural:** sem setters, sem métodos de transição; `create`/`rehydrate`
  + campos `readonly`.
- `create` valida a **aritmética** (`balanceBefore ± money === balanceAfter`) via
  `isBalanced()` e a **coerência de moeda** entre os três `Money`.
- `rehydrate` reconstrói sem revalidar (permite reidratar entradas históricas).
- Operações sem efeito no saldo (LOSS, REJECTED) **não** geram lançamento.
- Double-entry é diferencial opcional, fora do escopo atual.

---

## 8. InboxMessage / OutboxMessage (SPECS §6.5)

- **Inbox:** dedup persistente por `(consumerName, messageId)` — responsabilidade do
  schema na Fase 2; a classe guarda o ciclo `receive → markProcessed` (uma única vez).
- **Outbox:** `enqueue(event)` captura o envelope como payload; ciclo de publicação com
  retry/backoff:
  - `isPending()`, `isDue(now)`, `markPublished(at)`, `scheduleRetry(now)`;
  - **backoff exponencial:** `200ms * 2^(attempt-1)` com teto de **30s**
    (`OUTBOX_RETRY_BASE_DELAY_MS`/`OUTBOX_RETRY_MAX_DELAY_MS`). Constantes exportadas
    para reuso/configuração e testadas.
- Inbox + mudança financeira + ledger + outbox devem comitar **na mesma transação SQL**
  (Fases 3–4); nada é publicado antes do commit (§5.4).

---

## 9. IntegrationEvent (SPECS §11)

- **Envelope abstrato** `IntegrationEvent<T>`: `eventId`, `aggregateId`, `correlationId`,
  `causationId?`, `occurredAt`, `data`, com `eventType`/`version` **no tipo** da subclasse
  e `toJSON()` para o payload da outbox (ISO-8601 em `occurredAt`).
- `EventContext` propaga correlação/causação; `eventId` e `occurredAt` têm defaults
  (`randomUUID`, `new Date()`).
- Subclasses concretas (Fase 1):
  - `WagerTransactionProcessed` (qualquer transação aplicada, incl. LOSS);
  - `WagerTransactionRejected` (com `failureCode`);
  - `WagerTransactionPendingReference`;
  - `WalletBalanceChanged` (somente quando o saldo muda).
- `data` sempre serializa **`MoneyProps`** (string decimal), nunca a instância `Money`
  (§11) — payload JSON estável e versionável.
- Repetição entre os três eventos de transação foi consolidada no helper
  `wagerTransactionEventData()`.

---

## 10. Taxonomia de FailureCode (SPECS §7.2)

Catálogo central (`domain/failure-code.ts`): mapa `as const` + tipo derivado +
`FAILURE_CODE_DESCRIPTIONS` (documentação máquina-legível) + guard `isFailureCode`
(usa `Object.hasOwn`, evitando falsos positivos de chaves herdadas).

Categorias (códigos estáveis, `^[A-Z][A-Z_]+$`):
- **Payload/validação:** `INVALID_PAYLOAD`, `INVALID_AMOUNT`, `CURRENCY_MISMATCH`,
  `UNSUPPORTED_TRANSACTION_KIND`, `OPENING_NOT_ALLOWED`;
- **Idempotência:** `IDEMPOTENCY_CONFLICT`;
- **Wallet:** `WALLET_NOT_FOUND`, `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`;
- **Referência/ordenação:** `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`,
  `UNRESOLVED_REFERENCE`, `REFERENCE_SCOPE_MISMATCH`, `REFERENCE_ALREADY_REVERSED`,
  `REFUND_OF_NON_BET`, `UNSUPPORTED_REVERSAL_REFERENCE`, `REFERENCE_AMOUNT_MISMATCH`;
- **Infra/permanente:** `STORAGE_FAILURE`.

Sincronia entre mapa, tipo e descrições é garantida por teste (`failure-code.spec.ts`).

---

## 11. Idempotência e payload hash (SPECS §9)

- **Chave:** header `Idempotency-Key` (default sugerido `"{providerId}:{externalTransactionId}"`),
  obrigatório na entrada (Fase 3). Header e metadados de transporte **não** entram no hash.
- **Algoritmo do `payloadHash`:** serialização **JSON canônica** (RFC 8785, chaves
  ordenadas) do subconjunto de campos de negócio via pacote `canonical-json`, seguida de
  **SHA-256** em hex (`canonical-json/hash` → `createHash('sha256')`).
- **Subconjunto de campos** (whitelist explícita em `wagerPayloadHash`):
  `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`,
  `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId` (quando
  presente). Campos extras do payload (ex.: metadados) são descartados na construção do
  objeto hasheado.
- **Classificação** (`classifyIdempotency`): chave nova → `PROCESS`; chave existente com
  mesmo hash → `REPLAY` (devolve resultado original); chave existente com hash diferente
  → `CONFLICT` (e **não** replay).

---

## 12. Pendências para as próximas fases (fora do escopo da Fase 1)

- **Fase 2:** entidades MikroORM + migrations; constraints/índices **no schema**
  (unicidade `(provider_id, external_transaction_id)` e de idempotency, unicidade de
  wallet `(player_id, currency)`, CHECK de saldo não-negativo, ledger imutável sem
  UPDATE/DELETE, marcador único de inbox).
- **Fase 3:** endpoints HTTP reutilizando o mesmo use case do consumidor SQS; criação de
  wallet com `OPENING` + CREDIT na mesma transação; mapeamento de status HTTP;
  worker/reprocessamento de `PENDING_REFERENCE` com **TTL/limite de tentativas** a definir
  (§7.1).
- **Fase 4/5:** transactional outbox + inbox + consumer SQS; **definição final do
  locking** (otimista com retry vs. `FOR UPDATE` por wallet — §8) e garantia do cenário
  obrigatório (duas apostas concorrentes).
- **Autenticação (§2):** decisão de não implementar/IdP externo, com ponto de extensão
  explícito — documentar no `ARCHITECTURE.md`.

---

## 13. Checklist da Fase 1 (PLANNING.md)

| Item | Status |
|---|---|
| 1. Dependência `decimal.js` | ✔ `package.json` |
| 2. `Money` (§6.1) com validações e multi-moeda (default BRL) | ✔ `domain/money/money.ts` |
| 3. Skeletons de domínio (`create`/`rehydrate`, transições explícitas) | ✔ wallet, wager-transaction, ledger, inbox, outbox, integration-event, failure-code |
| 4. Unit tests exaustivos (Money, Wallet, BET/WIN/LOSS/REFUND/ROLLBACK, moeda, idempotência divergente, transições) | ✔ 135 testes |
| 5. Este arquivo (`ARCHITECTURE_SUGGESTIONS.md`) | ✔ (criado; manter atualizado) |

---

## 14. Fase 2 — decisões até o item 2 (schema/ORM)

- **Config compartilhado** em `src/mikro-orm.config.ts` (`defineConfig` + `mikro-orm.configPaths`),
  driver `@mikro-orm/postgresql` ligado a `DATABASE_HOST/PORT` + `POSTGRES_DB/USER/PASSWORD`.
  Dependências de tooling: `@mikro-orm/cli` (CLI) e `tsx` (loader de TS da CLI). `@mikro-orm/nestjs`
  instalado, mas **sem `MikroOrmModule.forRoot` ainda** — entra na Fase 3 com o 1º consumidor.
- **MikroORM v7 removeu decorators** (`@Entity`/`@Property`). Entidades são definidas com a API
  nativa **`defineEntity` + builder `p`** (exportados pelo driver), sem classe separada — schema
  1:1 com a tabela, adotado como padrão.
- **Money no schema = colunas exatas**: `amount numeric(20,2)` (mapeada como `string` via
  `p.string().columnType('numeric(20,2)')`, pois o driver do pg devolve numeric como string) +
  `currency varchar(3)`. Sem custom Type de 2 colunas. `wallet.balance_amount` + `currency`
  reconstroem o `Money`; ledger guarda `currency` única por entry (todas as 3 quantias compartilham
  a moeda da wallet — invariante de domínio).
- **`wallet.version` como coluna `int` comum** (sem `@Version`/`.version()` do ORM): o domínio já
  incrementa; evita dupla contagem. Concorrência será tratada na Fase 5.
- **`inbox_message` usa PK composta** `(consumer_name, message_id)` (dedup persistente §10) em vez
  de `id` sintético + unique redundante.
- Uniques atuais (entidades): `wallet(player_id,currency)`,
  `wager_transaction(provider_id,external_transaction_id)` e `(provider_id,idempotency_key)`,
  `wallet_ledger_entry(transaction_id)` (≤1 entry por transação).
- **Próximo (item 3):** FKs, `CHECK`s (saldo ≥ 0; ledger `balance_after = balance_before ± money`)
  e trigger de imutabilidade do ledger — na migration, não via builder.
- **Item 3 (invariantes no schema) implementado** via migration `Migration..._init`:
  - FKs modeladas como relations `manyToOne(...).mapToPk().fieldName('wallet_id'|'transaction_id'|'reference_transaction_id')` (coluna escalar + FK gerada; `.deleteRule('no action')`);
  - CHECKs declarados no schema (`checks: [...]`): `wallet.balance_amount >= 0`; ledger `balance_after = balance_before ± money` conforme `direction`;
  - **imutabilidade do ledger** fora do metadata: trigger `BEFORE UPDATE OR DELETE` + função `plpgsql`, adicionados à mão na migration (reversível no `down()`);
  - extensão `Migrator` registrada no config (`@mikro-orm/migrations`); migration inicial aplicada no Postgres local e constraints validadas por SQL (trigger, CHECKs e uniques rejeitam violações e rollback limpa os dados).
- **Item 5 concluído**: teste de integração `test/migrations.e2e.test.ts` — roda com Postgres real (compose), cria DB dedicado `desafio_jungle_mig_test_<pid>` (drop com `with (force)`), aplica `migrator.up()` das migrations TS (`src/migrations`), valida as 5 tabelas + constraints + trigger + uma violação de CHECK, executa `down()` (reversibilidade) e derruba o DB. Nota v7: extensão é acessada via `orm.migrator` (não `getMigrator()`).
- **Fase 3, item 2 — `POST /wallets`**: caminho próprio de criação (fora do use case de submissão, §6.3); wallet persistida com `balance = initialBalance` e `version = 1` (OPENING não incrementa version — resposta fiel ao exemplo da §9). Se `initialBalance` > 0 → transação interna `OPENING` (provider `jungle-internal`, status PROCESSED) + lançamento CREDIT com `balanceBefore = 0` na **mesma SQL transaction**; se zero/omisso → só a wallet (sem OPENING). Duplicado `playerId+currency` → 409 (check prévio + catch do unique `uq_wallet_player_currency` para corrida). Erros: 400 `INVALID_PAYLOAD` / 409 `WALLET_ALREADY_EXISTS`; shape do erro `{statusCode, code, message}` (reutilizado nos endpoints seguintes). IDs gerados como **UUID v7** (`src/common/id/uuid.ts`, crypto nativo, sem dep). Persistência usa o **schema entity** como `EntityName` (não string — tipagem v7) e **`orm.em.fork()`** a cada operação (transação isolada por request; global EM fora de contexto é bloqueado pelo core). Abertura da wallet com `initialBalance` negativo / moeda minúscula / >2 casas → rejeitado por `Money` (400).
- **Runtime = Bun em todos os lugares (SPEC §4)**: o AGENTS.md mandava rodar prod com `node dist/main`, o que contradizia a SPEC ("Runtime / package manager / test runner: **Bun 1.x**"). Corrigido em duas frentes: `start:prod` = `bun dist/main`, e o **test runner virou `bun test`** (nativo, não Vitest — removidos vitest/`@vitest/coverage-v8`/`vite-tsconfig-paths` e os `vitest.config.*`; adicionado `@types/bun`, `tsconfig` `types: ["bun","node"]`). Unit = `bun test ./src`; e2e = `bun test ./test` (arquivos renomeados para `*.e2e.test.ts`, que o Bun descobre pelo sufixo `.test`). Um único spec usava `vi.spyOn` → trocado por `spyOn` de `bun:test` (globals de teste tipados via `src/bun-test-globals.d.ts`). Consequência: IDs passam a usar `Bun.randomUUIDv7()` diretamente (spec §9 usa formato UUID v7); o utilitário `src/common/id/uuid.ts` (implementação própria v7 em crypto) foi **removido**. Sem fallback para Node: a SPEC manda Bun.

---

## 15. Fase 3, item 3.1 — `POST /wagering/transactions` e o use case compartilhado

- **Use case compartilhado** (`src/wagering/wager-transaction.service.ts`, `WagerTransactionService.submit`): mesmo caminho de código para HTTP (agora) e SQS (Fase 4). O serviço recebe o **comando já tipado** (payload normalizado + `idempotencyKey` escolhida pelo transporte: header na HTTP, campo `data.idempotencyKey` no SQS). Parsing/validação pura exposta como `normalizeWagerSubmit` (testável sem DB).
- **Idempotência persistente** (§9): source of truth é `(provider_id, idempotency_key)` + unique no schema. Replay devolve o **resultado original** (`idempotentReplay: true`, inclusive `failureCode` de rejeições e saldo observado); mesma key com payload diferente → 409 `IDEMPOTENCY_CONFLICT`, nunca replay. Corrida entre instâncias não resolve na checagem → o `UniqueConstraintViolationException` é capturado e resolvido por reload (replay/conflict). O unique de `(provider_id, external_transaction_id)` cobre o reuso indevido da mesma operação com outra key (replay se o payload casar, senão conflito).
- **`payloadHash` canônico**: hasheia o payload **normalizado** (strings trimadas, kind em caixa alta, `money` via `Money.toJSON()` = sempre 2 casas), então `amount: "25"` e `"25.00"` produzem o **mesmo hash** — replay robusto a formatação trivial. Header de transporte não entra no hash.
- **Replay e saldo**: transação que move saldo → `balance_after_amount` do próprio lançamento; `LOSS`/`REJECTED` (sem lançamento) → reconstrução pelo último lançamento do ledger **até** o `processed_at` (sem coluna nova de snapshot — mantém schema estável).
- **Regras §7** aplicadas pelo applier de domínio. Resolução de referência por `(providerId, referenceExternalTransactionId)`; guard "já revertido" por consulta de reversões `PROCESSED` com `reference_transaction_id` = id da referência (índice parcial único adiado para a Fase 4, junto com o fluxo de reversões). Wallet inexistente → 404 (não persistível: FK `wallet_id` não-nula).
- **Applier relaxado para reprocessamento**: `applyWagerTransaction` agora aceita `PENDING_REFERENCE` de entrada (reprocessar dependente/referência que chega tarde); quando a referência segue ausente, permanece `PENDING_REFERENCE` em vez de re-marcar. Necessário para resolução on-arrival e para o worker do item 3.2.
- **Referência fora de ordem**: reversão cuja referência não chegou vira `PENDING_REFERENCE` (202). Quando a referência chega e atinge estado **terminal**, dependentes pendentes (`PENDING_REFERENCE`, mesmo provider/wallet/external) são reprocessados **na mesma transação**, sob o lock da wallet, via fila em memória (BET → REFUND → ROLLBACK, uma onda por nível; guard in-memory de dupla reversão no mesmo run).
- **Concorrência (mínimo §8)**: toda submissão que altera wallet adquire `SELECT ... FOR UPDATE` na linha da wallet (`lockMode: PESSIMISTIC_WRITE`) e re-checa idempotência sob o lock. Débito/ledger/status comitam numa única SQL transaction. A estratégia final (otimista vs. pessimista) e o cenário obrigatório são refinados/testados na Fase 5.
- **Mapeamento HTTP** (consistente entre endpoints; item 3.7 consolidará): payload inválido → `400 INVALID_PAYLOAD`; wallet ausente → `404 WALLET_NOT_FOUND`; conflito de idempotência → `409 IDEMPOTENCY_CONFLICT`; rejeição de negócio (REJECTED terminal) → `422` com o corpo `{transactionId,status,failureCode,balance,idempotentReplay}`; referência pendente → `202`; processado/replay → `200`. Replay preserva o código original (determinístico mesmo sob corrida).
- **`OPENING` rejeitado como regra de negócio** (422 `OPENING_NOT_ALLOWED`), não como payload inválido: transação auditável e futura no outbox.
- **Decisões de validação de payload**: campos de negócio exigidos e com limite de tamanho do schema (evita estouro → 500); `playerId` deve ser o dono da wallet (senão 400); moeda default `BRL` na fronteira (consistente com `POST /wallets`). Erros estruturais NÃO são persistidos nem idempotentes (400 diz ao provedor para não reenviar); rejeições de regra são persistidas (REJECTED terminal, auditável).
- Testes: unit do normalizer + reprocessamento do applier; e2e real (Postgres) cobrindo BET/WIN/LOSS/REFUND, replay processado e rejeitado, conflito, PENDING_REFERENCE + resolução on-arrival, dupla reversão, OPENING, 404 e 400.

### Pendências (Fases 4–5)
- Índice parcial único de single-reversal no schema (Fase 4) e a decisão final de locking (Fase 5).
- Eventos de rejeição (`WagerTransactionRejected`) via outbox (Fase 4), incluindo o `UNRESOLVED_REFERENCE` do worker.

---

## 16. Fase 3, item 3.2 — Worker de `PENDING_REFERENCE` (backoff + TTL)

- **Retry metadata no schema**: colunas `attempt_count int not null default 0` e `next_attempt_at timestamptz null` em `wager_transaction` (migration reversível `..._add_pending_reference_retry`, escrita à mão). Mantidas fora do domínio (`WagerTransaction` não carrega estado de retry — apenas o worker as lê/atualiza).
- **Política (documentada, §7.1):** tentativa a cada `200ms · 2^(attempt-1)`, teto de `30s`, máximo de **10 tentativas** OU TTL de **5 minutos** desde `created_at` — o que vier primeiro → `REJECTED` com `UNRESOLVED_REFERENCE`. Constantes e helper puro em `src/wagering/pending-reference-retry.ts` (unit-testado). A janela é a tolerância para o BET/ref chegarem depois da reversão; o limite garante término auditável.
- **`reprocessPendingReferences(options)`** no `WagerTransactionService` (reusa o mesmo caminho do submit): seleciona `PENDING_REFERENCE` "due" (`next_attempt_at` nulo/vencido, batch 100) e reprocessa **cada um na própria SQL transaction, sob `FOR UPDATE` da wallet** — mesma unidade de concorrência do §8. Sob o lock, re-lê a linha e aborta se não estiver mais pendente ou não devida (seguro com múltiplas instâncias: um worker que perde a corrida simplesmente não age).
- **Fluxo por linha:** reaplica `applyWagerTransaction` com a referência atual (se processada, resolve; se ausente/pendente, permanece). Continua pendente → incrementa `attempt_count` e agenda `next_attempt_at` (backoff). Esgotado/expirou → `reject(UNRESOLVED_REFERENCE)` (terminal). Resolveu/rejeitou por regra → persiste como no submit (ledger/wallet/dependentes reutilizados via helper `persistSettlement`). `syncWagerRow` zera `next_attempt_at` ao terminalizar.
- **Scheduler**: `PendingReferenceScheduler` (polling simples, sem cron — `setInterval` em `OnApplicationBootstrap`, intervalo padrão 2s, `WAGER_PENDING_WORKER_POLL_MS=0` desliga; usado pelos e2e), com guarda anti-sobreposição de ticks e shutdown limpo.
- **Decisão de teste (harness)**: o e2e do worker **não sobe o app Nest** — instancia `MikroORM` (dbName explícito via `ormOptionsFor`) + `WalletService`/`WagerTransactionService` direto. Motivo: subir `AppModule` por arquivo depende de `process.env.POSTGRES_DB` + import dinâmico do config, o que fica frágil quando o `bun test` roda arquivos em paralelo (cache de módulo + env global). Nomes de DB de teste ganharam sufixo aleatório (`test-names.ts`).
- Testes: unit (delay/agendamento) + e2e real: rejeição por TTL (`UNRESOLVED_REFERENCE`, sem mover saldo/ledger), backoff/limite de tentativas (linha rejeitada após N), "não due → skip" e teto do delay.

---

## 17. Fase 3, item 4 — Endpoints de leitura

Consultas do §9 implementadas. **Releitura: endpoints são read-only; nenhuma escrita nova no schema.**

- **`GET /wallets/:walletId`** reusa o `WalletView` do `POST /wallets` (`id`, `playerId`, `balance`, `version`). Saldo devolvido é o **armazenado** (materializado) — a checagem contra o ledger é papel da reconciliação (item 5), não do GET.
- **`GET /wallets/:walletId/ledger?cursor=&limit=`** (`WalletService.ledger`):
  - ordem **crescente** por `(created_at, id)` — ordem natural de auditoria (reconstruir saldo somando do início); ledger é imutável, então a ordem é estável sob escritas concorrentes;
  - paginação **keyset** (sem OFFSET): condição `created_at > t OR (created_at = t AND id > lastId)`; query de `limit + 1` linhas para derivar `hasMore`/`nextCursor` sem página vazia no fim;
  - **cursor opaco**: `base64url(JSON {v:1, t: createdAt-ISO, i: id})` (`src/wallets/ledger-cursor.ts`, helpers puros + unit spec). Opacidade garante liberdade de mudar o formato com versionamento (`v`);
  - `limit` default **50**, máximo **200**; cursor/limit malformados → `400 INVALID_PAYLOAD` (reuso do código existente, não nova taxonomia — item 7 consolida o mapeamento);
  - página devolve os campos puros do ledger (`id`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `createdAt`). Correlação com a transação (kind/external) é feita via `GET /wagering/transactions/:transactionId` — sem join especulativo.
- **`GET /wagering/transactions/:transactionId`** e **`GET /providers/:providerId/wagering/transactions/:externalTransactionId`** (`WagerTransactionService.findById` / `findByProviderExternal`): mesmo `WagerTransactionView` (`id`, provider/external, player, wallet, round, game, kind, status, money, referências, `failureCode`, `createdAt`/`processedAt`); lookup por provider usa o unique `(provider_id, external_transaction_id)` do schema.
- **404 distinto por recurso**: novo código `TRANSACTION_NOT_FOUND` em `ApiErrorCode` (ao lado de `WALLET_NOT_FOUND`). `walletId`/`transactionId` com formato não-UUID → **404** (não 400): o parâmetro nomeia um recurso em rota uuid; recurso não existente e id impossível são o mesmo caso para o cliente.
- **Rota aninhada do provider**: o caminho `/providers/:providerId/wagering/transactions/:externalTransactionId` tem `/wagering` no meio e não cabe sob `@Controller('wagering')` (Nest prefixa). Criado controller dedicado `@Controller('providers')` (`ProviderWageringTransactionsController`), registrado no `WageringModule`.
- **Util compartilhado `src/common/id/is-uuid.ts`** (predicado puro), reusado por `WalletService` e `WagerTransactionService` para evitar duplicação do regex.
- Testes: unit do cursor/limit + **e2e real** `test/read.e2e.test.ts` (Postgres dedicado, `AppModule`): GET wallet com saldo/versão, paginação em páginas (sem duplicatas/perdas), estabilidade quando novas entradas chegam entre páginas, wallet zerada sem lançamentos (página vazia), lookups por id interno e por provider/external, `failureCode` de rejeitado, 404s (uuid inexistente + formato inválido) e 400s de cursor/limit.

### Pendências (Fases 4–5)
- Mesmas do item 3.1/3.2 (índice único de single-reversal, locking final, outbox).

---

## 18. Fase 3, item 5 — Reconciliação `POST /wallets/:walletId/reconciliation`

SPECS §9: comparar saldo **materializado** vs **reconstruído pelo ledger**; divergência é **logada**, **contada em métrica** e **sinalizada na resposta** — nunca corrigida silenciosamente.

- **Endpoint** `POST /wallets/:walletId/reconciliation` → `200` com o shape exato do §9 (`walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`); wallet ausente/id não-UUID → `404 WALLET_NOT_FOUND`.
- **`storedBalance`** = coluna `wallet.balance_amount` (materializada). **`calculatedBalance`** = soma dos lançamentos do ledger (`CREDIT` soma, `DEBIT` subtrai) via **SQL agregado** (`sum(case when direction = 'CREDIT' then money_amount else -money_amount end)`) — aritmética exata no `numeric(20,2)` do Postgres, sem `number` JS. `checkedEntries` = `count(*)`.
- **`difference`** = `stored − calculated` (Money imutável; pode ser **negativo** e serializa `-X.XX`). `consistent = difference.isZero()`.
- **Leitura consistente sem REAPEATABLE READ**: `reconcile` roda em transação e adquire **`FOR SHARE`** na wallet (`LockMode.PESSIMISTIC_READ`). Todo escritor daquela wallet já faz `FOR UPDATE` na mesma linha antes de mexer no ledger — logo, enquanto a reconciliação segura o share lock, saldo e lançamentos não mudam (sem statement skew). A query agregada é executada **dentro da mesma transação** via `em.getConnection().execute(sql, params, 'get', em.getTransactionContext())`.
- **`buildReconciliationView`** é helper puro (Money de domínio), testado em unit: consistente, diferença positiva e **negativa**, wallet zerada sem entries.
- **Métrica**: criado `MetricsService` mínimo (`src/common/metrics/`, `MetricsModule` **`@Global`**) com contadores por nome + snapshot — primeiro tijolo de observabilidade (Fase 6 exporta). A reconciliação incrementa `wallet_reconciliation_total` sempre e `wallet_reconciliation_divergences` **somente** em divergência.
- **Log de divergência**: `warn` com `walletId`, `storedBalance`, `calculatedBalance`, `difference` e `checkedEntries`. Hoje via `Nest Logger` (mensagem textual); campos **estruturados de topo** (`correlationId` + IDs) evoluem na Fase 6 junto do `JsonLogger`.
- **Nunca corrige**: no caminho de divergência nada é escrito; a resposta sinaliza `consistent: false` e uma nova chamada volta a divergir.
- Testes: unit de `MetricsService` e de `buildReconciliationView`; **e2e real** `test/reconciliation.e2e.test.ts` (Postgres dedicado, `AppModule`): wallet consistente pós-OPENING/BET/WIN, wallet zerada sem entries, divergência forçada por `UPDATE` direto no `balance_amount` (simulando corrupção) → `consistent: false`, diferença correta, saldo armazenado **inalterado** após a chamada, métrica de divergência incrementada.

---

## 19. Fase 3, item 6 — Health checks (SPECS §9)

- **`GET /health/live`** → `200 {status:'ok'}` sempre que o processo responde (liveness: sem dependências).
- **`GET /health/ready`** → readiness **Postgres + SQS**, sem auth:
  - Postgres: `select 1` via `em.getConnection().execute(...)`;
  - SQS: cliente **`SQSClient`** (`@aws-sdk/client-sqs`, novo dep — também será usado pelo consumer da Fase 4) fazendo `GetQueueUrl` na fila `AWS_SQS_QUEUE`, com **timeout de 3s** (`Promise.race`), endpoint/creds vindos de `AWS_ENDPOINT_URL`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (`sqsEnv()`, parser puro). `client.destroy()` no `finally`.
- **Resposta**: `200 {status:'ok', checks:{database:'up', sqs:'up'}, errors:{}}`; se qualquer dependência falhar → `503 {status:'error', checks:{...}, errors:{database?|sqs?: mensagem}}`. `summarizeReadiness()` é **função pura** (unit-testada).
- **Módulo**: `src/health/` (`HealthModule` no `AppModule`); usa `MikroORM` (global do `forRoot`). O probe de readiness é reaproveitado como probe real na Fase 6.
- Falta de config de SQS (`AWS_SQS_QUEUE`) → dependência marcada **down** (readiness 503), nunca "falso up".
- Testes: unit (sumarizador + parser de env) + **e2e real** `test/health.e2e.test.ts`: live 200, ready 200 com PG+SQS up (compose), e 503 com `sqs:'down'` ao remover `AWS_SQS_QUEUE` do processo.

---

## 20. Fase 3, item 7 — Mapeamento consistente de status (SPECS §9)

Centralização + classificação explícita, eliminando ambiguidade entre "payload inválido", "conflito", "rejeição de negócio", "aceite pendente" e "falha transitória de infra".

- **Filtro global** `HttpExceptionFilter` (`src/common/http/http-exception.filter.ts`, registrado via `APP_FILTER` no `AppModule`):
  - `HttpException` com corpo já no shape `ApiErrorBody` → **passa inalterado** (cada endpoint mantém seu `statusCode/code/message`);
  - erro não tratado → **classificado**: `isTransientInfrastructureError()` considera `ConnectionException`, `LockWaitTimeoutException` e `DeadlockException` (por `instanceof`, inclusive na cadeia de `cause`) como **transitório** → `503 SERVICE_UNAVAILABLE`; demais → `500 INTERNAL_ERROR`. **Nunca** vaza a mensagem interna (só loga; resposta usa fallback genérico). Violações de constraint NÃO são transitórias (são mapeadas perto da borda, ex. unique → 409).
  - Classificador/mapa são funções puras exportadas (unit-testadas com as exceções reais do MikroORM).
- **Tabela consolidada** (códigos estáveis do `ApiErrorCode`):

| Situação | HTTP | `code` | Onde |
|---|---|---|---|
| Payload/cursor/limit inválidos | 400 | `INVALID_PAYLOAD` | wallets, wagering, ledger |
| Recurso inexistente (wallet/transação) | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | GETs, submit |
| Conflito de idempotência / wallet duplicada | 409 | `IDEMPOTENCY_CONFLICT` / `WALLET_ALREADY_EXISTS` | submit, POST /wallets |
| Rejeição de negócio (transação `REJECTED` persistida) | 422 | corpo com `status/failureCode/balance/idempotentReplay` | POST /wagering |
| Aceite com processamento pendente | 202 | corpo `PENDING_REFERENCE` | POST /wagering |
| Processado / replay | 200 | corpo normal | POST /wagering |
| Falha transitória de infraestrutura | 503 | `SERVICE_UNAVAILABLE` | filtro global |
| Erro não classificado (programação) | 500 | `INTERNAL_ERROR` | filtro global |

- Rejeição de negócio (422) e aceite pendente (202) são **resultados de negócio** (status setado no controller, corpo com o estado persistido), não erros — coerente com o resto da API.
- **Autenticação (§2)**: decisão **adiada para o último item do projeto** (item 8); health continua aberto e fila tratada como canal interno confiável.
- Testes: unit do classificador (transitório vs constraint vs erro comum) + e2e dos endpoints existentes já validam 400/404/409/422/202; health cobre 200/503.

---

## 21. Fase 4, item 1 — Transactional outbox: escrita atômica dos eventos (§11)

O que era persistido na Fase 3 (transação + saldo + ledger, e no reprocessamento de `PENDING_REFERENCE`) agora **também grava os eventos de integração na `outbox_message`, dentro da MESMA SQL transaction** — nada é publicado antes do commit (§5.4). O publisher (worker de Fase 4 item 5) só lê linhas comitadas.

- **Seleção de eventos = função pura** `settlementEvents(transaction, beforeStatus, wallet, entry?, ctx)` em `src/common/outbox/transactional-outbox.ts` (novo diretório `common/outbox`, cross-cutting de persistência — não é domínio). Regras (espelham a tabela "eventos mínimos" do §11):
  - transação **PROCESSED** → `WagerTransactionProcessed`; se gerou entry de ledger → também `WalletBalanceChanged` (o `balanceAfter` do event vem de `entry.balanceAfter`, não do snapshot do wallet);
  - transação **REJECTED** (regra de negócio) → `WagerTransactionRejected` (REJECTED nunca move saldo → sem `WalletBalanceChanged`);
  - **PENDING → PENDING_REFERENCE** (primeira vez) → `WagerTransactionPendingReference`. Reprocessamento que **permanece** pendente não re-emite (dedup por transição, não por tentativa) — evita duplicar evento a cada backoff do worker.
  - `LOSS` PROCESSED → só `WagerTransactionProcessed`, sem `balanceAfter` (não muda saldo).
- **Persistência**: `persistOutboxEvents(em, events)` mapeia cada `IntegrationEvent` para a linha da `outbox_message` via `OutboxMessage.enqueue` (payload = envelope `toJSON()` versionado; `attempts=0`, `published_at=NULL`, sem FK para o agregado — payload JSON estável).
- **Pontos de emissão** (todos dentro de `em.transactional`, já sob `FOR UPDATE` da wallet):
  1. `WagerTransactionService.process` (submit compartilhado) — via `persistSettlement`, que ganhou o parâmetro `beforeStatus`;
  2. `resolveDependents` (resolução on-arrival de dependentes `PENDING_REFERENCE`, mesma transação da referência que chega);
  3. `WagerTransactionService.reprocessOne` (worker): resolução → idem; **expiração TTL/limite** (`UNRESOLVED_REFERENCE`) → `WagerTransactionRejected` na mesma transação;
  4. `WalletService.persistOpening` (abertura com saldo > 0) → `WagerTransactionProcessed` (OPENING é transação aplicada) + `WalletBalanceChanged` (saldo 0 → X). Wallet zerada não gera evento.
- **`EventContext`**: `currentEventContext(occurredAt?)` lê o `correlationId` do `AsyncLocalStorage` (middleware HTTP) com **fallback para `randomUUID()`** — chamadas diretas ao serviço (testes/worker) continuam com correlação própria. `occurredAt` default `now` da liquidação.
- **Dedup estrutural**: eventos só existem quando a transação **transiciona** para terminal/pendente; replay idempotente e redelivery não duplicam (o transição guard já rejeita reprocessamento de terminal). Nenhum índice/coluna nova no schema para a Fase 4 item 1.
- Testes: unit de `settlementEvents` (processed/entry, LOSS, rejected, PENDING→PENDING_REFERENCE vs re-processamento pendente, OPENING) + **e2e real** `test/outbox.e2e.test.ts` (Postgres dedicado): abertura (events de OPENING + saldo; zerada = nenhum), BET + **replay sem duplicar**, LOSS sem evento de saldo, rejeição só `WagerTransactionRejected`, REFUND `PENDING_REFERENCE` → resolução on-arrival com eventos na transação de liquidação, e expiração pelo worker → `WagerTransactionRejected` **uma única vez** (e re-run não duplica).

### Pendências (Fases 4, itens 2–5)
- Inbox persistente entra quando houver consumidor SQS (item 2/3): a linha de `inbox_message` será inserida no mesmo `em.transactional` do `submit`, tornando §11 ("inbox quando a entrada for SQS") real.
- Índice parcial único de single-reversal no schema; publisher da outbox com claim atômico (item 5); métricas de outbox lag/duplicatas (item da Fase 6).

---

## 22. Fase 4, itens 2+3 — Consumidor SQS com inbox persistente, ack pós-commit e DLQ (§10)

Milestone único porque um consumidor "correto" precisa de inbox + classificação junto com o polling — separá-los forçaria reescrever o mesmo código duas vezes.

### Decisão: o use case compartilhado passou a aceitar contexto de inbox (§11)
- `WagerTransactionService.submit(request, inbox?: SqsInboxContext)` — o `SqsInboxContext` carrega `{ consumerName, messageId, payloadHash }`. Quando presente, o `process()` transacional (o MESMO do HTTP) lê a linha de inbox e, ao retornar **qualquer** resultado (novo, replay, `REJECTED` de negócio, `PENDING_REFERENCE`), grava a linha de `inbox_message` **na mesma SQL transaction** do saldo/ledger/outbox. Nada de inbox em memória (§5.2); ack só acontece depois do `submit` retornar (= commit).
- **Inserção idempotente**: `insert into inbox_message ... on conflict do nothing` executado via `em.getConnection().execute(..., em.getTransactionContext())` (o `em.upsert`/`create` do MikroORM não expõe `ON CONFLICT DO NOTHING` com PK composta sem exceção que abortaria a tx). Domínio `InboxMessage.receive→markProcessed` continua a fonte das invariantes (testado na Fase 1); a gravação persistente usa a forma nativa do PG.
- **Dedup**: redelivery encontra a linha processada e cai no replay por idempotência de negócio (sem reaplicar); corrida real de duas entregas simultâneas termina no `ON CONFLICT DO NOTHING` + `viewForExisting`. Resultado: efeito **único** no ledger mesmo com redelivery ou corrida.
- `resolveExisting` (catch de unique) também grava o inbox após replay — janela não-atômica inócua (não há escrita de efeito nesse caminho).
- `InvalidWagerPayloadError` (400) e `WagerIdempotencyConflictError` (409) **não** registram inbox: são erros permanentes de mensagem que vão para a DLQ.

### Consumidor (`src/sqs/`)
- `sqs-message.ts` — parsing puro do envelope §10 (`WagerTransactionRequested`): valida `messageId`/`type`/`data`, reusa `normalizeWagerSubmit(data)` (mesma fronteira do HTTP); `InvalidSqsMessageError` para envelope corrompido, `InvalidWagerPayloadError` propaga (payload inválido).
- `wager-sqs.gateway.ts` — porta `WagerSqsGateway` (`receive`/`ack`/`moveToDlq`) + implementação `AwsWagerSqsGateway` (`@aws-sdk/client-sqs`): long-poll (WaitTime 10s, batch 10, visibility 60s, lê `ApproximateReceiveCount`). DLQ explícito = `SendMessage` na `wager-transactions-dlq.fifo` + delete da fila principal.
- `wager-sqs.consumer.ts` — orquestra: `pollOnce()` recebe lote e processa **sequencialmente** (FIFO respeita ordem por grupo; o lock por wallet garante o resto); cada mensagem: parse → `submit` com inbox → `ack` (só após commit). Erros classificados:
  - **permanente** (`InvalidSqsMessageError`/`InvalidWagerPayloadError`/`WagerIdempotencyConflictError`) → DLQ imediato;
  - **transitório** (infra, `WagerWalletNotFoundError`) → sem ack; redelivery após visibility timeout funciona como backoff; ao atingir `SQS_MAX_RECEIVE_COUNT = 5` (`ApproximateReceiveCount`) → DLQ. A redrive policy da fila (maxReceiveCount 5, criada no compose) é a rede de segurança adicional;
  - **resultado de negócio terminal** (`REJECTED` persistido, `PENDING_REFERENCE`) **não é erro** — `submit` retorna view → ack.
- `SqsModule` no `AppModule`; consumidor **desligado por padrão**, ativa com `WAGER_SQS_CONSUMER_ENABLED=true` (+ `WAGER_SQS_POLL_MS`). Motivo: e2e que sobem o `AppModule` em paralelo não devem disputar mensagens da fila real; `.env` (dev) e `.env.example` documentam o flag. Shutdown graceful (SIGTERM) concluído no item 4 (ver §23).
- Decisão de config: gateway reusa `src/common/config/sqs.ts` (extraído do health — `sqsEnv`/`createSqsClient`, agora com `dlqQueue` de `AWS_SQS_DLQ_QUEUE`, fallback `wager-transactions-dlq.fifo`); health re-exporta `sqsEnv` (spec existente intacto).

### Testes
- Unit: `parseWagerQueueMessage` (válido, kind inválido, JSON quebrado, tipo desconhecido, sem messageId) e `WagerSqsConsumerService.handleMessage` com **fake gateway**: ack pós-sucesso + contexto de inbox, ack de `REJECTED` de negócio, DLQ de payload inválido/conflito, retry de transitório, DLQ no limite de receives; `consumeActionForFailure` puro.
- **E2E real (Ministack + Postgres)** `test/sqs-consumer.e2e.test.ts`: env AWS apontando para `localhost:4566`, filas drenadas no início/fim (isolação); BET pela fila liquida + ack + linha de inbox; **redelivery do mesmo `messageId` não duplica débito** (inbox); REFUND fora de ordem vira `PENDING_REFERENCE` (ack) e resolve quando o BET chega pela fila; payload inválido vai para a DLQ (e não registra inbox).

### Pendências
- ~~Item 4 (SIGTERM graceful)~~ → concluído (ver §23).
- ~~Item 5 (publisher da outbox com claim atômico; múltiplos publishers)~~ → concluído (ver §24).
- Índice parcial único de single-reversal no schema (adiado de fases anteriores).

---

## 23. Fase 4, item 4 — Shutdown graceful (SIGTERM) do consumidor SQS (§10)

- **`main.ts` ganhou `app.enableShutdownHooks()`** — sem isso o Nest não registra listeners de `SIGTERM`/`SIGINT` e `onApplicationShutdown` nunca roda (o processo morria sem drenar). Agora SIGTERM dispara `app.close()` → hooks de shutdown dos módulos (consumer, scheduler de `PENDING_REFERENCE`, MikroORM).
- **Consumidor com ciclo rastreado**: em vez de `setInterval` solto, cada ciclo guarda `tickPromise` (com guard anti-sobreposição `running` e flag `stopping`). `onApplicationShutdown()` chama `close()`:
  1. marca `stopping` e faz `clearInterval` (não agenda mais receives);
  2. se há ciclo em voo, **aguarda a conclusão do lote atual** (cada mensagem é ack/DLQ antes do ciclo acabar) com grace period configurável `WAGER_SQS_SHUTDOWN_TIMEOUT_MS` (default 30s);
  3. se o grace expirar, loga e retorna — o processo sai e as mensagens ainda em voo **voltam via visibility timeout** (60s) sem duplicar efeito (idempotência de negócio + inbox persistente garantem a redelivery segura).
- Isso implementa literalmente o "concluir mensagens em andamento **ou** devolver a visibilidade" do §10; o batching FIFO mantém a ordem dentro do grupo até o último instante.
- Testes unit (fake gateway com receive controlado por promise): shutdown **aguarda** o lote em voo (não resolve antes de liberar a mensagem; ao liberar, ack acontece e o close resolve), não dispara novo receive depois do stop, e consumidor desabilitado não agenda polling.

### Pendências
- ~~Item 5 (publisher da outbox com claim atômico; múltiplos publishers)~~ → concluído (ver §24).
- Índice parcial único de single-reversal no schema (adiado de fases anteriores).

---

## 24. Fase 4, item 5 — Outbox publisher com claim atômico (§11)

- **Destino dos eventos**: fila FIFO `wager-events.fifo` (criada em `docker/ministack/init/01-create-queues.sh`; **requer `docker compose up -d --force-recreate ministack`** — já feito; re-create limpa as filas antigas). `ContentBasedDeduplication=true`: publicações duplicadas idênticas dentro da janela são colapsadas pelo próprio SQS — idempotência extra além do inbox do consumidor. Envelope = `payload` da outbox (o `toJSON()` do `IntegrationEvent`, com `eventId`/`version`). `MessageGroupId = aggregateId`.
- **`SqsOutboxPublisherGateway`** (`src/outbox/outbox-publisher.gateway.ts`, porta `OutboxPublisherGateway` + token `OUTBOX_PUBLISHER`) envia para `AWS_SQS_EVENTS_QUEUE` (fallback `wager-events.fifo`).
- **`OutboxPublisherService`** (`src/outbox/outbox-publisher.service.ts`, `OutboxModule` no `AppModule`):
  - **claim = compare-and-set atômico em SQL**: `update outbox_message set attempts = attempts + 1, next_attempt_at = now + LEASE where id = ? and published_at is null and (next_attempt_at is null or next_attempt_at <= now) returning attempts`. Publishers concorrentes na mesma linha: exatamente um ganha (0 rows afetadas = skip) — **sem dupla publicação, sem lost update**; o lease (30s, `OUTBOX_CLAIM_LEASE_MS`) cobre o intervalo em voo. (Tentei `FOR UPDATE` por linha; sob corrida real 2 workers chegavam a `attempts=2`, então o CAS foi a escolha correta — ver e2e concorrente.)
  - publicação acontece **fora** de transação (sem segurar lock/DB durante rede); sucesso → **finalize com guard**: `update ... set published_at = now, next_attempt_at = null where id = ? and published_at is null and attempts = ?` (publisher "velho" que perdeu a corrida nunca sobrescreve);
  - falha → **backoff exponencial** com as constantes do domínio (`outboxRetryDelayMs`: 200ms·2^(n-1), teto 30s) via `scheduleRetry` guardado por `attempts`;
  - **crash pós-claim/pré-publicação**: lease expira e outra instância republica (duplicata segura — consumidor idempotente); nunca perde evento (§11 cenário 1–5);
  - sem limite de tentativas: fila de eventos permanentemente indisponível mantém a linha pendente (outbox lag) — "não perder" prevalece; nenhuma linha é apagada.
  - scheduler ligado por `WAGER_OUTBOX_PUBLISHER_ENABLED=true` + `WAGER_OUTBOX_POLL_MS` (default 1s), mesma convenção do consumer (off por padrão p/ e2e).
- Testes: unit de `outboxRetryDelayMs` + constantes; **e2e real** `test/outbox-publisher.e2e.test.ts` (Postgres dedicado + Ministack `wager-events.fifo`): publica todo pendente exatamente uma vez e re-run é no-op; falha (gateway que lança) → rescheduled (attempts 1, sem publicação) e recupera no run seguinte com `attempts=2`; **dois publishers concorrentes** (`Promise.all`) → soma publicados == pendentes, sem duplicata na fila e cada linha com `attempts=1` (prova do CAS).

### Pendências
- Índice parcial único de single-reversal no schema (adiado de fases anteriores — decisão registrada nas Fases 2–3).

---

## 25. Fase 5 — Concurrency hardening: estratégia final de locking (§8)

**Decisão (fechada nesta fase): locking pessimista `FOR UPDATE` por wallet, como única mecanismo.** Desde a Fase 3 todo caminho que altera saldo já adquiria o lock da linha da wallet antes de ler/recalcular:

- `WagerTransactionService.process` (submit HTTP+SQS): lock → **re-checagem de idempotência sob o lock** → aplica regras → wallet+ledger+wager+inbox+outbox num único commit;
- `reprocessOne` (worker `PENDING_REFERENCE`) e a resolução on-arrival (`resolveDependents`) reutilizam o mesmo lock da mesma wallet;
- `reconcile` lê com `FOR SHARE` — como todo escritor trava `FOR UPDATE` na mesma linha antes de tocar o ledger, saldo/ledger não mudam durante a reconstrução;
- uniques no schema (`wager(provider,external)`, `wager(provider,idempotency)`, `ledger(transaction_id)`, `wallet(player,currency)`) são a **rede de segurança** para corridas que não passam pelo lock (ex.: criação de wallet duplicada).

**Por que pessimista e não otimista (`version`)?** Uma liquidação não é um update condicionado único: é wallet + entry de ledger + estado da transação + (inbox/outbox) **na mesma transação**. Lock otimista exigiria CAS condicionado no `balance`/`version` + retry de toda a transação multi-tabela, com falhas não-determinísticas e re-execução de efeitos colaterais. A contenção por wallet de jogador é rara e curta (ms); o row lock serializa sem lost update e sem loop de retry. `wallet.version` permanece coluna **plain** (auditoria; sem `@Version` do ORM — nada de dupla contagem). §5.6 (sem lock global) respeitado: a granularidade é a linha da wallet. Ordenação/dedup do broker são **otimização**; o banco é a fonte da verdade (§5.3, §8).

**Cenário obrigatório §8 e demais corridas verificados por e2e real** (`test/concurrency.e2e.test.ts`, Postgres dedicado, paralelismo real via `Promise.all` de transações concorrentes):
- wallet `100.00`, duas apostas `80.00` simultâneas → exatamente um `PROCESSED`, um `REJECTED INSUFFICIENT_FUNDS`, saldo final `20.00`, **um** débito no ledger, `version=2`, sem débito duplicado (estável em 3 execuções);
- mesma aposta **50× em paralelo** → 1 `PROCESSED` novo + 49 replays (`idempotentReplay`), 1 linha, 1 débito, saldo `90.00`;
- 12 wallets distintas em paralelo → cada uma com seu débito/saldo corretos (sem cross-talk);
- dois `REFUND` concorrentes da mesma `BET` → um `PROCESSED`, um `REJECTED REFERENCE_ALREADY_REVERSED`, exatamente um crédito, saldo `100.00`.

(Testes de múltiplos processos/instâncias e crash-after-commit pertencem à matriz da Fase 7, §13.)

---

## 26. Fase 6 — Observability (§12)

**Logs estruturados com os campos do §12** (`src/common/logging/json.logger.ts`)
- `JsonLogger` passou a aceitar **mensagem-objeto**: campos primitivos de topo são achatados no record JSON (ex.: `event`, `transactionId`, `walletId`, `providerId`, `status`, `messageId`, `failureCode`), com `msg` (fallback para `event`), `correlationId` e `ctx` preservados. Chaves reservadas (`ts/level/pid/ctx/correlationId/msg/stack`) nunca são sobrescritas por campos do chamador.
- `WagerTransactionService.recordSettlement` loga **uma linha por liquidação** com `event: 'wager.settled'`, `transactionId/walletId/providerId/status/idempotentReplay` (+`failureCode` em rejeições) — **sem valores monetários nem payload completo** (segurança §12).
- Consumer SQS: cada mensagem é processada sob `runWithCorrelationId(messageId)` → o `correlationId` dos logs do fluxo SQS **é o `messageId`** (§10); log estruturado `wager.message.settled` com os mesmos campos.

**Métricas (§12 item 2) — sem dependência nova**
- `MetricsService` estendido: contadores **com labels**, gauges e histograma; `src/common/metrics/prometheus.ts` expõe formatação Prometheus text pura (`# TYPE`, `_bucket{le}/_sum/_count`) via `GET /metrics` (`MetricsController`, text/plain, aberto como health).
- Contadores/gauges instrumentados:
  - `wager_transactions_total{status}` e `wager_duplicates_total` (+ histograma `wager_process_duration_ms`) em `recordSettlement` (cobre HTTP e SQS — mesmo use case);
  - `outbox_publish_retries_total` em `scheduleRetry` do publisher (só quando o retry foi efetivamente agendado); gauges `outbox_pending` e `outbox_lag_seconds` atualizados a cada tick do publisher (query agregada);
  - `sqs_transient_retries_total` e `messages_moved_to_dlq_total` no consumer SQS (`routeFailure`);
  - `db_lock_conflicts_total` no `HttpExceptionFilter` quando classifica `LockWaitTimeout`/`Deadlock` (métrica de lock conflicts do §12);
  - legado `wallet_reconciliation_*` preservado (`snapshot()` segue retornando contadores sem labels).
- Histograma com buckets fixos (5ms→10s). Percentis aproximáveis a partir dos buckets; sem `prom-client`/dashboard (opcional no §12).

**Readiness (item 3)**: decidido = endpoint `/health/ready` (já testado, PG+SQS) + cobertura e2e; **sem** serviço `app` no compose (não há Dockerfile no repo — adicionar container seria infra fora do desafio). O probe real (k8s/compose) consumiria esse endpoint.

**Testes**: unit de `JsonLogger` (fields), `prometheus.ts` (labels/escaping/histograma) e `MetricsService` (labeled counters/gauges/hist); consumer conta retry/DLQ; **e2e** `test/metrics.e2e.test.ts`: após BET+replay+rejeição+reconciliação, `GET /metrics` expõe `wager_transactions_total{status=...}`, `wager_duplicates_total`, histograma com `_count>0` e reconciliação.

### Pendências
- ~~Índice parcial único de single-reversal~~ → concluído na Fase 7, passo 0 (ver §27).

---

## 27. Fase 7, passo 0 — Índice parcial único de single-reversal no schema (SPECS §7 regra 4, §5.9)

- **Invariante**: uma referência não pode ser revertida duas vezes **pelo mesmo tipo de operação** (§7.4) — e só reversão `PROCESSED` move saldo/ledger. Até aqui o guard vivia apenas no app (`hasProcessedReversal`, por `(reference_transaction_id, kind)`, sob o lock `FOR UPDATE` da wallet); agora o **schema** também garante (§5.9) como rede de segurança contra bugs/regressões e corridas fora do caminho de lock.
- **Índice**: `create unique index "uq_wager_single_reversal" on "wager_transaction" ("reference_transaction_id", "kind") where "status" = 'PROCESSED' and "kind" in ('REFUND', 'ROLLBACK')`. Semântica **alinhada** ao guard do app e aos testes já existentes:
  - chave `(reference, kind)`: um BET pode ter 1 `REFUND` e 1 `ROLLBACK` `PROCESSED` (kinds distintos), mas não 2 `REFUND` nem 2 `ROLLBACK` do mesmo tipo;
  - predicado `status = 'PROCESSED'`: `REJECTED`/`PENDING_REFERENCE` não revertem nada (sem efeito de saldo) → não contam para a unicidade;
  - `reference_transaction_id` é sempre resolvido quando a reversão fica `PROCESSED` (não há REFUND/ROLLBACK processado sem referência), então o predicado cobre exatamente os casos com efeito.
- **Expresso no metadata da entidade** (`WagerTransactionEntity.uniques[]` com `where` em forma de filter object) — MikroORM v7.1 gera índice parcial como `CREATE UNIQUE INDEX` (constraint não carrega predicado) e compara predicados de forma estrutural no diff. Migration `..._add_single_reversal_unique` gerada por `migration:create` e **limpa manualmente**: o auto-diff queria dropar/recriar o trigger de imutabilidade do ledger (que vive só na migration/DB, não no metadata) — removido, como já é prática do repo. `down()` = `drop index`. Snapshot `.snapshot-myapp.json` regenerado (passa a metadata-based; estável para os próximos `migration:create`).
- **Verificação**: `test/migrations.e2e.test.ts` agora também (a) confere o índice em `pg_indexes`; (b) BET + `REFUND` `PROCESSED` ok; (c) `ROLLBACK` `PROCESSED` do mesmo BET (kind diferente) ok; (d) `REFUND` `REJECTED` do mesmo BET (fora do predicado) ok; (e) 2º `REFUND` `PROCESSED` do mesmo BET → viola `uq_wager_single_reversal`; (f) `down({to: 0})` continua revertendo tudo. Enforcement também validado à mão no Postgres local. Combinado com os e2e de wagering/concurrency (dupla reversão concorrente e `REFUND`+`ROLLBACK` do mesmo BET), o schema é agora a última linha de defesa das regras 3–4 do §7.

### Pendências (Fase 7)
- Concluídas em §27–§30 — matriz §13 completa + load test entregue.

---

## 28. Fase 7 — Matriz de concorrência com processos reais: ≥ 3 instâncias simultâneas (SPECS §13 item 3.4, §8)

- **Problema**: o e2e de concorrência existente (`test/concurrency.e2e.test.ts`) provava as corridas com *uma* instância do serviço (várias `em.fork()` = várias conexões/transações, paralelismo SQL real). Faltava a prova explícita de **"três ou mais instâncias rodam simultaneamente"** (§8) — o cenário de uma solução que usa só lock em memória ou estado local por instância.
- **Design**: cada "instância" é um **processo separado** (`bun <worker>` via `Bun.spawn`, `test/processes/concurrent-submitter.ts`) que sobe o **próprio `MikroORM`** (pool de conexões independente) e a **própria instância do use case compartilhado** (`WagerTransactionService`) contra o mesmo Postgres. O worker lê os parâmetros via env, dispara `N` submissões concorrentes e grava um resumo JSON num arquivo (`WORKER_OUT_FILE`) — stdout/stderr ficam irrelevantes para o pai (evita parsing frágil dos logs do Nest). Timestamps `startedAt/finishedAt` permitem ao teste **provar a sobreposição** (paralelismo real, não sequencial).
  - Justificativa de não subir o app Nest HTTP completo por processo: transportes (HTTP/SQS) são otimização/ordenação — o §5.3/§8 já fixa que **o banco é a fonte da verdade** e a unidade de concorrência é a wallet; o que precisa de múltiplas instâncias é o caminho transacional, que é exatamente o que cada processo exercita. Manter Nest por processo tornaria o teste frágil e mais lento sem aumentar a validade da invariante.
- **`test/multi-instance.e2e.test.ts`** (Postgres real dedicado `desafio_jungle_multi_instance_test_*`):
  1. **Cenário obrigatório §8 entre 3 processos**: wallet `100.00`, cada processo dispara 2 apostas `80.00` concorrentes (6 no total) → exatamente **1** `PROCESSED`, **5** `REJECTED INSUFFICIENT_FUNDS`, saldo final `20.00`, `version=2`, **1** débito no ledger e reconstrução do ledger == `20.00`. Inclui `assertSimultaneous` (sobreposição temporal dos 3 workers).
  2. **Wallets distintas em paralelo entre os 3 processos**: cada processo liquida sua própria wallet sem cross-talk (`75.00`, 1 débito, version 2 cada).
  3. **Mesma aposta submetida pelos 3 processos ao mesmo tempo**: 1 linha `PROCESSED` nova + 2 replays (`idempotentReplay`), 1 débito, saldo `90.00` — idempotência persistente e unique `(provider, idempotency_key)` valendo **entre processos**.
- Nota de infraestrutura do runner: o `bun test` executa os arquivos de teste **sequencialmente no mesmo processo** (verificado empiricamente), então env/filas por arquivo são isolados; os workers filhos herdam o env do pai e apontam para o DB dedicado do arquivo.
- **Verificação**: `bun test ./test/multi-instance.e2e.test.ts` → 3 testes verdes (sobreposição confirmada); suíte completa unit 231 + e2e 68 verdes, lint e `tsc --noEmit` limpos.

---

## 29. Fase 7 — Crash pós-commit/pré-ack e restart com consistência final (SPECS §13 itens 3.5 e 3.8)

Fechamento da matriz de concorrência com **processos reais** + Ministack + Postgres, em `test/crash-recovery.e2e.test.ts` (filas FIFO **dedicadas** criadas/removidas pelo teste — não toca as filas default do compose; DB dedicado). Worker de apoio: `test/processes/sqs-consumer-worker.ts`.

- **Harness ("instância" = processo real)**: cada worker sobe seu `MikroORM` + o consumer real de produção (`WagerSqsConsumerService` + `AwsWagerSqsGateway` = mesmo use case + inbox + ack). Dois modos:
  - `crash`: recebe **1** mensagem, liquida via use case (commit: wallet+ledger+wager+inbox), grava um checkpoint com o `receiptHandle` e **pendura** — estado idêntico ao de um processo que commitou e morreu **antes do ack**. O pai faz `SIGKILL` **fora de qualquer long-poll** (o processo está pendurado em `setInterval`), lê o checkpoint e força a redelivery.
  - `poll` (padrão): consome até a fila esvaziar (um poll retorna 0) e **sai limpo** — usado como instância reiniciada.
- **§13.5 — worker morto depois do commit e antes do ack**: worker `crash` commitou a BET; `SIGKILL` antes do ack; o broker **redelivers** a mesma mensagem (mesmo `messageId`/payload, entrega at-least-once); uma instância reiniciada processa a redelivery → **replay**, sem duplicar efeito. Asserts: 1 linha `PROCESSED`, 1 débito, 1 inbox, saldo `75.00`, ledger `75.00`, fila vazia no fim.
- **§13.8 — reinício do serviço com consistência final**: instância A drena o lote 1 e **para** (serviço fora do ar); mais wagers chegam nesse intervalo; instância B (reiniciada) drena o lote 2. Asserts: 6 linhas `PROCESSED`, 6 débitos (nenhum duplicado do lote 1), 6 inbox, saldo `850.00`, `version=7` e `ledger == 850.00` (invariante final `balance == reconstrução do ledger`).
- **Decisão de desenho (robustez do teste)**: a primeira versão matava um worker `poll` com `SIGKILL`/`SIGTERM` enquanto ele podia estar **bloqueado num long-poll (10s) do FIFO**; o emulador Ministack passava a **não entregar mensagens seguintes por ~50s** (entrega "travada"), derrubando os testes com timeout e, ao limpar a fila no `afterAll`, os workers órfãos passavam a receber `QueueDoesNotExist`. Por isso **nenhum worker é morto durante um long-poll**: os `poll` param sozinhos quando a fila esvazia e o único `SIGKILL` é no worker `crash` (pendurado, fora de polling). A redelivery do §13.5 é reproduzida reenviando a mesma mensagem (padrão já usado no e2e do consumer) — determinístico e sem depender do *visibility timeout* de 60s.
- **Verificação**: `bun test ./test/crash-recovery.e2e.test.ts` verde em 3 execuções consecutivas (~37s); suíte completa unit 231 + e2e 70 verdes, lint e `tsc --noEmit` limpos.

### Pendências (Fase 7)
- ~~Diferencial opcional `bun run test:load`~~ → concluído (ver §30).

---

## 30. Fase 7, item 4 — Load test `bun run test:load` (diferencial §14)

**Script** `test/load/run.ts` (`"test:load": "bun test/load/run.ts"`) — experimento **end-to-end honesto** contra o stack real:
- app Nest completo (endpoints HTTP reais, use case transacional, outbox rows na mesma SQL transaction, `/metrics` real), Postgres dedicado migrado do zero (`desafio_jungle_load`), Ministack com **outbox publisher ON** (claim atômico + backoff reais). Consumer SQS e scheduler de `PENDING_REFERENCE` desligados (o load foca o caminho HTTP; o consumer compartilha o mesmo use case e é coberto em §13).
- **Metodologia**: seeding de `LOAD_WALLETS` (default 120) + 1 hot wallet; warm-up (default 100, descartado da latência); **fase distribuída** (1500 bets `10.00` sobre 120 wallets, 40 workers) e **fase hot wallet** (300 bets `1.00` na MESMA wallet, 40 workers — mede a serialização por `FOR UPDATE`); latências amostradas por request; erros = transporte + HTTP ≥ 500 (422 = rejeição de negócio, contada à parte); outbox observada **direto no banco** (o gauge `/metrics` só atualiza ao fim do lote de 100 publicações — grosso sob carga) até `pending = 0`, registrando o pico de lag. Knobs via env (`LOAD_*`).
- **Resultados (run default, 2026-09-04, local):**
  - ambiente: Bun 1.4.0 / linux; Postgres localhost:5432; Ministack :4566 (`wager-events.fifo`); total wall **47.8s**;
  - **distribuída**: **477.8 req/s**; latência avg 82.9ms, **p50 82.1, p95 101.4, p99 110.4 ms**; 0 erros (1500/1500 `PROCESSED`);
  - **hot wallet**: **53.6 req/s**; avg 581.4ms, p50 263.7, **p95 1894.3, p99 2062.1 ms** — o efeito esperado do lock pessimista por wallet (espera em fila do row lock), 0 erros (300/300 `PROCESSED`);
  - **erro geral**: 0/1800 (0.000%);
  - métricas cumulativas: `wager_transactions_total{PROCESSED}=1900` (incl. warm-up), `REJECTED=0`, `wager_duplicates_total=0`, **`db_lock_conflicts_total=0`** (esperado: transação única por wallet com `FOR UPDATE` não gera deadlock/lock-timeout; a contenção aparece como latência na hot wallet, não como conflito);
  - **outbox**: `pending=0`, `published=4042`, **max lag observado ~41.0s** (backlog drenado em lotes de 100 publicações seriais contra o emulador — honesto sobre a capacidade local de publicação).
- Nota de limitação: o número bruto não é a meta (§14); a qualidade = metodologia registrada + invariantes financeiras (0 erro, 0 duplicado, outbox drena) + efeito de contenção reproduzido.

### Pendências (Fase 7)
- Nenhuma — matriz §13 completa + load test entregue.
