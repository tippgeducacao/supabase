import { canonicalBrClassificacao, classificaTelefone, digitsTelefone } from '../_shared/telefone.ts';

export type EventoModulosPraticos = 'inscricao.criada' | 'inscricao.retroativa' | 'catalogo' | 'validar';
type Objeto = Record<string, unknown>;
export type PayloadModulosPraticos = { evento: 'catalogo' } | {
  evento: Exclude<EventoModulosPraticos, 'catalogo'>;
  inscricao_id: string;
  modulo_codigo: string;
  inscrito_em: string;
  contato: { nome: string; telefone?: string; email?: string; cpf?: string };
};

export interface ClienteModulosPraticos {
  rpc: (nome: string, argumentos: Objeto) => PromiseLike<{ data: unknown; error: unknown }>;
}

export interface LogModulosPraticos {
  evento: EventoModulosPraticos | null;
  resultado: 'criado' | 'existente' | 'validado' | 'catalogo' | 'erro';
  statusHttp: number;
  codigo: string | null;
}

export interface RespostaModulosPraticos {
  statusHttp: number;
  body: Objeto;
}

class ErroEntrada extends Error {
  constructor(public codigo: string, mensagem: string, public statusHttp = 400) {
    super(mensagem);
  }
}

function objeto(valor: unknown): valor is Objeto {
  return Boolean(valor) && typeof valor === 'object' && !Array.isArray(valor);
}

function camposPermitidos(valor: Objeto, permitidos: string[]) {
  if (Object.keys(valor).some(chave => !permitidos.includes(chave))) {
    throw new ErroEntrada('campo_nao_permitido', 'O corpo contém campos fora do contrato.');
  }
}

function texto(valor: unknown, campo: string, limite: number, opcional = false): string | undefined {
  if (valor === undefined && opcional) return undefined;
  if (typeof valor !== 'string' || !valor.trim() || valor.length > limite
    || [...valor].some(caractere => caractere.charCodeAt(0) < 32 || caractere.charCodeAt(0) === 127)) {
    throw new ErroEntrada('campo_invalido', `O campo ${campo} deve ser um texto preenchido de até ${limite} caracteres.`);
  }
  return valor.trim();
}

function normalizarData(valor: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(valor);
  if (!partes) throw new ErroEntrada('inscrito_em_invalido', 'inscrito_em deve conter data, hora e fuso: 2026-09-09T10:00:00-03:00.');
  const [ano, mes, dia, hora, minuto, segundo] = partes.slice(1, 7).map(Number);
  const bissexto = ano % 4 === 0 && (ano % 100 !== 0 || ano % 400 === 0);
  const dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const fuso = partes[7];
  const fusoValido = fuso === 'Z' || (Number(fuso.slice(1, 3)) <= 23 && Number(fuso.slice(4, 6)) <= 59);
  const instante = Date.parse(valor);
  if (ano < 1 || mes < 1 || mes > 12 || dia < 1 || dia > dias[mes - 1]
    || hora > 23 || minuto > 59 || segundo > 59 || !fusoValido || !Number.isFinite(instante)) {
    throw new ErroEntrada('inscrito_em_invalido', 'inscrito_em não contém uma data e hora válidas.');
  }
  // Mantém a precisão/fuso informados (created_at pode ter microssegundos).
  // PostgreSQL compara o instante, independentemente de +00:00 ou Z.
  return valor;
}

function normalizarCpf(valor: string): string {
  if (!/^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/.test(valor)) {
    throw new ErroEntrada('cpf_invalido', 'CPF deve conter 11 dígitos, com ou sem máscara.', 422);
  }
  const digitos = valor.replace(/\D/g, '');
  // Mesma régua de src/lib/vendas/cpf.ts; o deploy das edges não inclui src/.
  const verificador = (corte: number) => {
    let soma = 0;
    for (let i = 0; i < corte; i++) soma += Number(digitos[i]) * (corte + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  if (/^(\d)\1{10}$/.test(digitos) || verificador(9) !== Number(digitos[9]) || verificador(10) !== Number(digitos[10])) {
    throw new ErroEntrada('cpf_invalido', 'CPF inválido. Corrija o valor ou omita o campo se não foi informado.', 422);
  }
  return digitos;
}

/** Contrato estrito: não converte objetos/números em texto nem corta identificadores. */
export function validarPayloadModulosPraticos(payload: unknown): PayloadModulosPraticos {
  if (!objeto(payload)) throw new ErroEntrada('payload_invalido', 'Envie um objeto JSON.');
  const evento = texto(payload.evento, 'evento', 30);
  if (!['inscricao.criada', 'inscricao.retroativa', 'catalogo', 'validar'].includes(evento ?? '')) {
    throw new ErroEntrada('evento_invalido', 'Evento não reconhecido.');
  }
  if (evento === 'catalogo') {
    camposPermitidos(payload, ['evento']);
    return { evento };
  }
  camposPermitidos(payload, ['evento', 'inscricao_id', 'modulo_codigo', 'inscrito_em', 'contato']);
  const inscricaoId = texto(payload.inscricao_id, 'inscricao_id', 200)!;
  const moduloCodigo = texto(payload.modulo_codigo, 'modulo_codigo', 120)!;
  const inscritoEm = normalizarData(texto(payload.inscrito_em, 'inscrito_em', 40)!);
  if (!objeto(payload.contato)) throw new ErroEntrada('contato_invalido', 'contato deve ser um objeto.', 422);
  camposPermitidos(payload.contato, ['nome', 'telefone', 'email', 'cpf']);
  const contato: Extract<PayloadModulosPraticos, { inscricao_id: string }>['contato'] = {
    nome: texto(payload.contato.nome, 'contato.nome', 200)!,
  };
  const telefone = texto(payload.contato.telefone, 'contato.telefone', 40, true);
  const email = texto(payload.contato.email, 'contato.email', 254, true);
  const cpf = texto(payload.contato.cpf, 'contato.cpf', 14, true);
  if (telefone) {
    // O sinal + preserva DDI estrangeiro, inclusive números com comprimento BR.
    const classe = classificaTelefone(telefone);
    if (!/^\+?[\d\s().-]+$/.test(telefone) || (classe !== 'br' && classe !== 'internacional')) {
      throw new ErroEntrada('telefone_invalido', 'Telefone inválido. Informe DDD; para outro país, use + e o DDI.', 422);
    }
    contato.telefone = classe === 'br' ? canonicalBrClassificacao(telefone) : digitsTelefone(telefone);
  }
  if (email) {
    const [local, dominio, extra] = email.split('@');
    const partesDominio = dominio?.split('.') ?? [];
    if (extra !== undefined || !local || local.length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
      || local.startsWith('.') || local.endsWith('.') || local.includes('..') || partesDominio.length < 2
      || partesDominio.some(parte => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(parte))) {
      throw new ErroEntrada('email_invalido', 'E-mail inválido.', 422);
    }
    contato.email = email.toLowerCase();
  }
  if (cpf) contato.cpf = normalizarCpf(cpf);
  if (!contato.telefone && !contato.email && !contato.cpf) {
    throw new ErroEntrada('contato_sem_identificador', 'Informe telefone, e-mail ou CPF do contato.', 422);
  }
  return {
    evento: evento as Exclude<EventoModulosPraticos, 'catalogo'>,
    inscricao_id: inscricaoId, modulo_codigo: moduloCodigo, inscrito_em: inscritoEm, contato,
  };
}

const ERROS_NEGOCIO: Record<string, { status: number; mensagem: string }> = {
  inscricao_ignorada: { status: 422, mensagem: 'Inscrição excluída da integração por regra administrativa.' },
  integracao_inativa: { status: 403, mensagem: 'Esta integração está desativada.' },
  integracao_invalida: { status: 403, mensagem: 'A integração não está autorizada para módulos práticos.' },
  payload_invalido: { status: 400, mensagem: 'O corpo da inscrição é inválido.' },
  evento_invalido: { status: 400, mensagem: 'Evento não reconhecido.' },
  inscricao_invalida: { status: 400, mensagem: 'Confira os dados da inscrição.' },
  modulo_nao_encontrado: { status: 422, mensagem: 'Módulo não encontrado no catálogo desta integração.' },
  modulo_nao_mapeado: { status: 422, mensagem: 'Módulo não encontrado no catálogo desta integração.' },
  modulo_inativo: { status: 422, mensagem: 'O módulo não está disponível para inscrições.' },
  destino_invalido: { status: 422, mensagem: 'O destino do módulo precisa ser configurado no CRM.' },
  integracao_nao_configurada: { status: 422, mensagem: 'A integração de módulos práticos precisa ser configurada.' },
  contato_sem_identificador: { status: 422, mensagem: 'Informe um identificador válido do contato.' },
  contato_ambiguo: { status: 409, mensagem: 'Os identificadores informados correspondem a contatos diferentes.' },
  oportunidade_ambigua: { status: 409, mensagem: 'Existe mais de uma oportunidade para o contato neste destino. Revise o cadastro no CRM.' },
  conflito_inscricao: { status: 409, mensagem: 'O identificador da inscrição já foi usado com outros dados.' },
  inscricao_conflitante: { status: 409, mensagem: 'O identificador da inscrição já foi usado com outros dados.' },
};

function falha(codigo: string, mensagem: string, statusHttp: number): RespostaModulosPraticos {
  return { statusHttp, body: { ok: false, erro: codigo, mensagem, repetir: statusHttp >= 500 } };
}

function erroRpc(erro: unknown): RespostaModulosPraticos {
  if (objeto(erro) && erro.code === 'P0001' && typeof erro.message === 'string') {
    const codigo = erro.message.trim().toLowerCase();
    const conhecido = ERROS_NEGOCIO[codigo];
    if (conhecido) return falha(codigo, conhecido.mensagem, conhecido.status);
  }
  // Erros SQL podem conter contato, constraints e contexto interno: nada disso
  // entra na resposta/log. Erro desconhecido é transitório para permitir retry.
  return falha('falha_interna', 'Não foi possível processar agora. Tente novamente.', 500);
}

/** Executado apenas após o index autenticar a integração opt-in. */
export async function processarWebhookModulosPraticos({ integracaoId, payload, cliente, registrarLog }: {
  integracaoId: string;
  payload: unknown;
  cliente: ClienteModulosPraticos;
  registrarLog?: (evento: LogModulosPraticos) => void | Promise<void>;
}): Promise<RespostaModulosPraticos> {
  let evento: EventoModulosPraticos | null = null;
  let resposta: RespostaModulosPraticos;
  try {
    const normalizado = validarPayloadModulosPraticos(payload);
    evento = normalizado.evento;
    const { data, error } = evento === 'catalogo'
      ? await cliente.rpc('crm_modulos_praticos_catalogo', { p_integracao_id: integracaoId })
      : await cliente.rpc('crm_modulos_praticos_receber', {
        p_integracao_id: integracaoId, p_payload: normalizado, p_validar: evento === 'validar',
      });
    if (error) resposta = erroRpc(error);
    else if (evento === 'catalogo' && objeto(data) && data.ok === true && Array.isArray(data.modulos)
      && data.modulos.every(modulo => objeto(modulo) && typeof modulo.codigo === 'string' && typeof modulo.nome === 'string')) {
      // Catálogo contém só módulos/destinos. Nunca repassa objetos de contato.
      const campos = ['codigo', 'nome', 'ano', 'modulo_codigo', 'modulo_id', 'funil_id', 'funil_nome', 'etapa_id', 'etapa_nome', 'ativo'];
      const modulos = (data.modulos as Objeto[]).map(modulo => Object.fromEntries(
        campos.filter(campo => ['string', 'boolean', 'number'].includes(typeof modulo[campo]) || modulo[campo] === null)
          .map(campo => [campo, modulo[campo]]),
      ));
      resposta = { statusHttp: 200, body: { ok: true, status: 'catalogo', modulos } };
    } else if (evento !== 'catalogo' && 'inscricao_id' in normalizado && objeto(data) && data.ok === true
      && data.inscricao_id === normalizado.inscricao_id
      && (evento === 'validar' ? data.status === 'validado' : data.status === 'criado' || data.status === 'existente')) {
      const campos = ['status', 'validacao', 'duplicado', 'acao', 'lead_criado', 'op_criada', 'lead_id', 'oportunidade_id', 'funil_id', 'etapa_id', 'modulo_id', 'modulo_codigo', 'inscricao_id', 'inscrito_em', 'retroativa'];
      resposta = { statusHttp: 200, body: { ok: true, ...Object.fromEntries(
        campos.filter(campo => ['string', 'boolean', 'number'].includes(typeof data[campo]) || data[campo] === null)
          .map(campo => [campo, data[campo]]),
      ) } };
    } else resposta = erroRpc(null);
  } catch (erro) {
    resposta = erro instanceof ErroEntrada ? falha(erro.codigo, erro.message, erro.statusHttp) : erroRpc(erro);
  }
  try {
    await registrarLog?.({
      evento,
      resultado: resposta.body.ok === true ? resposta.body.status as LogModulosPraticos['resultado'] : 'erro',
      statusHttp: resposta.statusHttp,
      codigo: typeof resposta.body.erro === 'string' ? resposta.body.erro : null,
    });
  } catch {
    // Auditoria best-effort não transforma inscrição confirmada em falso erro.
  }
  return resposta;
}
