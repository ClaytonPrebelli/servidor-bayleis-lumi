import { Router } from 'express';
import { verificarSegredo } from './segredo.js';
import { sessao } from './sessao.js';

export const rotas = Router();
/**
 * /status - a API usa para saber se o numero esta pareado antes de tentar
 * enviar, e o painel usa para mostrar qual numero esta conectado.
 *
 * Pede segredo. Este servico mora na pasta irma da API, no mesmo servidor: quem
 * alcanca a porta e a propria maquina, e leitura de sessao e envio de mensagem
 * nao podem ficar abertos para qualquer processo local.
 */
rotas.get('/status', verificarSegredo, (_req, res) => {
  res.json({
    pareado: sessao.estaConectado(),
    numero: sessao.numeroConectado(),
    nome: sessao.nomeConectado(),
    inicioEm: sessao.inicioEm(),
    ultimoEnvioEm: sessao.ultimoEnvioEm()
  });
});

/**
 * /enviar — envio de mensagem.
 *
 * O telefone vem em formato internacional, só dígitos, com o código do Brasil:
 * "5511999999999". A API já normaliza antes de chamar.
 */
rotas.post('/enviar', verificarSegredo, async (req, res) => {
  const { telefone, mensagem } = req.body ?? {};

  if (typeof telefone !== 'string' || !/^\d{12,13}$/.test(telefone)) {
    return res.status(400).json({
      mensagem: 'Telefone invalido. Envie so digitos, com o codigo do pais: 5511999999999.'
    });
  }

  if (typeof mensagem !== 'string' || mensagem.trim().length === 0) {
    return res.status(400).json({ mensagem: 'A mensagem nao pode ser vazia.' });
  }

  if (!sessao.estaConectado()) {
    // 503 e nao 400: o pedido esta certo, e quem esta fora do ar e o servico.
    // A API registra a falha e o pedido segue.
    return res.status(503).json({
      mensagem: 'O WhatsApp nao esta conectado. A sessao precisa ser pareada de novo.'
    });
  }

  try {
    const resultado = await sessao.enviar(telefone, mensagem);

    res.json({
      telefone,
      enviadaEm: new Date().toISOString(),
      enviada: true,
      resultado
    });
  } catch (erro) {
    const descricao = erro instanceof Error ? erro.message : String(erro);

    res.status(502).json({ mensagem: `Falha ao enviar: ${descricao}`, enviada: false });
  }
});

/**
 * /pareamento - devolve o QR em PNG base64, para a tela de cadastro.
 *
 * Pede segredo pelo mesmo motivo do /status. O segredo nunca e digitado no
 * navegador: a tela do painel fala com a API, e a API repassa o QR. Se esta
 * rota fosse publica, qualquer processo local leria o QR do numero da loja.
 */
rotas.get('/pareamento', verificarSegredo, async (_req, res) => {
  if (sessao.estaConectado()) {
    return res.json({ pareado: true, numero: sessao.numeroConectado() });
  }

  const qr = await sessao.obterQr();

  if (qr === null) {
    // O WhatsApp só libera QR na primeira conexão. Depois disso, ou já está
    // pareado, ou o número está banido.
    return res.status(409).json({
      mensagem: 'Nenhum QR disponivel. Ou o numero ja esta pareado, ou foi bloqueado pelo WhatsApp.'
    });
  }

  res.json({ pareado: false, qr });
});
