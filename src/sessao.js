import makeWASocket, { DisconnectReason, useMultiFileAuthState } from 'baileys';
import QRCode from 'qrcode';

/**
 * Sessão do Baileys.
 *
 * Guarda a autenticação em disco, porque o número é da loja e a sessão não pode
 * ser refeita a cada reinício: refazer exigiria escanear QR de novo, e o
 * WhatsApp bloqueia QR repetido com frequência.
 *
 * Esta sessão é **somente envio**. Não marca mensagem como lida, não sincroniza
 * histórico e não processa mensagem recebida. A loja precisa avisar o cliente do
 * pedido; quem responde é a administradora, no WhatsApp dela.
 */

const pastaDeDados = process.env.PASTA_DE_DADOS ?? './dados';
const silencioso = process.env.BAILEYS_SILENCIOSO === 'true';

let conexao = null;
let aberto = false;
let qrAtual = null;
let numeroAtual = null;
let conectadoDesde = null;
let ultimoEnvioEm = null;
let conectando = null;

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
      const { state, saveCreds } = await useMultiFileAuthState(`${pastaDeDados}/autenticacao`);

      const socket = makeWASocket({
        auth: state,
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

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          qrAtual = qr;
          registrar('info', 'QR disponivel. Abra a tela de pareamento.');
        }

        if (connection === 'open') {
          qrAtual = null;
          aberto = true;
          numeroAtual = numeroDoJid(socket.user?.id);
          conectadoDesde = new Date().toISOString();
          registrar('info', 'Numero pareado e conectado.', { numero: numeroAtual });
          return;
        }

        if (connection === 'close') {
          const codigo = lastDisconnect?.error?.output?.statusCode;
          qrAtual = null;
          aberto = false;
          numeroAtual = null;
          conexao = null;
          conectando = null;

          // 401 e o codigo do WhatsApp para "desconectado de proposito", e nao
          // um erro. Tratar como falha derrubaria o servico a cada restart.
          if (codigo === DisconnectReason.loggedOut) {
            registrar('erro', 'Numero desconectado do WhatsApp. Pareie de novo com o QR; se nao funcionar, o numero pode estar banido.');
            return;
          }

          registrar('aviso', 'Conexao caiu. Reconectando.', { codigo });

          // Espera antes de reconectar: sem isso, queda de rede vira laco de
          // reconexao que derruba o processo.
          setTimeout(() => {
            sessao.iniciar().catch(erro => {
              registrar('erro', 'Falha ao reconectar.', { erro: String(erro) });
            });
          }, 3000);
        }
      });
    })();

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
  }
};

function nomeAtual() {
  return conexao?.user?.name ?? null;
}
