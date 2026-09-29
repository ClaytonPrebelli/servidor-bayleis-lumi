# Microsserviço Baileys — Lumi Makeup

Envia mensagem de WhatsApp e pareia o número da loja. **Não lê conversas** — é
envio e pareamento, por decisão.

## O que ele é

Um processo Node que roda no **Render**, plano gratuito. A API da loja fala com
ele por HTTPS para enviar mensagens e para guardar a sessão do WhatsApp.

Quem chama esse serviço é sempre a API, autenticada por segredo no cabeçalho
`x-segredo`. O segredo nunca vai para o navegador: a tela de pareamento do painel
pede o QR à API, e a API repassa.

## Rotas

| Rota | Segredo | Para que serve |
|---|---|---|
| `GET /saude` | não | O processo está vivo. É o health check do Render |
| `GET /status` | **sim** | O número está pareado? Diagnóstico do número e da sessão |
| `POST /enviar` | **sim** | Envia uma mensagem |
| `GET /pareamento` | **sim** | Devolve o QR. Só a API chama, e repassa para o painel |

Todas as quatro rotas que importam pedem segredo, porque este serviço está na
internet. Sem ele, qualquer pessoa que descobrisse o endereço mandaria mensagem
como a loja ou leria o QR da conta.

O segredo nunca vai para o navegador: a tela do painel pede o QR à API, e a API
repassa. O serviço não é feito para ser acessado direto por uma pessoa.


## Configuração

Variáveis de ambiente, todas obrigatórias em produção:

| Variável | Para que serve |
|---|---|
| `BAILEYS_SEGREDO_COMPARTILHADO` | Autentica a chamada da API, e a chamada da API ao Node. Sem ela o processo **não sobe** |
| `URL_DA_API` | Endereço da API da loja. É por ela que a sessão é guardada e recuperada |
| `BAILEYS_SILENCIOSO` | `true` reduz o log ao mínimo |
| `PORT` | Porta; o Render injeta a dele |
| `INTERVALO_DE_GRAVACAO_EM_MS` | De quanto em quanto tempo a sessão alterada sobe para a API; padrão `120000` |

O segredo é o mesmo que a API carrega de `ExternalServices:Baileys`. Os dois
lados leem o mesmo valor de variável de ambiente.

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

## Onde ele roda

No **Render**, plano gratuito, com deploy automático a cada push na `main`.

O Render monta a imagem pelo `Dockerfile` e lê as variáveis do `render.yaml`.
O segredo vai no painel do Render, nunca no arquivo.

### A sessão fica no banco, e não em disco

O plano gratuito do Render não tem disco persistente. Com a sessão em arquivo,
cada sono do serviço apagaria o pareamento — e o WhatsApp bloqueia QR repetido
com frequência. Perdendo a sessão, perde-se o número.

Por isso a sessão mora no MySQL da loja, e o Node **não fala com o banco**: ele
pede a sessão à API e devolve o que mudou. O MySQL continua fechado para a
internet, e o Render nunca recebe credencial de banco.

Só vai o que mudou desde a última gravação. A API confere a versão e recusa com
409 se outro contêiner escreveu antes — o que acontece em todo redesplie, com o
contêiner antigo ainda drenando.

### O que o Render não garante

O plano gratuito adormece o serviço depois de uns 15 minutos sem tráfego e
acorda com um *cold start* de aproximadamente um minuto. A sessão sobrevive
porque está no banco, mas a **primeira mensagem depois de acordar pode levar
cerca de um minuto**.

Isso é aceitável para o aviso de pedido, que não tem prazo. Não é aceitável
para algo interativo.

## O que este serviço não faz

- Não recebe webhook de mensagem
- Não guarda conversa
- Não lê nem responde
- Não envia em lote

Envio em lote é caminho curto para banimento do número pela Meta. Este serviço
manda uma mensagem por pedido, para quem acabou de comprar.
