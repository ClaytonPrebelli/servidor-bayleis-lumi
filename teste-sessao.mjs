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
  // A conexao abriu: e a partir dai que a sessao vale. Sem confirmar, o passo
  // 11 mostra que nada seria gravado.
  sessaoNaApi.confirmar();
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
  // As duas linhas de log sao escritas sem nenhuma espera entre elas, mas
  // chegam pelo pipe em pedacos e o verificador deste teste roda a cada 100 ms.
  // Conferir a segunda logo apos a primeira reprovava de vez em quando sem que
  // nada estivesse quebrado. Aqui a espera e explicita, e o erro traz o log
  // inteiro, que e o que costuma bastar para descobrir a causa real.
  try {
    await espera(
      () => saida.includes('Sessao restaurada do banco') || saida.includes('Nenhuma sessao no banco'),
      'sessao restaurada do banco'
    );
  } catch (erro) {
    throw new Error(`${erro.message}\n--- log do servico ---\n${saida}`);
  }

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

  console.log('== 10. as chaves base vao para o banco, e nao so as alteracoes ==');
  // O bug que faltava. As credenciais iniciais eram geradas e entregues ao
  // Baileys, mas nao guardadas neste objeto. O creds.update chega parcial, a
  // fusao partia de null, e o que ia para o banco era so account, me e
  // platform. A sessao salva ficava sem noiseKey e sem signedPreKey, e no
  // carregamento seguinte o handshake nao fechava: o servico caia e repetia
  // para sempre, parecendo problema de rede.
  const sessaoNova = new (await import('./src/sessao-api.js')).SessaoNaApi();

  sessaoNova.paraBaileys();

  assert.ok(sessaoNova.credenciais, 'as credenciais iniciais precisam ser guardadas');
  assert.ok(sessaoNova.credenciais.noiseKey, 'noiseKey inicial tem de estar guardado');
  assert.ok(sessaoNova.credenciais.signedPreKey, 'signedPreKey inicial tem de estar guardado');
  assert.ok(sessaoNova.credenciais.signedIdentityKey, 'signedIdentityKey inicial tem de estar guardado');
  // `!== undefined`, e nao truthiness: o Baileys sorteia o registrationId em
  // 0..16383, e zero e um valor legitimo. Com truthiness este passo reprovava
  // uma vez a cada 16384 execucoes, sem que nada estivesse errado.
  assert.notEqual(sessaoNova.credenciais.registrationId, undefined, 'registrationId inicial tem de estar guardado');
  console.log('   confirmado: as chaves base foram guardadas');

  const ruido = sessaoNova.marcarCredenciaisAlteradas({ me: { id: '5515999999999:1@s.whatsapp.net' } });
  const aposParcial = sessaoNova.credenciais;

  assert.ok(aposParcial.noiseKey, 'noiseKey sobreviveu a atualizacao parcial');
  assert.ok(aposParcial.signedPreKey, 'signedPreKey sobreviveu a atualizacao parcial');
  assert.ok(aposParcial.me, 'a atualizacao parcial foi aceita');

  // E o que realmente vai para o banco.
  const gravado = serializarCredenciais(aposParcial);
  const relido = lerCredenciais(gravado);

  assert.ok(relido.noiseKey, 'noiseKey chega ao banco');
  assert.ok(relido.signedPreKey, 'signedPreKey chega ao banco');
  assert.ok(relido.registrationId, 'registrationId chega ao banco');
  assert.ok(relido.me, 'me chega ao banco');
  console.log('   confirmado: a sessao gravada tem as chaves que o handshake exige');

  console.log('== 11. tentativa que nunca abre nao grava sessao ==');
  // O log do Render mostrava "Sessao gravada, versao: 3" e, um segundo
  // depois, "Conexao caiu, codigo: 515". Cada leitura de QR deixava uma sessao
  // no banco mesmo tendo falhado, e a tentativa seguinte recarregava uma
  // identidade que o WhatsApp ja tinha recusado.
  //
// Sessao que nunca abriu nao e sessao: e rascunho, e rascunho nao vai para o
  // banco.
  //
  // O marcador de mudanca aqui e `accountSyncCounter`, e nao `me`: o `me.id` e o
  // que o WhatsApp preenche no `pair-success`, e uma sessao que ja tem numero
  // TEM de poder ir para o banco mesmo antes da conexao abrir. Usar `me` como
  // "algo mudou" esconderia justamente o caso que o passo 19 cobre.
  const { SessaoNaApi } = await import('./src/sessao-api.js');
  const rascunho = new SessaoNaApi();

  assert.equal(rascunho.foiConfirmada(), false, 'comeca nao confirmada');

  rascunho.paraBaileys();
  rascunho.marcarCredenciaisAlteradas({ accountSyncCounter: 1 });

  assert.equal(rascunho.credenciaisAlteradas, true, 'a mudanca fica em memoria');
  assert.equal(rascunho.temIdentidade(), false, 'e o rascunho ainda nao tem numero');
  assert.equal(rascunho.timer, null, 'mas nao agendou gravacao: sem timer pendente');
  console.log('   confirmado: rascunho nao agendou gravacao');

  console.log('== 12. tentativa que cai sem abrir e descartada ==');
  rascunho.descartarRascunho();

  assert.equal(rascunho.credenciais, null, 'a identidade do rascunho foi embora');
  assert.equal(rascunho.credenciaisAlteradas, false, 'nada pendente');
  assert.equal(rascunho.foiConfirmada(), false, 'continua nao confirmada');

  // A proxima tentativa precisa comecar do zero, e nao reaproveitar o que o
  // WhatsApp recusou.
  rascunho.paraBaileys();
  assert.ok(rascunho.credenciais.noiseKey, 'a nova tentativa gera chaves novas');
  console.log('   confirmado: a proxima tentativa comeca do zero');

  console.log('== 13. sessao confirmada e a que vai para o banco ==');
  const confirmada = new SessaoNaApi();

  confirmada.paraBaileys();
  assert.equal(confirmada.confirmar(), true, 'a primeira confirmacao e a que importa');
  assert.equal(confirmada.confirmar(), false, 'confirmar de novo nao e a primeira vez');

  assert.equal(confirmada.foiConfirmada(), true, 'confirmada');
  assert.equal(confirmada.podeGravar(), true, 'pode ir para o banco');

  confirmada.marcarCredenciaisAlteradas({ me: { id: '5515999999999:1@s.whatsapp.net' } });
  assert.notEqual(confirmada.timer, null, 'a sessao confirmada agenda a gravacao');
  console.log('   confirmado: sessao aberta agenda gravacao');

  console.log('== 14. o armazenamento fala o pacote, e nao a chave solta ==');
  // O defeito que travava o pareamento. O Baileys 6.7 pede varias chaves de
  // uma vez e devolve varias de uma vez:
  //
  //   const { [keyId]: key } = await keys.get('pre-key', [keyId]);
  //   await keys.set({ session: { [id]: ... } });
  //
  // O armazenamento estava com o contrato da versao antiga, que era o inverso:
  // `get(tipo, id)` devolvendo um valor e `set(tipo, id, valor)`. Com o contrato
  // velho em cima do Baileys novo, o `set` gravava a chave
  // "[object Object]:undefined" e o `get` devolvia undefined para toda
  // leitura. O pre-key sumia, o handshake nao fechava, e o sintoma era a
  // conexao caindo em segundos: parecia rede, e nao era.
  const comChaves = new SessaoNaApi();
  comChaves.confirmar();
  const { keys: chaves } = comChaves.paraBaileys();

  // Exactamente como o libsignal.js do Baileys chama.
  await chaves.set({ 'pre-key': { 'abc123': bufferDoNode.from('pre-key-de-teste') } });

  const lidas = await chaves.get('pre-key', ['abc123']);

  assert.equal(
    typeof lidas,
    'object',
    'get tem de devolver um dicionario, e nao um valor solto'
  );
  assert.ok(lidas.abc123, 'a chave volta no dicionario, e nao undefined');
  assert.equal(lidas.abc123.toString(), 'pre-key-de-teste', 'e com o valor certo');
  console.log('   confirmado: get devolve dicionario e set grava pelo tipo e id');

  console.log('== 15. varias chaves num pacote so, e nao uma por vez ==');
  // E o que o upload de pre-keys faz: um pacote com dezenas de entradas.
  const lote = {};

  for (let i = 0; i < 30; i++) {
    lote[i] = bufferDoNode.from(`pre-key-${i}`);
  }

  await chaves.set({ 'pre-key': lote });

  const releitura = await chaves.get('pre-key', Object.keys(lote));

  assert.equal(Object.keys(releitura).length, 30, 'as 30 chaves voltaram');
  assert.equal(releitura['17'].toString(), 'pre-key-17', 'e na ordem certa');
  console.log('   confirmado: lote de 30 chaves gravado e lido inteiro');

  console.log('== 16. chave que o Baileys manda apagar some mesmo ==');
  // O Baileys apaga pre-key consumido com `set({ 'pre-key': { [id]: null } })`.
  // Se null fosse guardado como valor, o Signal tentaria decifrar com ele.
  await chaves.set({ 'pre-key': { 'abc123': null } });

  const depoisDeApagar = await chaves.get('pre-key', ['abc123']);

  assert.equal(
    depoisDeApagar.abc123,
    undefined,
    'a chave apagada nao aparece no dicionario'
  );
  assert.ok(!comChaves.chaves.has('pre-key:abc123'), 'e some do armazenamento interno');
  console.log('   confirmado: null apaga a chave, em vez de guardar null');

  console.log('== 17. as chaves sobrevivem a ida e volta pelo banco ==');
  // O ponto que justifica a sessao estar no banco: o servico dorme, acorda, e
  // tem que voltar com as chaves de sinal. As credenciais ja tinham este
  // teste; as chaves nao, e eram exatamente as que sumiam.
  const { serializarChaves, lerChaves } = await import('./src/sessao-api.js');

  const chavesNoBanco = serializarChaves(releitura);
  const chavesVoltas = lerChaves(chavesNoBanco);

  assert.equal(Object.keys(chavesVoltas).length, 30, 'as 30 chaves voltaram do banco');
  assert.ok(Buffer.isBuffer(chavesVoltas['7']), 'e voltaram como Buffer, nao como objeto');
  assert.equal(chavesVoltas['7'].toString(), 'pre-key-7', 'com os bytes intactos');
  console.log('   confirmado: as chaves de sinal sobreviveram ao banco');

  console.log('== 18. gravacao manda o pacote inteiro, e nao so o delta ==');
  // A API substitui o blob de chaves inteiro a cada gravacao
  // (`RepositorioDeSessaoWhatsApp` faz `sessao.Chaves = chaves`) e nao mescla.
  // Mandar so o que mudou nesta rodada apagava o resto: o banco terminava com
  // as ultimas chaves e as anteriores sumiam a cada gravacao. Era a mesma
  // falha da sessao, so que silenciosa - e era o que impedia a sessao de
  // sobreviver a um sono do servico.
  let pacoteRecebido = null;
  const apiQueSubstitui = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();

      return;
    }

    let corpo = '';
    req.on('data', parte => (corpo += parte));
    req.on('end', () => {
      pacoteRecebido = JSON.parse(JSON.parse(corpo).chaves);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ gravado: true, versao: 1 }));
    });
  });

  const portaDoSubstituto = 3195;
  await new Promise(resolve => apiQueSubstitui.listen(portaDoSubstituto, '127.0.0.1', resolve));

  const processoAnterior = process.env.URL_DA_API;
  process.env.URL_DA_API = `http://127.0.0.1:${portaDoSubstituto}`;

  const paraGravar = new SessaoNaApi();
  paraGravar.confirmar();
  const { keys: chavesParaGravar } = paraGravar.paraBaileys();

  // Duas rodadas de gravacao, como o servico faz a cada dois minutos.
  await chavesParaGravar.set({ 'pre-key': { a: bufferDoNode.from('a') } });
  await paraGravar.gravar();

  await chavesParaGravar.set({ 'pre-key': { b: bufferDoNode.from('b') } });
  await paraGravar.gravar();

  assert.equal(
    Object.keys(pacoteRecebido).length,
    2,
    'a segunda gravacao mandou as duas chaves, e nao so a que mudou'
  );
  assert.ok(pacoteRecebido['pre-key:a'], 'a chave antiga continua no pacote');
  assert.ok(pacoteRecebido['pre-key:b'], 'a chave nova entrou no pacote');

  // O agendamento do passo anterior ainda esta de pe; sem isso ele dispara
  // depois que a API de mentira ja foi fechada e suja o log do teste.
  if (paraGravar.timer !== null) {
    clearTimeout(paraGravar.timer);
    paraGravar.timer = null;
  }

  apiQueSubstitui.close();
  process.env.URL_DA_API = processoAnterior;
  console.log('   confirmado: a gravacao leva o pacote inteiro, nada se perde');

  console.log('== 19. o pareamento feito nao e descartado como rascunho ==');
  // O defeito que impedia o celular de conectar. No `pair-success` o WhatsApp
  // entrega as credenciais com o `me.id` e manda reiniciar a conexao (515).
  // A conexao so chama `confirmar()` no `open`, que vem DEPOIS desse reinicio.
  //
  // Entre um evento e outro, `foiConfirmada()` era falso. A sessao era
  // descartada como rascunho e o que o celular acabou de conquistar se perdia:
  // o celular escaneava, o WhatsApp aceitava, e o servico voltava a pedir QR.
  // O sintoma era o celular ficar muito tempo "tentando conectar".
  const pareada = new SessaoNaApi();
  pareada.paraBaileys();

  assert.equal(pareada.temIdentidade(), false, 'antes de escanear nao ha identidade');
  assert.equal(pareada.podeGravar(), false, 'e nao pode ir para o banco');

  // O que o Baileys entrega no pair-success.
  pareada.marcarCredenciaisAlteradas({
    me: { id: '5511999999999:1@s.whatsapp.net', name: 'Lumi Makeup' },
    account: { accountSignatureKey: 'chave' }
  });

  assert.equal(pareada.temIdentidade(), true, 'o me.id marca o pareamento como feito');
  assert.equal(
    pareada.podeGravar(),
    true,
    'pareamento feito tem de poder ir para o banco, mesmo antes do open'
  );
  assert.notEqual(pareada.timer, null, 'e a gravacao foi agendada na hora');
  console.log('   confirmado: o me.id libera a gravacao antes da conexao abrir');

  console.log('== 20. o 515 do WhatsApp nao vira perda de pareamento ==');
  // O 515 e o "restartRequired": o WhatsApp pedindo para a conexao recomecar
  // com o numero novo. Tratar isso como falha perdia o pareamento. O que
  // separa as duas situacoes e ter numero, nao o codigo.
  const depoisDo515 = new SessaoNaApi();
  depoisDo515.paraBaileys();
  depoisDo515.marcarCredenciaisAlteradas({ me: { id: '5511999999999:1@s.whatsapp.net' } });

  // Isto e o que o sessao.js faz no `close`: so descarta quando nao ha numero.
  if (!depoisDo515.podeGravar()) {
    depoisDo515.descartarRascunho();
  }

  assert.equal(
    depoisDo515.temIdentidade(),
    true,
    'com me.id a sessao sobreviveu a queda e ainda esta pareada'
  );
  assert.ok(depoisDo515.credenciais.me.id, 'o numero continua nas credenciais');
  console.log('   confirmado: a queda logo apos o pareamento nao apaga o numero');

  console.log('== 21. tentativa sem numero continua sendo descartada ==');
  // O outro lado da regra: o que nunca teve numero e rascunho mesmo, e precisa
  // recomecar do zero para nao herdar uma identidade que o WhatsApp recusou.
  const semNumero = new SessaoNaApi();
  semNumero.paraBaileys();
  semNumero.marcarCredenciaisAlteradas({ registrationId: 4321 });

  assert.equal(semNumero.temIdentidade(), false, 'sem me.id nao ha identidade');

  if (!semNumero.podeGravar()) {
    semNumero.descartarRascunho();
  }

  assert.equal(semNumero.credenciais, null, 'a identidade do rascunho foi embora');
  console.log('   confirmado: sem numero, a tentativa recomeca do zero');

  console.log('\nTodos os passos passaram.');
} finally {
  await limpar();
}
