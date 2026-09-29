# Microsserviço Baileys — Lumi Makeup

Envia mensagem de WhatsApp e pareia o número da loja. **Não lê conversas** — é
envio e pareamento, por decisão.

## O que ele é

Um processo Node que roda **no mesmo servidor Windows da API**, em `127.0.0.1:3001`.
Quem entra pela internet é o IIS, por HTTPS, no subdomínio
`whats.lumimakeup.com.br`, com URL Rewrite apontando para esta porta.

O Node escuta **só em localhost** de propósito: escutando em `0.0.0.0`, qualquer
um que descobrisse a porta mandaria mensagem como a loja, sem passar pelo IIS e
sem certificado.

## Rotas

| Rota | Segredo | Para que serve |
|---|---|---|
| `GET /saude` | não | O processo está vivo |
| `GET /status` | **sim** | O número está pareado? Diagnóstico do número e da sessão |
| `POST /enviar` | **sim** | Envia uma mensagem |
| `GET /pareamento` | **sim** | Devolve o QR para a tela de cadastro |

`/pareamento` e `/status` pedem segredo porque este serviço fica numa pasta
irmã da API, no mesmo servidor: quem alcança a porta é a própria máquina. Sem
segredo, qualquer processo local leria o QR do número da loja ou tentaria
enviar mensagem como a empresa.

O segredo nunca é digitado no navegador. A tela de cadastro do painel fala com a
API, e a API repassa o QR — o segredo fica no servidor, fora do histórico de
quem pareou.

## Configuração

Variáveis de ambiente, todas obrigatórias em produção:

| Variável | Para que serve |
|---|---|
| `BAILEYS_SEGREDO_COMPARTILHADO` | Autentica a chamada da API. Sem ela o processo **não sobe** |
| `BAILEYS_SILENCIOSO` | `true` reduz o log ao mínimo |
| `PORT` | Porta; padrão `3001` |
| `PASTA_DE_DADOS` | Onde fica a sessão; padrão `./dados` |

O segredo é o mesmo que a API carrega de `ExternalServices:Baileys`. Os dois
lados leem o mesmo valor de variável de ambiente.

## A pasta `dados/`

Contém os arquivos de autenticação da sessão. São poucos KB e **são o número da
loja**: quem tiver acesso a essa pasta tem o WhatsApp da empresa.

Consequência de perder a pasta: o número precisa ser pareado de novo, com QR
novo. O WhatsApp bloqueia QR repetido com frequência, então não apague.

Consequência de vazar a pasta: o número é usável de qualquer lugar. Pasta de
`node_modules` com `express` e `baileys` na raiz: usar `require('express')`
acharia o módulo da aplicação, que é de produção, e não o do pacote.

## Por que não lê conversas

```js
markOnlineOnConnect: false,
syncFullHistory: false,
```

Não marca mensagem como lida, não sincroniza histórico e não processa mensagem
recebida. Quem responde o cliente é a administradora, no WhatsApp dela.

Esta sessão existe para **avisar** que o pedido entrou. Se ela lesse
conversas, seria uma superfície de leitura que a loja não pediu.

## Desenvolvimento

```bash
npm install
BAILEYS_SEGREDO_COMPARTILHADO=qualquer-coisa npm run dev
```

Abra `http://127.0.0.1:3001/pareamento` e escaneie o QR. O número aparece no
terminal em paralelo.

Para testar envio contra o número da loja:

```bash
curl -X POST http://127.0.0.1:3001/enviar \
  -H 'content-type: application/json' \
  -H 'x-segredo: qualquer-coisa' \
  -d '{"telefone":"5511999999999","mensagem":"teste"}'
```

## Instalação no servidor

O servidor de produção só aceita **FTP**: não há console para instalar Node nem
Task Scheduler para agendar início. Por isso o Node é **portátil**, e quem o
sobe é a própria API.

### 1. Montar a pasta

Baixe a versão **portátil** do Node 20 ou superior (`node-vXX-win-x64.zip`) e
extraia `node.exe` para a pasta do serviço, junto do código:

```
whats.lumimakeup.com.br/
  node.exe              <- da versão portátil do Node
  src/
  package.json
  package-lock.json
  node_modules/         <- 'npm ci --omit=dev' rodado na sua maquina
  dados/                <- sessão; crie na mao, nao vai no Git
```

Rode `npm ci --omit=dev` na sua máquina e envie `node_modules` junto. Sem
console no servidor, não há como instalar as dependências lá.

### 2. Onde a pasta fica

Pasta **irmã** da publicação da API:

```
api.lumimakeup.com.br/          <- publicação da API
whats.lumimakeup.com.br/        <- este serviço
```

O mesmo formato de caminho relativo que o `ArmazenamentoDeImagens` já usa
(`../imagens`).

### 3. Quem sobe o Node

A API, com `IniciarProcesso: true` em `ExternalServices:Baileys`. O supervisor:

- sobe o `node.exe` apontando para `src/index.js`;
- passa o segredo por **variável de ambiente**, nunca por argumento — argumento
  de linha de comando aparece na lista de processos do Windows;
- mantém a pasta `dados/` como pasta de trabalho, para a sessão sobreviver ao
  recycle do pool do IIS;
- vigia o processo e **sobe de novo** se ele morrer;
- encerra o Node junto com a API, sem deixar processo órfão segurando a pasta.

Em desenvolvimento o caminho é o contrário: `IniciarProcesso: false` e o Node
roda na mão, com `npm run dev`. Sem isso, o supervisor subiria um segundo Node na
mesma porta e um dos dois ficaria com `EADDRINUSE`.

## O que este serviço não faz

- Não recebe webhook de mensagem
- Não guarda conversa
- Não lê nem responde
- Não envia em lote

Envio em lote é caminho curto para banimento do número pela Meta. Este serviço
manda uma mensagem por pedido, para quem acabou de comprar.
