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
- **Item 5 concluído**: teste de integração `test/migrations.e2e-spec.ts` — roda com Postgres real (compose), cria DB dedicado `desafio_jungle_mig_test_<pid>` (drop com `with (force)`), aplica `migrator.up()` das migrations TS (`src/migrations`), valida as 5 tabelas + constraints + trigger + uma violação de CHECK, executa `down()` (reversibilidade) e derruba o DB. Nota v7: extensão é acessada via `orm.migrator` (não `getMigrator()`).
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
