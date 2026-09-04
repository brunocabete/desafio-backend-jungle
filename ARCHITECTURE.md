# Decisões arquiteturais a respeito do projeto

## Money

Para o objeto Money, temos um objeto de valor com um construtor privado.
Como Money é uma, senão A principal abstração deste projeto, é necessário que sua implementação seja absolutamente consistente.

O construtor privado faz com que quaisuqer instanciações desse objeto precisem ser validadas pela lógica interna do objeto durante sua criação pelos métodos from e zero.
O método de arredondamento utilizado pela biblioteca Decimal foi definido explicitamente, uma vez que em aplicações que lidam com dinheiro, essa é uma decisão consciente por parte dos desenvolvedores baseado em fatores a serem discutidos com o time de produto.

## Wallet

Um dos pontos principais a serem decididos no objeto de carteira é como é feito o locking do registro no caso de acessos simultâneos/race condition.

Na fase inicial cogitei o **locking otimista** via `version` (a carteira é de um jogador, então a contenção tende a ser rara). Na **fase final de concorrência (§5 do desafio) essa escolha foi revisada e fechada como locking pessimista**: toda liquidação não é um update condicionado único — ela envolve wallet + lançamento de ledger + estado da transação + inbox/outbox **na mesma transação SQL**. Lock otimista exigiria CAS no saldo/`version` + retry de toda a transação multi-tabela, com re-execução de efeitos; o `FOR UPDATE` por linha da wallet serializa sem lost update e sem loop de retry. A granularidade é a **linha da wallet** (sem lock global), e `wallet.version` ficou como coluna *plain* (auditoria), sem `@Version` do ORM. Detalhes e justificativa: `ARCHITECTURE_SUGGESTIONS.md` §25.

A reconciliação lê com `FOR SHARE`; como todo escritor trava a mesma linha com `FOR UPDATE`, saldo e ledger não mudam durante a reconstrução. Os uniques do schema são a rede de segurança para corridas que não passam pelo lock (ex.: criação de wallet duplicada).


## Wager transaction

Aqui temos uma state machine com regras bem definidas e que devem ser checadas em todos os processos de transição de estado. Para isso temos o mapeamento em ALLOWED_TRANSITIONS que gera erros de negócio sempre que uma transição não permitida tenta ocorrer.

Para transações que se derivam de outras (`REFUND`/`ROLLBACK`), o **`referenceExternalTransactionId`** do provedor é obrigatório e mantém a consistência dos dados: a referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa pertencer ao mesmo provider/player/wallet/rodada/moeda. `OPENING` é interno (criação de wallet) e não pode ser submetido pela API/fila.

Estados imutáveis também são definidos pois não há nenhuma operação que pode ser realizada na transação após ela ser definida como processada, rejeitada ou com falha.

## Idempotencia e Hashing

Para a criação da chave de idempotencia, são retirados apenas os valores presentes nas regras de negócio daquele objeto para a geração da hash sem utilizar valores temporais (JSON canônico + SHA-256 dos campos de negócio — o header de transporte não entra). O `payloadHash` é persistido junto da transação:

- chave nova → processa;
- chave existente com **mesmo** hash → replay, devolvendo o resultado original (incluindo o saldo observado);
- chave existente com hash **diferente** → conflito (`IDEMPOTENCY_CONFLICT`), nunca replay.

A unicidade é garantida no banco por `(provider_id, idempotency_key)`; corrida entre instâncias resolve o unique em replay/conflict via reload.


## Schema do banco
    Dinheiro é persistido em colunas exatas `numeric(20,2)` + `currency varchar(3)`; o driver do Postgres devolve `numeric` como string e a aplicação reconstrói o `Money` via `Money.from` (sem `number` intermediário). Ordenação e aritmética de checagem (saldo/ledger) acontecem no Postgres, com precisão exata. O ledger é imutável por trigger (`BEFORE UPDATE OR DELETE`) e a unicidade de reversão (`REFUND`/`ROLLBACK` `PROCESSED`) é garantida por índice parcial único `uq_wager_single_reversal`.
