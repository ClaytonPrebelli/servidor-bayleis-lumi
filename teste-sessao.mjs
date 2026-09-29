/**
 * Prova que a sessao sobrevive a um reinicio do processo.
 *
 * Este teste e o que importa para o Render: o plano gratuito dorme a cada 15
 * minutos, e se a sessao nao sobreviver, a loja escaneia QR de novo. Como o
 * WhatsApp bloqueia QR repetido, isso e perder o numero.
 *
 * Sobe uma API falsa que guarda a sessao em memoria, roda o servico duas
 * vezes apontando para ela, e confere que a segunda leitura encontrou o que a
 * primeira gravou.
 */
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const segredo = 'segredo-de-teste-local';

// As mesmas configuracoes que o servico filho recebe. O teste importa o
// sessao-api no processo do proprio teste, entao o ambiente aqui tambem
// precisa estar montado - senao a sessao em memoria nao teria para onde gravar.
process.env.URL_DA_API = `http://127.0.0.1:3199`;
process.env.BAILEYS_SEGREDO_COMPARTILHADO = segredo;
process.env.INTERVALO_DE_GRAVACAO_EM_MS = '1000';

let versaoNoBanco = 0;
let credenciaisNoBanco = null;
let chavesNoBanco = {};
let gravacoes = 0;

const api = createServer((req, res) => {
  if (req.headers['x-segredo'] !== segredo) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mensagem: 'Segredo invalido.' }));
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      existe: credenciaisNoBanco !== null,
      versao: versaoNoBanco,
      credenciais: credenciaisNoBanco,
      chaves: JSON.stringify(chavesNoBanco)
    }));
    return;
  }

  if (req.method === 'POST') {
    let corpo = '';
    req.on('data', parte => (corpo += parte));
    req.on('end', () => {
      const dados = JSON.parse(corpo);

      // A API real recusa com 409 quando a versao nao bate. Aqui tambem, para
      // exercitar o mesmo caminho.
      if (versaoNoBanco !== 0 && dados.versaoEsperada !== versaoNoBanco) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ versaoAtual: versaoNoBanco }));
        return;
      }

      if (versaoNoBanco === 0 && dados.versaoEsperada !== 0) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ versaoAtual: versaoNoBanco }));
        return;
      }

      credenciaisNoBanco = dados.credenciais;
      chavesNoBanco = { ...chavesNoBanco, ...JSON.parse(dados.chaves || '{}') };
      versaoNoBanco = dados.versaoEsperada + 1;
      gravacoes += 1;

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ gravado: true, versao: versaoNoBanco }));
    });
    return;
  }

  res.writeHead(405).end();
});

function espera(condicao, descricao, limiteEmMs = 20000) {
  const inicio = Date.now();

  return new Promise((resolve, reject) => {
    const verificar = () => {
      if (condicao()) {
        resolve();
        return;
      }

      if (Date.now() - inicio > limiteEmMs) {
        reject(new Error(`Tempo esgotado esperando: ${descricao}`));
        return;
      }

      setTimeout(verificar, 100);
    };

    verificar();
  });
}

function sobeServico(porta, urlDaApi) {
  return spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      PORT: String(porta),
      URL_DA_API: urlDaApi,
      BAILEYS_SEGREDO_COMPARTILHADO: segredo,
      BAILEYS_SILENCIOSO: 'false',
      INTERVALO_DE_GRAVACAO_EM_MS: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/**
 * Derruba o servico e espera ele sair.
 *
 * Dois cuidados que o Windows exige:
 *
 * 1. o evento "exit" pode ja ter pasado quando o listener e anexado, e nesse
 *    caso esperar por ele trava para sempre. O timeout resolve.
 * 2. no Windows o SIGTERM e emulado e pode nao chegar, entao ha um SIGKILL de
 *    reserva depois de um instante.
 */
function derruba(processo) {
  if (!processo || processo.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let resolvido = false;

    const terminar = () => {
      if (resolvido) {
        return;
      }

      resolvido = true;
      clearTimeout(tempoLimite);
      clearTimeout(segundaChance);
      resolve();
    };

    processo.on('exit', terminar);

    const tempoLimite = setTimeout(terminar, 5000);
    const segundaChance = setTimeout(() => {
      try {
        processo.kill('SIGKILL');
      } catch {
        // Ja morreu. Nada a fazer.
      }
    }, 2000);

    try {
      processo.kill('SIGTERM');
    } catch {
      terminar();
    }
  });
}

const portaDaApi = 3199;
const portaDoServico = 3198;

let servicoAtual = null;

await new Promise(resolve => api.listen(portaDaApi, '127.0.0.1', resolve));

const urlDaApi = `http://127.0.0.1:${portaDaApi}`;

/**
 * Sem isto, qualquer falha no meio do teste deixa o servico filho vivo. O
 * processo do teste nao encerra porque o filho ainda segura o event loop, e o
 * teste trava em vez de reprovar - que e pior, porque parece que passou.
 */
async function limpar() {
  if (servicoAtual) {
    await derruba(servicoAtual).catch(() => {});
    servicoAtual = null;
  }

  api.close();
}

try {
  console.log('== 1. primeira subida: sem sessao, o Node deve pedir QR ==');
  let servico = sobeServico(portaDoServico, urlDaApi);
  servicoAtual = servico;
  let saida = '';
  servico.stdout.on('data', d => (saida += d.toString()));
  servico.stderr.on('data', d => (saida += d.toString()));

  await espera(() => saida.includes('ouvindo em'), 'servico no ar');
  console.log('   servico no ar');

  console.log('== 1b. escuta em 0.0.0.0, e nao so em 127.0.0.1 ==');
  // O Render so encaminha trafego para porta aberta em todas as interfaces.
  // Escutar so em 127.0.0.1 deixa o servico no ar e inacessivel, e o Render
  // so repete "No open ports detected" sem dizer o porque. Ja aconteceu.
  assert.ok(
    saida.includes('ouvindo em 0.0.0.0'),
    `esperava 0.0.0.0 no log; veio: ${saida.split('\n')[0]}`
  );
  console.log('   confirmado: 0.0.0.0');

  console.log('== 2. a API foi consultada e ainda nao ha sessao ==');
  await espera(() => saida.includes('Nenhuma sessao no banco'), 'API consultada sem sessao');
  assert.equal(credenciaisNoBanco, null, 'nada deve ter sido gravado ainda');
  console.log('   confirmado: o banco continua vazio, esperando QR');

  console.log('== 3. simula o pareamento: o Node grava credenciais ==');
  // O QR so aparece com um celular real na frente. Aqui o que importa e o
  // caminho da gravacao, entao dispara o mesmo evento que o Baileys dispara
  // depois do escaneamento.
  const { sessaoNaApi } = await import('./src/sessao-api.js');
  sessaoNaApi.marcarCredenciaisAlteradas({ noiseKey: 'abc', me: { id: '5511999999999' } });
  await sessaoNaApi.gravar();

  await espera(() => credenciaisNoBanco !== null, 'credenciais gravadas');
  assert.ok(credenciaisNoBanco.includes('noiseKey'), 'as credenciais chegaram ao banco');
  assert.equal(versaoNoBanco, 1, 'a versao subiu para 1');
  console.log(`   gravado. versao=${versaoNoBanco}, gravacoes=${gravacoes}`);

  console.log('== 4. derruba e sobe de novo: e o teste que o Render vai fazer ==');
  await derruba(servico);
  saida = '';
  servico = sobeServico(portaDoServico, urlDaApi);
  servicoAtual = servico;
  servico.stdout.on('data', d => (saida += d.toString()));
  servico.stderr.on('data', d => (saida += d.toString()));

  await espera(() => saida.includes('ouvindo em'), 'servico de volta no ar');
  console.log('   servico de volta no ar');

  console.log('== 5. a sessao foi restaurada do banco, e nao gerada QR ==');
  await espera(() => saida.includes('Sessao carregada do banco'), 'sessao lida do banco');
  assert.ok(saida.includes('Sessao restaurada do banco'), 'nao virou QR, virou sessao restaurada');
  assert.ok(!saida.includes('Nenhuma sessao no banco'), 'nao pediu QR de novo');
  console.log('   confirmado: sessao restaurada, nenhum QR novo');

  console.log('== 6. sem segredo, nada entra ==');
  const semSegredo = await fetch(`${urlDaApi}/api/whatsapp-sessao`);
  assert.equal(semSegredo.status, 401, 'sem segredo tem de dar 401');
  console.log('   confirmado: 401 sem segredo');

  console.log('== 7. a retentativa se recupera de uma falha na partida ==');
  // Este e o bug real que aconteceu: o Render subiu o servico antes das
  // variaveis existirem, a sessao falhou, e o servico ficou no ar sem
  // WhatsApp e sem QR - sem nunca tentar de novo. O painel mostrava
  // "pareado: false" sem nenhuma pista.
  //
  // Aqui a API responde 500 na primeira chamada e so depois volta. O
  // comportamento certo e o servico insistir e recuperar sozinho.
  let chamadasQueFalharam = 0;
  const apiQueFalhaDepois = createServer((req, res) => {
    if (req.headers['x-segredo'] !== segredo) {
      res.writeHead(401).end();

      return;
    }

    if (chamadasQueFalharam < 2) {
      chamadasQueFalharam += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mensagem: 'banco fora do ar' }));

      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ existe: false, versao: 0, credenciais: null, chaves: '{}' }));
  });

  const portaInstavel = 3197;
  await new Promise(resolve => apiQueFalhaDepois.listen(portaInstavel, '127.0.0.1', resolve));

  const instavel = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      PORT: '3196',
      URL_DA_API: `http://127.0.0.1:${portaInstavel}`,
      BAILEYS_SEGREDO_COMPARTILHADO: segredo,
      BAILEYS_SILENCIOSO: 'false',
      INTERVALO_DE_GRAVACAO_EM_MS: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let saidaInstavel = '';
  instavel.stdout.on('data', d => (saidaInstavel += d.toString()));
  instavel.stderr.on('data', d => (saidaInstavel += d.toString()));

  // Espera a retentativa: a espera cresce por tentativa, entao o limite
  // cobre as duas primeiras.
  await espera(
    () => saidaInstavel.includes('Nova tentativa em'),
    'primeira falha registrada com retentativa',
    30000
  );
  console.log('   a falha foi registrada e a retentativa foi agendada');

  await espera(
    () => saidaInstavel.includes('Sem sessao no banco'),
    'recuperou depois da falha',
    60000
  );
  assert.ok(chamadasQueFalharam >= 2, 'a API foi consultada mais de uma vez');
  console.log('   confirmado: recuperou sozinho depois da falha, sem reiniciar');

  instavel.kill('SIGKILL');
  apiQueFalhaDepois.close();

  console.log('== 8. Buffer sobrevive a ida e volta pelo banco ==');
  // As chaves de criptografia do Baileys sao Buffer. Um JSON.stringify comum
  // as vira {"type":"Buffer","data":[...]}, e o parse devolve objeto comum, nao
  // Buffer. O handshake Noise opera sobre bytes: com objeto no lugar, a
  // conexao fecha em segundos e o sintoma e "error in validating connection",
  // sem nenhuma pista de que o problema era a serializacao.
  const { serializarCredenciais, lerCredenciais } = await import('./src/sessao-api.js');
  const { Buffer: bufferDoNode } = await import('node:buffer');

  const credenciaisComBuffer = {
    noiseKey: { public: bufferDoNode.from([1, 2, 3, 4]), private: bufferDoNode.from([5, 6, 7, 8]) },
    registrationId: 12345,
    me: { id: '5515999999999:1@s.whatsapp.net', name: 'Lumi Makeup' }
  };

  const texto = serializarCredenciais(credenciaisComBuffer);
  const lido = lerCredenciais(texto);

  assert.ok(Buffer.isBuffer(lido.noiseKey.public), 'noiseKey.public precisa voltar como Buffer');
  assert.ok(Buffer.isBuffer(lido.noiseKey.private), 'noiseKey.private precisa voltar como Buffer');
  assert.deepEqual(
    [...lido.noiseKey.public],
    [1, 2, 3, 4],
    'os bytes precisam voltar iguais'
  );
  assert.equal(lido.registrationId, 12345, 'campo simples preservado');
  assert.equal(lido.me.id, '5515999999999:1@s.whatsapp.net', 'me preservado');
  console.log('   confirmado: Buffer e campos simples voltaram intactos');

  console.log('== 9. atualizacao parcial nao apaga as chaves base ==');
  // O evento creds.update chega so com o que mudou. Substituir o objeto
  // inteiro perdia noiseKey e signedPreKey, e a sessao gravada ficava sem as
  // chaves de que o handshake precisa. Era o que causava a queda a cada 3s.
  const sessaoDeTeste = new (await import('./src/sessao-api.js')).SessaoNaApi();

  sessaoDeTeste.marcarCredenciaisAlteradas({ noiseKey: { public: bufferDoNode.from([9]) } });
  sessaoDeTeste.marcarCredenciaisAlteradas({ registrationId: 999 });
  sessaoDeTeste.marcarCredenciaisAlteradas({ me: { id: '5515999999999:1@s.whatsapp.net' } });

  assert.ok(sessaoDeTeste.credenciais.noiseKey, 'noiseKey sobreviveu as atualizacoes seguintes');
  assert.equal(sessaoDeTeste.credenciais.registrationId, 999, 'a ultima atualizacao venceu');
  assert.ok(sessaoDeTeste.credenciais.me, 'me foi preservado');
  console.log('   confirmado: fusao preservou as chaves e aceitou a atualizacao mais recente');

  console.log('\nTodos os passos passaram.');
} finally {
  await limpar();
}
