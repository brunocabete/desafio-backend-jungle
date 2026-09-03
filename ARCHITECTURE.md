# Decisões arquiteturais a respeito do projeto

## O objeto Money

Para o objeto Money, temos um objeto de valor com um construtor privado.
Como Money é uma, senão A principal abstração deste projeto, é necessário que sua implementação seja absolutamente consistente.

O construtor privado faz com que quaisuqer instanciações desse objeto precisem ser validadas pela lógica interna do objeto durante sua criação pelos métodos from e zero.
O método de arredondamento utilizado pela biblioteca Decimal foi definido explicitamente, uma vez que em aplicações que lidam com dinheiro, essa é uma decisão consciente por parte dos desenvolvedores baseado em fatores a serem discutidos com o time de produto.




## Disclaimer sobre o uso de IA:
Este arquivo foi redigido apenas por mãos humanas, de forma a retratar as decisões tomadas pelo autor.
Agentes de IA foram utilizados ao longo do projeto como auxílio, porém seu uso foi feito de forma consciente e procedural, de forma que a cada etapa o autor controlava as decisões estruturais do projeto e analisava o código escrito, fazendo todas e quaisquer alterações necessárias.