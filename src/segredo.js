import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ErroDeConfiguracao } from './sessao-api.js';

/**
 * O segredo compartilhado entre a API e este servico.
 *
 * Vem de BAILEYS_SEGREDO_COMPARTILHADO, que fica no painel do Render.
 *
 * A validacao NAO acontece aqui, no carregamento do modulo. Lancar erro nesse
 * ponto derrubava o processo antes de ele comecar a escutar, com um stack
 * trace que nao diz o que fazer. Quem valida e a sessao-api, que sabe dizer
 * qual variavel falta e que repetir nao resolve.
 */
const segredo = process.env.BAILEYS_SEGREDO_COMPARTILHADO ?? '';

function comparar(a, b) {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  // timingSafeEqual exige o mesmo tamanho, e comparar tamanhos antes de saber o
  // valor ja vaza o tamanho do segredo.
  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

export function verificarSegredo(req, res, proximo) {
  const recebido = req.header('x-segredo') ?? '';

  if (!segredo) {
    // Sem segredo, TODA rota protegida responde 401, inclusive /saude nao e
    // afetada. A mensagem diz o que fazer, porque e o erro mais comum de
    // verdade: variavel cadastrada no GitHub, mas nao no Render.
    res.status(503).json({
      mensagem: 'BAILEYS_SEGREDO_COMPARTILHADO nao esta configurado neste servico. Cadastre em Render > Environment e faca um novo deploy.'
    });

    return;
  }

  if (!comparar(recebido, segredo)) {
    // 401 e nao 403: com 403 o chamador sabe que o segredo existe e so errou o
    // valor, o que ajuda a tentar de novo.
    res.status(401).json({ mensagem: 'Segredo invalido.' });
    return;
  }

  proximo();
}

export { randomUUID };
