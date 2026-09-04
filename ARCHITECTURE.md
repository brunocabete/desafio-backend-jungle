# Decisões de arquitetura — Jungle Wagering Processor

Este arquivo resume as decisões centrais de arquitetura do projeto. Os requisitos estão em SPECS.MD (copia do readme do enunciado do desafio). Para o detalhamento de cada decisão, com contexto, alternativas consideradas e verificação feita em cada etapa, o arquivo de referência é o ARCHITECTURE_SUGGESTIONS.md, mantido ao longo de todo o desenvolvimento. O roadmap está em PLANNING.md e foi usado para o desenvolvimento gradual do projeto.

## Visão geral

O serviço recebe operações de apostas de vários provedores (uma aposta pode virar vitória, derrota, estorno ou rollback) e liquida uma carteira por jogador. A entrega é no mínimo uma vez, ou seja: mensagens podem duplicar, chegar fora de ordem e várias instâncias podem tocar a mesma carteira ao mesmo tempo. Por isso o banco de dados é a fonte da verdade. A fila é apenas uma otimização de ordenação e deduplicação, nunca a garantia final.

## Dinheiro

Dinheiro nunca é representado como número de ponto flutuante. Usei a biblioteca decimal.js e um objeto de valor imutável Money, com construtor privado e validações internas. Na fronteira o valor é sempre uma string decimal com duas casas. Entradas inválidas são rejeitadas pelas validações.
O modelo aceita várias moedas, mas o padrão aplicado nas entradas é BRL. Precisão e arredondamento são definidos explicitamente, como decisão de produto. No banco o dinheiro vive em colunas numéricas exatas com a moeda ao lado; o driver entrega o valor como string e a aplicação reconstrói o objeto Money, sem passar por número intermediário.

## Concorrência

A unidade de concorrência é a carteira. Todo caminho que altera saldo, seja pela API, pela fila ou pelo reprocessamento de referências pendentes, primeiro trava a linha da carteira com um select for update e só então lê e recalcula o saldo. A escolha foi pelo lock pessimista em vez do otimista: uma liquidação não é um update condicionado simples, ela envolve carteira, lançamento no ledger, estado da transação e eventos na mesma transação SQL. O lock otimista exigiria comparar e atualizar o saldo condicionalmente e repetir toda essa transação multi-tabela em caso de conflito, com reexecução de efeitos. Como a disputa por uma carteira de jogador é rara e curta, o lock de linha serializa sem perda de atualização e sem loops de tentativa.

A coluna version da carteira é um contador que só sobe quando o saldo muda e aparece nas respostas da API e no evento de mudança de saldo. Só serve como auditoria e como gancho caso um dia qa estrategia de locking mude.

## Estados da transação

Uma transação nasce pendente e pode mudar para pendente de referência ou direto para um estado terminal como "processado", "rejeitado" e "com falha".


## Idempotência e hash do payload

A chave de idempotência vem de um cabeçalho obrigatório e o padrão recomendado é provedor + identificador externo. O hash do payload é calculado sobre um JSON canônico (utilizando biblioteca externa), ignorando cabeçalho e metadados de transporte.
Se a chave é nova, a transação é processada. Se a chave já existe com o mesmo hash, respondo com o resultado original e marco como replay. Se a chave existe com hash diferente, é conflito.

## Ledger

O ledger é imutável por construção e reforçado por um trigger no banco que impede atualização e exclusão. Cada lançamento guarda saldo antes e depois, e o banco valida a aritmética de acordo com a direção.

## Outbox e inbox transacionais

Tudo é escrito na mesma transação SQL: o registro de inbox quando a entrada veio da fila, a mudança de saldo, o lançamento do ledger, a transação e os eventos de integração, e nada é publicado antes do commit. 

## Consumidor da fila

O consumidor usa o mesmo caminho de código da API HTTP e só confirma a mensagem depois que a transação foi confirmada no banco. Mensagens duplicadas ou reentregues não repetem efeito. Erros são classificados: mensagem corrompida, payload inválido ou conflito de idempotência são permanentes e vão para a fila de mensagens mortas; resultado de negócio terminal não é erro e é confirmado; falha transitória de infra não é confirmada e a reentrega funciona como espera, indo para a fila de mensagens mortas após o limite de recebimentos. A ordem da fila FIFO é uma otimização, não a garantia. No encerramento por sinal, o consumidor para de buscar mensagens, termina o lote em andamento dentro de um tempo de tolerância ou devolve a visibilidade, e a reentrega é segura.

## Reconciliação

O endpoint de reconciliação compara o saldo guardado na carteira com o saldo reconstruído a partir da soma dos lançamentos do ledger, tudo dentro de uma transação com lock compartilhado na carteira. Se houver divergência, ela é registrada em log, contada em métrica e sinalizada na resposta; nunca é corrigida silenciosamente. (exemplo no logs_example.txt)

## Observabilidade

Os logs são estruturados em JSON e carregam identificadores de correlação, mensagem, transação,
carteira e provedor, sem payloads financeiros completos. Há um exemplo no arquivo logs_examples.txt


## Testes

**Testes de unidade:** dinheiro, invariantes da carteira, regras de cada operação, transições de
estado e idempotência com payload divergente.

**Integração e ponta a ponta** (rodam contra Postgres e um emulador de SQS reais, em bancos
dedicados): migrations e constraints, atomicidade entre carteira, ledger, inbox e outbox, consumo
com deduplicação, reentrega e fila de mensagens mortas, referências pendentes com expiração,
publishers concorrentes e reconciliação.

**Concorrência:** paralelismo real, incluindo múltiplos processos independentes, cenários de
queda no meio do processamento e reinício com consistência final. Em todos os testes vale o
invariante de que o saldo da carteira é igual ao saldo reconstruído pelo ledger.

**Carga** (opcional, exposto como comando próprio): registra ambiente, metodologia, taxa de
processamento, latências em percentis, taxa de erro, conflitos de concorrência e atraso da
outbox.
