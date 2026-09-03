# Decisões arquiteturais a respeito do projeto

## Money

Para o objeto Money, temos um objeto de valor com um construtor privado.
Como Money é uma, senão A principal abstração deste projeto, é necessário que sua implementação seja absolutamente consistente.

O construtor privado faz com que quaisuqer instanciações desse objeto precisem ser validadas pela lógica interna do objeto durante sua criação pelos métodos from e zero.
O método de arredondamento utilizado pela biblioteca Decimal foi definido explicitamente, uma vez que em aplicações que lidam com dinheiro, essa é uma decisão consciente por parte dos desenvolvedores baseado em fatores a serem discutidos com o time de produto.

## Wallet

Um dos pontos principais a serem decididos no objeto de carteira é como é feito o locking do registro no caso de acessos simultaneos/race condition.
Neste exercício, como a carteira é invariavelmente de um jogador, escolher o locking otimista faz sentido já que as operações de leitura e escrita serão limitadas a apenas uma pessoa interagindo com o jogo, havendo tempo o suficiente entre ações para que os problemas citados sejam raros, e com as devidas mensagens de erro informando tanto o usuario como os desenvolvedores da aplicação que consome o backend, não há grande confusão quanto ao uso da plataforma, mantendo assim uma maior simplicidade da implementação e menos pontos de falha.
Pela minha experiencia com jogos online, esse tipo de falha de comunicação normalmente é percebida como um problema na própria internet, portanto o jogador acaba sabendo o que precisa fazer para evitar que isso ocorra novamente (mas com certeza pediria opinião do time de UI/UX e produto para mais informacoes)


## Wager transaction

Aqui temos uma state machine com regras bem definidas e que devem ser checadas em todos os processos de transição de estado. Para isso temos o mapeamento em ALLOWED_TRANSITIONS que gera erros de negócio sempre que uma transição não permitida tenta ocorrer.

Para transações que se derivam de outras como rollback, o ID da transação originária é OBRIGATÓRIO e mantém a consistencia dos dados.

Estados imutáveis também são definidos pois não há nenhuma operação que pode ser realizada na transação após ela ser definida como processada, rejeitada ou com falha.

## Idempotencia e Hashing

Para a criação da chave de idempotencia, são retirados apenas os valores presentes nas regras de negócio daquele objeto para a geração da hash sem utilizar valores temporais.
Caso a hash ainda não exista no banco, a transação pode ser processada. Caso já exista


## Disclaimer sobre o uso de IA:
Este arquivo foi redigido apenas por mãos humanas, de forma a retratar as decisões tomadas pelo autor.
Agentes de IA foram utilizados ao longo do projeto como auxílio, porém seu uso foi feito de forma consciente e procedural, de forma que a cada etapa o autor controlava as decisões estruturais do projeto e analisava o código escrito, fazendo todas e quaisquer alterações necessárias.