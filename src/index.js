import express from 'express';
import { rotas } from './rotas.js';
import { sessao } from './sessao.js';
import { sessaoNaApi } from './sessao-api.js';

const porta = Number(process.env.PORT ?? 3001);

/**
 * Endereco de escuta.
 *
 * 0.0.0.0 e' obrigatorio no Render: a plataforma so encaminha trafego para
 * uma porta aberta em todas as interfaces. Escutar so em 127.0.0.1 deixava o
 * servico no ar e inacessivel, e o log do Render repetia "No open ports
 * detected on 0.0.0.0" sem nunca dizer o porque.
 *
 * Expor a porta nao torna o servico aberto: o Render terminate TLS e as rotas
 * que importam - /status, /enviar e /pareamento - exigem o segredo
 * compartilhado. A unica rota sem segredo e' /saude, que responde "esta no
 * ar" e nada mais.
 *
 * HOST fica no ambiente para dar margem: em algum outro lugar pode ser preciso
 * voltar a restringir a interface.
 */
const host = process.env.HOST ?? '0.0.0.0';

const aplicativo = express();

aplicativo.use(express.json({ limit: '256kb' }));

aplicativo.get('/saude', (_req, res) => {
  res.json({ ok: true, pareado: sessao.estaConectado() });
});

aplicativo.use(rotas);

const servidor = aplicativo.listen(porta, host, () => {
  console.log(JSON.stringify({
    em: new Date().toISOString(),
    mensagem: `whats-lumimakeup ouvindo em ${host}:${porta}`
  }));

  // Inicia a sessao em segundo plano, para o servico subir mesmo que o QR ainda
  // nao tenha sido lido. Sem isso, /pareamento nao responderia nada.
  sessao.iniciar().catch(erro => {
    console.error(JSON.stringify({
      em: new Date().toISOString(),
      nivel: 'erro',
      mensagem: 'Falha ao iniciar a sessao do WhatsApp.',
      erro: String(erro)
    }));
  });
});

/**
 * Encerramento limpo.
 *
 * Sem isto, o Node e' morto no meio de um envio e a mensagem some sem registro.
 * O IIS pede o stop do pool antes do deploy, e este SIGTERM e o que da tempo de
 * a conexao fechar.
 */
function encerrar(sinal) {
  console.log(JSON.stringify({
    em: new Date().toISOString(),
    mensagem: `Recebido ${sinal}. Encerrando.`
  }));

  // Grava a sessao antes de sair. O Render da alguns segundos antes de matar
  // o container, e e essa janela que salva o pareamento quando o servico
  // reinicia: sem isso, as ultimas mudancas de chave se perderiam e a sessao
  // recarregada ficaria incompleta.
  sessaoNaApi.gravarPendentes()
    .catch(erro => {
      console.error(JSON.stringify({
        em: new Date().toISOString(),
        nivel: 'erro',
        mensagem: 'Falha ao gravar a sessao no encerramento.',
        erro: String(erro)
      }));
    })
    .finally(() => {
      servidor.close(() => process.exit(0));

      // Se alguma conexao ficar presa, sair assim mesmo: um processo pendurado
      // no Windows segura a pasta e trava o proximo deploy.
      setTimeout(() => process.exit(0), 10000).unref();
    });
}

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
