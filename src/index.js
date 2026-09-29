import express from 'express';
import { rotas } from './rotas.js';
import { sessao } from './sessao.js';

const porta = Number(process.env.PORT ?? 3001);

/**
 * O servico escuta **so em localhost**.
 *
 * Quem entra pela internet e o IIS, por HTTPS, com URL Rewrite apontando para
 * esta porta. O Node nao e' exposto: se ele escutasse em 0.0.0.0, qualquer um
 * que descobrisse a porta mandaria mensagem como a loja, sem passar pelo IIS e
 * sem certificado.
 */
const aplicativo = express();

aplicativo.use(express.json({ limit: '256kb' }));

aplicativo.get('/saude', (_req, res) => {
  res.json({ ok: true, pareado: sessao.estaConectado() });
});

aplicativo.use(rotas);

const servidor = aplicativo.listen(porta, '127.0.0.1', () => {
  console.log(JSON.stringify({
    em: new Date().toISOString(),
    mensagem: `whats-lumimakeup ouvindo em 127.0.0.1:${porta}`
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

  servidor.close(() => process.exit(0));

  // Se alguma conexao ficar presa, sair assim mesmo: um processo pendurado no
  // Windows segura a pasta e trava o proximo deploy.
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
