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
    return {
      // Credenciais completas, nunca objeto vazio e nunca null.
      //
      // Numa sessao nova, o handshake Noise precisa do noiseKey para processar
      // a resposta do WhatsApp. Sem ele, o socket abre e fecha em segundos com
      // "error in validating connection", e o QR nunca aparece. Com null, o
      // processo morria antes disso, lendo 'me' de um objeto inexistente.
      //
      // Quem gera essas chaves e o proprio Baileys, em initAuthCreds(). Gerar
      // aqui seria reinventar um crypto delicateo na mao.
      creds: this.credenciais ?? initAuthCreds(),

      keys: {
        get: async (tipo, id) => {
          return this.chaves.get(`${tipo}:${id}`);
        },

        set: async (tipo, id, valor) => {
          this.chaves.set(`${tipo}:${id}`, valor);
          this.chavesAlteradas.add(`${tipo}:${id}`);
          this.chavesRemovidas.delete(`${tipo}:${id}`);
          this.marcarGravacao();
        },

        clear: async () => {
          for (const chave of this.chaves.keys()) {
            this.chavesRemovidas.add(chave);
          }

          this.chaves.clear();
          this.chavesAlteradas.clear();
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
   */
  marcarCredenciaisAlteradas(alteracoes) {
    this.credenciais = { ...(this.credenciais ?? {}), ...(alteracoes ?? {}) };
    this.credenciaisAlteradas = true;
    this.marcarGravacao();
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

    if (!this.credenciaisAlteradas && this.chavesAlteradas.size === 0 && this.chavesRemovidas.size === 0) {
      return;
    }

    this.gravando = true;

    const { urlDaApi, segredo } = configuracao();

    const alterados = {};

    for (const chave of this.chavesAlteradas) {
      alterados[chave] = this.chaves.get(chave);
    }

    try {
      const resposta = await fetch(`${urlDaApi}/api/whatsapp-sessao`, {
        method: 'POST',
        headers: { 'x-segredo': segredo, 'content-type': 'application/json' },
        body: JSON.stringify({
          versaoEsperada: this.versao,
          credenciais: serializarCredenciais(this.credenciais),
          chaves: serializarChaves(alterados)
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

      registrar('info', 'Sessao gravada.', { versao: this.versao, chaves: Object.keys(alterados).length });
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
