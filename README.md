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
| `GET /status` | não | O número está pareado? Em que porta a API pergunta antes de tentar enviar |
| `POST /enviar` | **sim** | Envia uma mensagem |
| `GET /pareamento` | não | Devolve o QR para a tela de cadastro |

`/pareamento` não pede segredo porque é lida por uma pessoa, na primeira vez, no
navegador dela. Se pedisse, ela precisaria do segredo na mão — e ele acabaria no
histórico de quem fez o cadastro.

`/status` também não pede: a API consulta periodicamente, e exigir segredo em
consulta só adicionaria chance de a API parar de consultar por causa de um 401.

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

1. Instalar Node 20 ou superior
2. Copiar o projeto para a pasta do serviço
3. `npm ci --omit=dev`
4. Instalar como serviço do Windows, para subir com a máquina e reconectar sozinho

O passo 4 importa: rodando à mão, o processo morre no logout do servidor e a
sessão do WhatsApp cai junto.

## O que este serviço não faz

- Não recebe webhook de mensagem
- Não guarda conversa
- Não lê nem responde
- Não envia em lote

Envio em lote é caminho curto para banimento do número pela Meta. Este serviço
manda uma mensagem por pedido, para quem acabou de comprar.
