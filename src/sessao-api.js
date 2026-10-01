import { Buffer } from 'node:buffer';
import { initAuthCreds } from 'baileys';

/**
 * Fala com a API para guardar e recuperar a sessao do WhatsApp.
 *
 * POR QUE A SESSAO FICA NO BANCO E NAO EM ARQUIVO
 *
 * Este servico roda no Render, no plano gratuito, que nao tem disco
 * persistente. Se a sessao ficasse em arquivo, cada sono do servico apagaria
 * o pareamento e a loja teria que escanear QR de novo - e o WhatsApp bloqueia
 * QR repetido com frequencia. Perder a sessao e perder o numero.
 *
 * POR QUE O NODE NAO FALA COM O BANCO DIRETO
 *
 * O MySQL da loja fica fechado para a internet, e nao deveria abrir. O Render
 * nao recebe credencial de banco, e o Node apenas pede a sessao a API e
 * devolve o que mudou. Se a sessao vazar, o estrago e o acesso a conta do
 * WhatsApp - nao a tabela de pedidos.
 *
 * DELTA, E NAO SNAPSHOT
 *
 * O Baileys chama set() de chave a cada mensagem. Mandar a sessao inteira a
 * cada gravacao encheria a rede de bytes que nao mudaram. Aqui so vai o que
 * foi alterado desde a ultima gravacao confirmada.
 */

const intervaloDeGravacaoEmMs = Number(process.env.INTERVALO_DE_GRAVACAO_EM_MS ?? 120000);

/**
 * Falha de configuracao: falta variavel de ambiente.
 *
 * E separada de outras falhas porque o conserto e diferente. Variavel de
 * ambiente so existe no boot do processo: repetir a chamada nao resolve, e o
 * log ia encher de "nova tentativa em 60s" sem chance de dar certo. Quem
 * resolve e a pessoa, cadastrando a variavel no painel do Render.
 */
export class ErroDeConfiguracao extends Error {
  constructor(quais) {
    super(
      `Faltam variaveis de ambiente: ${quais.join(', ')}. ` +
      'Cadastre em Render > Environment e faca um novo deploy. Repetir nao resolve, ' +
      'porque variavel de ambiente so e lida no boot do processo.'
    );

    this.name = 'ErroDeConfiguracao';
    this.ausentes = quais;
  }
}

/**
 * Le as configuracoes a cada uso, e nao no carregamento do modulo.
 *
 * Ler uma vez no topo e um erro silencioso: em teste, quem importa o modulo
 * depois de subir o servico pega string vazia e falha com "Invalid URL", que
 * nao diz nada. Aqui a falha vira a mensagem que diz o que falta.
 */
function configuracao() {
  const ausentes = [];

  const urlDaApi = (process.env.URL_DA_API ?? '').replace(/\/+$/, '');
  const segredo = process.env.BAILEYS_SEGREDO_COMPARTILHADO ?? '';

  if (!urlDaApi) {
    ausentes.push('URL_DA_API');
  }

  if (!segredo) {
    ausentes.push('BAILEYS_SEGREDO_COMPARTILHADO');
  }

  if (ausentes.length > 0) {
    throw new ErroDeConfiguracao(ausentes);
  }

  return { urlDaApi, segredo };
}

function registrar(nivel, mensagem, extra = {}) {
  console.log(JSON.stringify({
    em: new Date().toISOString(),
    nivel,
    mensagem,
    ...extra
  }));
}

export class SessaoNaApi {
  constructor() {
    /** Blob de credenciais, como o Baileys devolve. */
    this.credenciais = null;

    /** Chaves de sinal, como um objeto simples: id -> valor. */
    this.chaves = new Map();

    /** A versao que a API tinha quando lemos. E o controle de conflito. */
    this.versao = 0;

    /** O que mudou desde a ultima gravacao confirmada. */
    this.credenciaisAlteradas = false;
    this.chavesAlteradas = new Set();
    this.chavesRemovidas = new Set();

    this.timer = null;
    this.gravando = false;
  }

  /**
   * Busca a sessao guardada.
   *
   * Devolve false quando ainda nao ha sessao: e o sinal de que o numero precisa
   * ser pareado com QR.
   */
  async carregar() {
    const { urlDaApi, segredo } = configuracao();

    const resposta = await fetch(`${urlDaApi}/api/whatsapp-sessao`, {
      headers: { 'x-segredo': segredo }
    });

    if (!resposta.ok) {
      throw new Error(`A API respondeu ${resposta.status} ao pedir a sessao.`);
    }

    const corpo = await resposta.json();

    if (!corpo.existe) {
      registrar('aviso', 'Nenhuma sessao no banco. O numero precisa ser pareado com QR.');

      return false;
    }

    this.versao = corpo.versao ?? 0;
    this.credenciais = lerCredenciais(corpo.credenciais);
    this.chaves = new Map(Object.entries(lerChaves(corpo.chaves)));

    registrar('info', 'Sessao carregada do banco.', { versao: this.versao, chaves: this.chaves.size });

    return true;
  }

  /**
   * O formato que o Baileys espera: credenciais e um armazenamento de chaves.
   *
   * O armazenamento guarda tudo em memoria e devolve o que mudou. O Baileys
   * chama get() o tempo todo, entao um get que fosse a API transformaria cada
   * mensagem em uma ida e volta pela rede.
   */
  paraBaileys() {
    // As credenciais iniciais precisam ser GUARDADAS, e nao so entregues.
    //
    // Este era o bug que faltava. As chaves eram geradas aqui e devolvidas ao
    // Baileys, mas ficavam fora deste objeto. Quando o creds.update chegava
    // com so os campos alterados, a fusao partia de null e produzia uma sessao
    // com account, me e platform - e sem noiseKey, sem signedPreKey, sem
    // signalIdentityKey. Era exatamente o que aparecia no banco, e a sessao
    // salva nao conseguia fazer o handshake: o servico carregava, caia, e
    // repetia para sempre.
    if (!this.credenciais) {
      this.credenciais = initAuthCreds();
    }

    return {
      // Nunca null, e nunca objeto vazio: o Baileys le creds.me logo apos
      // criar o socket, e o handshake Noise precisa do noiseKey.
      creds: this.credenciais,

      /**
       * CONTRATO DE LOTE, E NAO DE CHAVE UNICA
       *
       * O Baileys 6.7 fala com o armazenamento em pacote: pede varias chaves de
       * uma vez e devolve varias de uma vez. A interface e'
       *
       *   get(tipo, ids)  ->  { [id]: valor }
       *   set({ tipo: { [id]: valor } })
       *
       * A versao antiga deste metodo aceitava `get(tipo, id)` devolvendo um
       * valor solto e `set(tipo, id, valor)`. Com o contrato velho em cima do
       * Baileys novo, nada quebrava alto: o `set` recebia o pacote inteiro
       * como se fosse o `tipo` e gravava a chave "[object Object]:undefined",
       * e o `get` recebia um array no lugar do id e devolvia `undefined` para
       * toda leitura.
       *
       * O pre-key sumia, o handshake nao fechava, e o sintoma era a conexao
       * caindo em segundos e o numero nunca pareando - coisa que parece
       * problema de rede ou de servidor, e nao e.
       *
       * Aparece em `libsignal.js` do proprio Baileys:
       *
       *   const { [keyId]: key } = await keys.get('pre-key', [keyId]);
       *   await keys.set({ session: { [id]: ... } });
       */
      keys: {
        get: async (tipo, ids) => {
          const encontradas = {};

          for (const id of ids) {
            const valor = this.chaves.get(`${tipo}:${id}`);

            // So devolve o que existe. Chave ausente e o jeito do Baileys
            // dizer "ainda nao tenho esta": devolve-la como null faria o
            // destructuring destravar e o Signal tentar decifrar com nada.
            if (valor !== undefined) {
              encontradas[id] = valor;
            }
          }

          return encontradas;
        },

        set: async pacote => {
          for (const tipo of Object.keys(pacote)) {
            for (const id of Object.keys(pacote[tipo])) {
              const valor = pacote[tipo][id];
              const chave = `${tipo}:${id}`;

              // null e o Baileys dizendo "apague esta chave". E assim que o
              // pre-key consumido sai do caminho, e o que mantem o
              // armazenamento do tamanho do numero de mensagens, e nao do
              // tamanho da conversa inteira.
              if (valor === null || valor === undefined) {
                this.chaves.delete(chave);
                this.chavesRemovidas.add(chave);
                this.chavesAlteradas.delete(chave);

                continue;
              }

              this.chaves.set(chave, valor);
              this.chavesAlteradas.add(chave);
              this.chavesRemovidas.delete(chave);
            }
          }

          this.marcarGravacao();
        }
      }
    };
  }

  /**
   * O Baileys chama isto a cada mudanca de credencial.
   *
   * FUSAO, E NAO SUBSTITUICAO. O evento creds.update chega com so os campos que
   * mudaram. Substituir o objeto inteiro perdia noiseKey, signedPreKey e
   * signalIdentityKey na primeira atualizacao parcial, e a sessao gravada ficava
   * sem as chaves de que o handshake precisa. O sintoma era o servico cair a
   * cada 3 segundos, sem QR nunca.
   *
   * A gravacao so agenda se a conexao ja foi confirmada. Antes disso, o que
   * chega aqui e rascunho de uma tentativa, e rascunho nao vai para o banco:
   * cada leitura de QR deixava uma sessao gravada mesmo tendo falhado, e a
   * tentativa seguinte recarregava uma identidade que nunca funcionou.
   */
  marcarCredenciaisAlteradas(alteracoes) {
    this.credenciais = { ...(this.credenciais ?? {}), ...(alteracoes ?? {}) };
    this.credenciaisAlteradas = true;

    if (this.podeGravar()) {
      this.marcarGravacao();
    }
  }

  /**
   * O WhatsApp ja aceitou o numero e entregou a identidade dele.
   *
   * E o `me.id` das credenciais, que o Baileys preenche em
   * `configureSuccessfulPairing` no exato instante em que o celular escaneia o
   * QR. `initAuthCreds` nao cria `me`, entao a ausencia dele significa que o
   * pareamento nao chegou a acontecer.
   *
   * Existe separada de `foiConfirmada()` porque as duas coisas acontecem em
   * momentos diferentes, e o intervalo entre elas e' justamente onde o
   * pareamento se perdia.
   */
  temIdentidade() {
    return Boolean(this.credenciais?.me?.id);
  }

  /**
   * Decida se a sessao atual pode ir para o banco.
   *
   * Base e uma funcao externa porque o estado da conexao vive no sessao.js, e
   * a sessao-api nao deve conhecer esse detalhe.
   *
   * VALE QUANDO O NUMERO JA EXISTE, E NAO SO QUANDO A CONEXAO ABRIU
   *
   * O `pair-success` faz o Baileys entregar as credenciais com o `me.id` e,
   * logo em seguida, o servidor manda reiniciar a conexao (515). A conexao
   * so marca `confirmar()` no `open`, que vem DEPOIS desse reinicio.
   *
   * Entre um evento e outro, `foiConfirmada()` era falso. Com a trava aqui, o
   * pareamento que dera certo nao ia para o banco e era descartado como
   * rascunho: o celular escaneava, o WhatsApp aceitava, e o servico voltava a
   * pedir QR. Era o que o celular nunca conseguia conectar.
   */
  podeGravar() {
    return this.foiConfirmada() || this.temIdentidade();
  }

  /** A sessao foi marcada como confirmada pela conexao aberta. */
  foiConfirmada() {
    return this._confirmada === true;
  }

  /**
   * A conexao abriu de verdade: a partir daqui a sessao vale e vai para o banco.
   */
  confirmar() {
    const primeiraVez = this._confirmada !== true;

    this._confirmada = true;

    return primeiraVez;
  }

  /**
   * A tentativa nao chegou a abrir: o rascunho e descartado.
   *
   * Sem isto, a proxima tentativa recomecaria a partir de uma identidade que o
   * WhatsApp ja recusou, e o 408 de conflito se repetiria. Comecar do zero e o
   * que devolve a chance de parear.
   */
  descartarRascunho() {
    this._confirmada = false;
    this.credenciais = null;
    this.credenciaisAlteradas = false;
    this.chavesAlteradas.clear();
    this.chavesRemovidas.clear();

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Agenda a gravacao.
   *
   * Agrupa varias mudancas em uma ida so. O Baileys altera credenciais varias
   * vezes seguidas no handshake, e gravar a cada uma seria trafego inutil.
   */
  marcarGravacao() {
    if (this.timer !== null) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.gravar().catch(erro => {
        registrar('erro', 'Falha ao gravar a sessao.', { erro: String(erro) });
      });
    }, intervaloDeGravacaoEmMs);

    // Nao segura o processo vivo so por causa do timer.
    this.timer.unref?.();
  }

  /**
   * Grava o que mudou.
   *
   * 409 significa que outro contêiner escreveu depois que este leu. A resposta
   * certa e recarregar, nao insistir: o contêiner antigo, num redesplie, tentaria
   * sobrescrever a sessao recem-construida e apagaria o pareamento.
   */
  async gravar() {
    if (this.gravando || !this.credenciais) {
      return;
    }

    // Trava final, aqui e nao so no agendamento: e o ultimo ponto onde um
    // rascunho poderia escapar para o banco.
    if (!this.podeGravar()) {
      return;
    }

    if (!this.credenciaisAlteradas && this.chavesAlteradas.size === 0 && this.chavesRemovidas.size === 0) {
      return;
    }

    this.gravando = true;

    const { urlDaApi, segredo } = configuracao();

    /**
     * O PACOTE INTEIRO, E NAO SO O QUE MUDOU NESTA RODADA
     *
     * A API substitui o blob de chaves inteiro a cada gravacao
     * (`RepositorioDeSessaoWhatsApp` faz `sessao.Chaves = chaves`), e nao
     * mescla. Mandar so o delta apagava tudo o que ja estava gravado: o banco
     * terminava com as ultimas chaves e o resto sumia a cada gravacao.
     *
     * O custo e o mesmo das credenciais, que ja iam inteiras: algumas centenas
     * de entradas pequenas, uma gravacao a cada dois minutos. E o que mantem a
     * sessao util depois de um sono do servico, que e o motivo dela estar no
     * banco.
     */
    const pacote = {};

    for (const [chave, valor] of this.chaves) {
      pacote[chave] = valor;
    }

    try {
      const resposta = await fetch(`${urlDaApi}/api/whatsapp-sessao`, {
        method: 'POST',
        headers: { 'x-segredo': segredo, 'content-type': 'application/json' },
        body: JSON.stringify({
          versaoEsperada: this.versao,
          credenciais: serializarCredenciais(this.credenciais),
          chaves: serializarChaves(pacote)
        })
      });

      if (resposta.status === 409) {
        registrar('aviso', 'Outro contêiner gravou a sessao. Recarregando do banco.');

        await this.carregar().catch(erro => {
          registrar('erro', 'Falha ao recarregar a sessao.', { erro: String(erro) });
        });

        return;
      }

      if (!resposta.ok) {
        registrar('erro', `A API respondeu ${resposta.status} ao gravar a sessao.`);

        return;
      }

      const corpo = await resposta.json();

      this.versao = corpo.versao ?? this.versao + 1;
      this.credenciaisAlteradas = false;
      this.chavesAlteradas.clear();
      this.chavesRemovidas.clear();

      registrar('info', 'Sessao gravada.', { versao: this.versao, chaves: Object.keys(pacote).length });
    } finally {
      this.gravando = false;
    }
  }

  /**
   * Pede a API para apagar a sessao.
   *
   * Usado quando o WhatsApp desconecta o numero de proposito. Sem isso o Node
   * ficaria tentando reconectar com credenciais que a Meta invalidou, e nem QR
   * nem envio voltariam.
   */
  async apagar() {
    try {
      const { urlDaApi, segredo } = configuracao();

      await fetch(`${urlDaApi}/api/whatsapp-sessao/apagar`, {
        method: 'POST',
        headers: { 'x-segredo': segredo }
      });

      this.credenciais = null;
      this.chaves.clear();
      this.versao = 0;

      registrar('aviso', 'Sessao apagada. O proximo QR sera para um novo pareamento.');
    } catch (erro) {
      registrar('erro', 'Falha ao apagar a sessao.', { erro: String(erro) });
    }
  }

  /**
   * Grava o que pendente, para nada se perder.
   *
   * Chamado no SIGTERM. O Render da alguns segundos antes de matar o
   * contêiner, e e essa janela que salva a sessao quando o servico reinicia.
   */
  async gravarPendentes() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.gravar();
  }
}

/**
 * Instancia unica.
 *
 * A sessao usa esta para conectar e gravar; o encerramento usa a mesma para
 * esvaziar o que estiver pendente. Duas instancias significariam duas versoes
 * da sessao em memoria, e a gravacao dexitual iria para o objeto errado.
 */
export const sessaoNaApi = new SessaoNaApi();

/**
 * JSON que preserva Buffer.
 *
 * As chaves de criptografia do Baileys sao Buffer, e Buffer nao sobrevive a um
 * JSON. O JSON.stringify transforma em {"type":"Buffer","data":[...]} e o
 * parse devolve um objeto comum, nao um Buffer. O handshake Noise opera sobre
 * bytes: com objeto no lugar do Buffer, a conexao fecha em segundos e o
 * sintoma e "error in validating connection", sem nenhuma pista de que o
 * problema era a serializacao.
 *
 * O marcador abaixo existe para reidratar o Buffer na volta. Um campo que
 * happen de ser {tipo:'Buffer'} vira Buffer tambem, o que recupera sessoes
 * gravadas antes desta correcao.
 */
const MARCADOR = '__bytesBuffer';

function bufferParaJson(chave, valor) {
  if (Buffer.isBuffer(valor)) {
    return { [MARCADOR]: valor.toString('base64') };
  }

  // Uint8Array e ArrayBuffer aparecem em campos binarios de versoes mais
  // novas do Baileys.
  if (valor instanceof Uint8Array) {
    return { [MARCADOR]: Buffer.from(valor).toString('base64') };
  }

  return valor;
}

function jsonParaBuffer(chave, valor) {
  if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
    if (typeof valor[MARCADOR] === 'string') {
      return Buffer.from(valor[MARCADOR], 'base64');
    }

    if (valor.type === 'Buffer' && Array.isArray(valor.data)) {
      return Buffer.from(valor.data);
    }
  }

  return valor;
}

export function serializarCredenciais(credenciais) {
  return JSON.stringify(credenciais, bufferParaJson);
}

export function lerCredenciais(texto) {
  return texto ? JSON.parse(texto, jsonParaBuffer) : null;
}

export function serializarChaves(objeto) {
  return JSON.stringify(objeto, bufferParaJson);
}

export function lerChaves(texto) {
  return texto ? JSON.parse(texto, jsonParaBuffer) : {};
}

export { Buffer };
