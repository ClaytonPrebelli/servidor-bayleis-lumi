import { randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * O segredo compartilhado entre a API e este servico.
 *
 * Vem de BAILEYS_SEGREDO_COMPARTILHADO, que o GitHub Actions escreve no
 * appsettings de producao. Em desenvolvimento, de um arquivo .env fora do
 * versionamento.
 */
const segredo = process.env.BAILEYS_SEGREDO_COMPARTILHADO ?? '';

if (!segredo && process.env.NODE_ENV === 'production') {
  // Sem segredo em producao, qualquer um que chegue a porta manda mensagem
  // como a loja. Falhar na partida e melhor do que descobrir isso depois.
  throw new Error('BAILEYS_SEGREDO_COMPARTILHADO nao configurado.');
}

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

  if (!segredo || !comparar(recebido, segredo)) {
    // 401 e nao 403: com 403 o chamador sabe que o segredo existe e so errou o
    // valor, o que ajuda a tentar de novo.
    res.status(401).json({ mensagem: 'Segredo invalido.' });
    return;
  }

  proximo();
}

export { randomUUID };
