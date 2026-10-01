import makeWASocket, { DisconnectReason } from 'baileys';
import QRCode from 'qrcode';
import { sessaoNaApi } from './sessao-api.js';

/**
 * Sessão do Baileys.
 *
 * A sessão fica no banco da API, e não em arquivo, porque este serviço roda no
 * Render no plano gratuito, que não tem disco persistente: um arquivo se perde
 * a cada sono do serviço, e refazer o pareamento exigiria QR novo — e o WhatsApp
 * bloqueia QR repetido com frequência.
 *
 * Esta sessão é **somente envio**. Não marca mensagem como lida, não sincroniza
 * histórico e não processa mensagem recebida. A loja precisa avisar o cliente do
 * pedido; quem responde é a administradora, no WhatsApp dela.
 */

const silencioso = process.env.BAILEYS_SILENCIOSO === 'true';

let conexao = null;
let aberto = false;
let qrAtual = null;
let numeroAtual = null;
let conectadoDesde = null;
let ultimoEnvioEm = null;
let conectando = null;

/**
 * Quantas quedas ja aconteceram sem sucesso no meio.
 *
 * Zera quando a conexao abre. E o que faz a espera crescer: reconectar sempre
 * no mesmo intervalo curto e o que o WhatsApp pune, com recusa por excesso de
 * tentativas.
 */
let reconnectando = 0;

/**
 * Quando foi iniciada a ultima conexao, para a trava de intervalo.
 *
 * Existe por causa do botao "Gerar novo QR": sem trava, cada clique criava uma
 * conexao e o WhatsApp passava a recusar o numero.
 */
let ultimoInicioDeConexao = 0;

/**
 * Ultimo codigo com que o WhatsApp fechou a conexao.
 *
 * Fica em escopo de modulo porque o log de "Conexao caiu" e escrito numa
 * funcao separada do tratamento do evento. Perder o codigo faria o log dizer
 * so "caiu", e codigo e o que distingue falha de rede de recusa do numero.
 */
let ultimoCodigoDeDesconexao = null;

const numeroDoJid = jid => (jid ? jid.split('@')[0] : null);

/**
 * Logger mudo com a interface que o Baileys espera.
 *
 * O Baileys e' do pino e chama logger.child({ class }) e os metodos de nivel.
 * Passar um objeto simples derruba a sessao na largada. Aqui child() devolve o
 * proprio logger, entao o silencio se propaga para os filhos que o Baileys cria.
 *
 * Os erros de verdade nao sao engolidos: quem falha e o proprio envio, e ele
 * devolve 502 com a mensagem. O que o Baileys chama de erro e o historico
 * interno do protocolo, que nao ajuda ninguem aqui.
 */
function loggerSilencioso() {
  const naoFazNada = () => {};

  const logger = {
    level: 'silent',
    trace: naoFazNada,
    debug: naoFazNada,
    info: naoFazNada,
    warn: naoFazNada,
    error: naoFazNada,
    fatal: naoFazNada,
    silent: naoFazNada
  };

  logger.child = () => logger;

  return logger;
}

/** Log simples, sem dependencia extra: o Baileys e' barulhento e o nivel dele fica separado. */
function registrar(nivel, mensagem, extra = {}) {
  if (silencioso) {
    return;
  }

  const linha = JSON.stringify({
    em: new Date().toISOString(),
    nivel,
    mensagem,
    ...extra
  });

  if (nivel === 'erro') {
    console.error(linha);
  } else {
    console.log(linha);
  }
}

export const sessao = {
  /**
   * Verdadeiro so depois que o WhatsApp disse "open".
   *
   * Nao pode ser `conexao !== null`: o socket existe desde o inicio, ainda
   * conectando. Se /enviar respondesse "pareado" nesse intervalo, a API
   * chamaria o envio e levaria 502, porque nao ha como escrever num socket
   * que ainda nao tem sessao negotiateada.
   */
  estaConectado() {
    return aberto;
  },

  numeroConectado() {
    return numeroAtual;
  },

  nomeConectado() {
    return nomeAtual();
  },

  inicioEm() {
    return conectadoDesde;
  },

  ultimoEnvioEm() {
    return ultimoEnvioEm;
  },

  /**
   * Conecta uma vez e reconecta sozinho.
   *
   * O reconexão automático importa: no restart do servidor, no deploy ou numa
   * queda de internet o número volta sem ninguém escanear QR.
   */
  async iniciar() {
    if (conectando) {
      return conectando;
    }

    conectando = (async () => {
      // Carrega a sessao do banco antes de criar o socket. Sem sessao, o
      // Baileys gera QR; com sessao, reconecta sozinho, e a loja nunca ve QR
      // depois da primeira vez.
      const jaPareado = await sessaoNaApi.carregar();

      registrar('info', jaPareado ? 'Sessao restaurada do banco.' : 'Sem sessao no banco: gerando QR.');

      const socket = makeWASocket({
        auth: sessaoNaApi.paraBaileys(),
        // O Baileys loga muito em info. Silencia-lo aqui e o que deixa o log
        // deste servico legivel: conexao, envio e erro, que sao os tres fatos
        // que importam.
        //
        // Precisa ser a interface do pino, nao um objeto qualquer: o Baileys
        // chama logger.child(...) e os metodos de log. Passar { level, child:
        // { level } } derruba a sessao na largada com "logger.child is not a
        // function", e o servico sobe sem WhatsApp nenhum.
        logger: loggerSilencioso(),
        // Le e nao. E o que mantem a loja sem superficie de leitura: sem marcar
        // como lida e sem sincronizar historico, este servico nao ve conversa
        // nenhuma.
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
      });

      conexao = socket;

      socket.ev.on('creds.update', credenciais => sessaoNaApi.marcarCredenciaisAlteradas(credenciais));

      // Tudo dentro do try, e nao so o agendamento do reconnect.
      //
      // Este handler e' a unica coisa que mantem o WhatsApp vivo: e ele quem
      // reagenda a proxima tentativa. Um erro de contabilidade aqui - por
      // exemplo ler um contador antes da declaracao - virava promessa rejeitada
      // e matava justamente a reconexao que ia consertar. O catch garante que
      // a proxima tentativa aconteca mesmo assim, e o log diz o que houve.
      socket.ev.on('connection.update', evento => {
        tratarAtualizacaoDeConexao(evento).catch(erro => {
          registrar('erro', 'Falha ao tratar a atualizacao de conexao.', { erro: String(erro) });

          try {
            agendarReconexao();
          } catch (erroInterno) {
            registrar('erro', 'Falha ao agendar a reconexao.', { erro: String(erroInterno) });
          }
        });
      });

      function agendarReconexao() {
        registrar('aviso', 'Conexao caiu. Reconectando.', { codigo: ultimoCodigoDeDesconexao });

        // Espera CRESCENTE, e nao um intervalo fixo. Reconectar sempre no mesmo
        // intervalo curto e o que o WhatsApp pune, com recusa por excesso de
        // tentativas. Foi o que aconteceu: o ciclo de 3 em 3 segundos esgotou a
        // paciencia do WhatsApp e o pareamento passou a ser recusado.
        const esperaEmSegundos = reconnectando++ === 0
          ? 3
          : Math.min(3 * 2 ** (reconnectando - 1), 120);

        registrar('aviso', `Nova tentativa de conexao em ${esperaEmSegundos}s.`);

        setTimeout(() => {
          sessao.iniciar().catch(erro => {
            registrar('erro', 'Falha ao reconectar.', { erro: String(erro) });
          });
        }, esperaEmSegundos * 1000);
      }

      async function tratarAtualizacaoDeConexao({ connection, lastDisconnect, qr }) {
        if (qr) {
          qrAtual = qr;
          registrar('info', 'QR disponivel. Abra a tela de pareamento.');
        }

        if (connection === 'open') {
          qrAtual = null;
          aberto = true;
          // Zera a espera crescente: a conexao voltou, e a proxima queda e um
          // evento novo, nao continuacao desta.
          reconnectando = 0;
          numeroAtual = numeroDoJid(socket.user?.id);
          conectadoDesde = new Date().toISOString();
          // A sessao so passa a valer aqui. Ate abrir, tudo o que o Baileys
          // mandou era rascunho de uma tentativa - e gravar rascunho enchia o
          // banco de sessoes que nunca funcionaram.
          const primeiraConexao = sessaoNaApi.confirmar();

          registrar('info', 'Numero pareado e conectado.', { numero: numeroAtual, primeiraConexao });

          if (primeiraConexao) {
            // Garante que a sessao confirmada va para o banco logo, e nao daqui a
            // dois minutos: se o Render adormecer ou o processo morrer antes, a
            // loja ainda teria de escanear QR de novo.
            sessaoNaApi.marcarGravacao();
          }

          return;
        }

        if (connection === 'close') {
          ultimoCodigoDeDesconexao = lastDisconnect?.error?.output?.statusCode;
          qrAtual = null;
          aberto = false;
          numeroAtual = null;
          // Zera tambem o "conectado desde". Sem isto, o painel mostrava uma
          // data de conexao logo abaixo de "desconectado", e a tela dizia que o
          // numero estava desligado ao mesmo tempo que affirmava desde quando
          // estava ligado. Duas informacoes que se contradizem, e a
          // contraditoria e o que fez a administradora achar que o
          // pareamento tinha funcionado.
          conectadoDesde = null;
          conexao = null;
          conectando = null;

          // 401 e o codigo do WhatsApp para "desconectado de proposito", e nao
          // um erro. Tratar como falha derrubaria o servico a cada restart.
          //
          // Fica antes do resto de proposito: e o unico desfecho em que a
          // sessao do banco tem mesmo de sumir. Todos os outros pedem
          // reconectar, nao apagar.
          if (ultimoCodigoDeDesconexao === DisconnectReason.loggedOut) {
            // Apaga a sessao do banco. Sem isso o Node ficaria tentando
            // reconectar com credenciais que a Meta invalidou, e nem QR nem
            // envio voltariam: o numero ficaria preso fora do ar.
            await sessaoNaApi.apagar();

            registrar('erro', 'Numero desconectado do WhatsApp. Pareie de novo com o QR; se nao funcionar, o numero pode estar banido.');
            return;
          }

          // GRAVAR ANTES DE RECONECTAR, E NAO DEPOIS
          //
          // A reconexao daqui recarrega a sessao do banco e sobrescreve o que
          // esta em memoria. Se o que o WhatsApp acabou de entregar ainda
          // estiver so na memoria, ele se perde: a gravacao normal espera dois
          // minutos, e a reconexao chega em segundos.
          //
          // E este o instante do `pair-success`: o WhatsApp entregou o `me.id`
          // e mandou reiniciar a conexao para aplicar o numero novo. Sem esta
          // gravacao immediate, o pareamento dava certo e era jogado fora - o
          // celular escaneava, o servico pedia QR de novo, e o ciclo se
          // repetia para sempre. Era o que o celular nunca conseguia conectar.
          await sessaoNaApi.gravarPendentes().catch(erro => {
            registrar('erro', 'Falha ao gravar a sessao antes de reconectar.', { erro: String(erro) });
          });

          // Tentativa que nunca chegou a ter numero deixa so um rascunho de
          // identidade. Descartar apenas nesse caso: uma sessao com `me.id` tem
          // o pareamento feito, e joga-la fora obrigaria a escanear QR de novo
          // de um numero que ja estava pareado.
          if (!sessaoNaApi.podeGravar()) {
            sessaoNaApi.descartarRascunho();

            registrar('aviso', 'A sessao nao chegou a abrir e foi descartada. A proxima tentativa comeca do zero.');
          } else if (sessaoNaApi.temIdentidade()) {
            registrar('info', 'O numero ja esta pareado. Gravado e reconectando com ele.');
          }

          agendarReconexao();
        }
      }
    })();


    // Libera o guard quando a tentativa falha.
    //
    // Sem isto, `conectando` fica apontando para uma promise rejeitada, e toda
    // nova chamada a iniciar() devolveria exatamente a mesma rejeicao. A
    // retentativa com espera existiria no papel e o WhatsApp nunca voltaria.
    conectando = conectando.catch(erro => {
      conectando = null;

      throw erro;
    });

    return conectando;
  },

  /**
   * Envia texto para um telefone em formato internacional, so digitos.
   *
   * O JID do WhatsApp e' o numero seguido de "@s.whatsapp.net". O sufixo nao
   * faz parte do numero e nunca deve ser montado pela API.
   */
  async enviar(para, texto) {
    if (!aberto || !conexao) {
      throw new Error('Sem conexao aberta com o WhatsApp.');
    }

    const jid = `${String(para).replace(/\D/g, '')}@s.whatsapp.net`;

    await conexao.sendMessage(jid, { text: texto });

    ultimoEnvioEm = new Date().toISOString();
    registrar('info', 'Mensagem enviada.', { para, tamanho: texto.length });

    return { para, enviadaEm: ultimoEnvioEm };
  },

  /**
   * QR como PNG em base64, para a tela de cadastro mostrar direto.
   *
   * Texto puro exigiria que a pessoa copiasse o codigo para algum leitor; em
   * tela e mais simples assim.
   */
  async obterQr() {
    if (qrAtual === null) {
      return null;
    }

    return QRCode.toDataURL(qrAtual, { margin: 1, width: 320 });
  },

  /**
   * Espera o QR aparecer, ate um limite.
   *
   * Forcar a reconexao derruba o socket, e o WhatsApp so responde com QR novo
   * alguns segundos depois. Ler na hora devolvia vazio, e o botao "Gerar novo QR"
   * parecia nao funcionar. A tela espera ate este limite e so então mostra o
   * aviso de "clique de novo".
   */
  async aguardarQr(limiteEmMs = 12000) {
    const inicio = Date.now();

    while (Date.now() - inicio < limiteEmMs) {
      if (qrAtual !== null) {
        return QRCode.toDataURL(qrAtual, { margin: 1, width: 320 });
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return null;
  },

  /**
   * Forca uma nova tentativa de conexao agora.
   *
   * Zera a espera crescente e derruba a conexao atual, se houver. Sem isso, o
   * botao "Gerar novo QR" da tela so releria o QR atual - e na janela entre uma
   * tentativa e outra nao existe socket, entao nao existiria QR para reler.
   *
   * A trava de intervalo protege o numero. Criar uma conexao por clique e o
   * caminho curto para o WhatsApp recusar o pareamento, que foi o que aconteceu
   * com a reconexao fixa de 3 segundos.
   *
   * Devolve o que o chamador precisa saber sem esperar: o QR chega pelo evento
   * de conexao, alguns segundos depois. E por isso que a espera e' assincrona
   * e a tela recarrega.
   */
  reconectar(intervaloMinimoEmSegundos = 20) {
    const agoraEmSegundos = Math.round(Date.now() / 1000);
    const ultimo = Date.now() / 1000 - (ultimoInicioDeConexao ?? 0);

    if (ultimoInicioDeConexao && ultimo < intervaloMinimoEmSegundos) {
      return {
        qr: qrAtual,
        aguardandoSegundos: Math.ceil(intervaloMinimoEmSegundos - ultimo)
      };
    }

    ultimoInicioDeConexao = agoraEmSegundos;
    reconnectando = 0;
    // Derruba o QR anterior: ele ja expirou ou foi recusado, e mostrar um QR
    // velho faz a leitura falhar sem nenhum motivo visivel.
    qrAtual = null;

    // Derruba a conexao pendente, se houver. O handler de 'close' agenda a
    // reconexao; zerar o contador antes garante a espera curta.
    if (conexao) {
      try {
        conexao.end(null);
      } catch {
        // A conexao pode ja estar morta. O 'close' faz o resto.
      }
    } else {
      conectando = null;
      sessao.iniciar().catch(erro => {
        registrar('erro', 'Falha ao forcar reconexao.', { erro: String(erro) });
      });
    }

    return { qr: qrAtual, aguardandoSegundos: 0 };
  }
};

function nomeAtual() {
  return conexao?.user?.name ?? null;
}
